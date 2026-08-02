'use strict';

const { carregarConfiguracao, validarConfiguracao, descreverConfiguracao } = require('./config');
const { criarAplicacao, criarServidor } = require('./servidor/http');
const { criarRepositorioEmMemoria } = require('./dados/repositorio-memoria');

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
  return { repositorio: criarRepositorio(pool), encerrar: encerrarPool };
}

function iniciar() {
  const problemas = validarConfiguracao(configuracao);
  if (problemas.length > 0) {
    // Em produção, configuração insegura impede a subida; fora dela, apenas avisa.
    const prefixo = configuracao.producao ? 'Configuração inválida' : 'Aviso de configuração';
    for (const problema of problemas) console.error(`[crmclinica] ${prefixo}: ${problema}`);
    if (configuracao.producao) process.exit(1);
  }

  const { repositorio, encerrar: encerrarBanco } = montarRepositorio();
  const servidor = criarServidor({ configuracao, repositorio });

  servidor.listen(configuracao.porta, configuracao.endereco, () => {
    console.log(`[crmclinica] ouvindo em http://${configuracao.endereco}:${configuracao.porta}`);
    console.log('[crmclinica] plataforma:', JSON.stringify(descreverConfiguracao(configuracao)));
  });

  const encerrar = () => {
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
