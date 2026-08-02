'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Carrega o `.env` antes de qualquer leitura de configuração.
// Sem isto, `.env.exemplo` seria uma instrução vazia: copiar o arquivo não teria
// efeito nenhum. Variável já presente no ambiente vence a do arquivo — é o que
// permite sobrescrever um valor sem editar o arquivo.
const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(CAMINHO_ENV);
  } catch (erro) {
    console.error(`[crmclinica] não foi possível ler o .env: ${erro.message}`);
  }
}

const { carregarConfiguracao, validarConfiguracao, descreverConfiguracao } = require('./config');
const { criarAplicacao, criarServidor } = require('./servidor/http');
const { criarRepositorioEmMemoria } = require('./dados/repositorio-memoria');
const { semearMaster } = require('./seguranca/semear-master');
const { criarLimitador } = require('./seguranca/limite');
const { exigirConexaoSegura } = require('./dados/conferir-conexao');

const configuracao = carregarConfiguracao();

/**
 * Escolhe onde o inbox guarda os dados.
 * Com banco configurado, PostgreSQL; sem ele, memória — bom para desenvolver,
 * mas nada sobrevive ao reinício, e `/api/resumo` deixa isso visível.
 */
function montarRepositorio() {
  if (!configuracao.banco.configurado) {
    console.warn('[crmclinica] sem CRMCLINICA_DATABASE_URL: o inbox roda em memória e não persiste.');
    return { repositorio: criarRepositorioEmMemoria(), encerrar: async () => {} };
  }

  // O driver só é carregado quando há banco: quem roda sem Postgres não paga por ele.
  const { criarPool, encerrarPool } = require('./dados/pool');
  const { criarRepositorio } = require('./dados/repositorio');

  const pool = criarPool(configuracao.banco);
  return { repositorio: criarRepositorio(pool), pool, encerrar: encerrarPool };
}

function iniciar() {
  const problemas = validarConfiguracao(configuracao);
  if (problemas.length > 0) {
    // Em produção, configuração insegura impede a subida; fora dela, apenas avisa.
    const prefixo = configuracao.producao ? 'Configuração inválida' : 'Aviso de configuração';
    for (const problema of problemas) console.error(`[crmclinica] ${prefixo}: ${problema}`);
    if (configuracao.producao) process.exit(1);
  }

  const { repositorio, pool, encerrar: encerrarBanco } = montarRepositorio();

  // Com quem a aplicação conectou decide se o RLS existe para ela. Conectar como
  // dono das tabelas não gera erro nenhum — tudo funciona igual, e as políticas
  // simplesmente não rodam. Em produção isso não pode passar em silêncio.
  if (pool) {
    exigirConexaoSegura(pool, { producao: configuracao.producao }).catch((erro) => {
      console.error(`[crmclinica] ${erro.message}`);
      console.error('[crmclinica] Aponte CRMCLINICA_DATABASE_URL para crmclinica_app '
        + '(veja .env.exemplo e docs/SEGURANCA.md).');
      process.exit(1);
    });
  }

  // Sem banco, o admin master é semeado a cada subida — do contrário não haveria
  // como entrar em desenvolvimento. Com banco, use `npm run criar-admin`, para
  // que a criação seja um ato deliberado e não um efeito de reiniciar o processo.
  if (!configuracao.banco.configurado && configuracao.master.email) {
    semearMaster(repositorio, configuracao.master)
      .then((resultado) => {
        if (resultado.criado) {
          console.log(`[crmclinica] admin master em memória: ${configuracao.master.email}`);
        } else if (resultado.motivo) {
          console.warn(`[crmclinica] admin master não criado: ${resultado.motivo}`);
        }
      })
      .catch((erro) => console.error('[crmclinica] falha ao semear o admin master:', erro.message));
  }

  const limitador = criarLimitador({ repositorio });
  const servidor = criarServidor({ configuracao, repositorio, limitador });

  // Tentativa fora de qualquer janela não limita nada, e guardá-la para sempre
  // transformaria a tabela num registro de quem tentou entrar e quando.
  const limpezaPeriodica = setInterval(() => {
    limitador.limpar().catch((erro) => {
      console.error('[crmclinica] falha ao limpar tentativas antigas:', erro.message);
    });
  }, 60 * 60 * 1000);
  // Não segura o processo aberto por causa do temporizador.
  limpezaPeriodica.unref();

  servidor.listen(configuracao.porta, configuracao.endereco, () => {
    console.log(`[crmclinica] ouvindo em http://${configuracao.endereco}:${configuracao.porta}`);
    console.log('[crmclinica] plataforma:', JSON.stringify(descreverConfiguracao(configuracao)));
  });

  const encerrar = () => {
    clearInterval(limpezaPeriodica);
    servidor.close(async () => {
      await encerrarBanco();
      process.exit(0);
    });
  };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  return servidor;
}

if (require.main === module) iniciar();

module.exports = { iniciar, criarAplicacao, criarServidor, configuracao };
