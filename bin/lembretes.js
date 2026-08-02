#!/usr/bin/env node
'use strict';

// Consulta e operação da fila de lembretes, sem passar pela API.
//
//   npm run lembretes -- resumo
//   npm run lembretes -- fila [--estado=pendente] [--tipo=confirmacao_24h] [--limite=20]
//   npm run lembretes -- falhas
//   npm run lembretes -- sincronizar          (enfileira o que falta na agenda futura)
//   npm run lembretes -- reenfileirar --id=12
//   npm run lembretes -- optout --contato=3 [--motivo="pediu no telefone"]
//   npm run lembretes -- optin  --contato=3
//
// Existe porque a pergunta "por que fulano não recebeu o lembrete?" costuma
// chegar por telefone, e a resposta precisa sair em segundos — sem abrir a
// interface, sem token, e sem alguém escrever SQL na mão contra a produção.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarAdaptadorDeLembretes } = require('../src/integracoes/openclaw-lembretes');
const { mascararTelefone, FUSO } = require('../src/dominio/lembretes');

function lerArgumento(nome, padrao = null) {
  const prefixo = `--${nome}=`;
  const encontrado = process.argv.find((argumento) => argumento.startsWith(prefixo));
  return encontrado ? encontrado.slice(prefixo.length) : padrao;
}

const verde = (texto) => `\x1b[32m${texto}\x1b[0m`;
const vermelho = (texto) => `\x1b[31m${texto}\x1b[0m`;
const amarelo = (texto) => `\x1b[33m${texto}\x1b[0m`;

const COR_POR_ESTADO = {
  pendente: amarelo, processando: amarelo, enviado: verde, ignorado: (t) => t, falhou: vermelho,
};

/** Sempre em America/Sao_Paulo: a clínica raciocina no fuso dela, não no do servidor. */
function local(valor) {
  if (!valor) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(valor));
}

function imprimirLinha(lembrete) {
  const cor = COR_POR_ESTADO[lembrete.estado] ?? ((texto) => texto);
  const detalhe = lembrete.ignorado_motivo || lembrete.ultimo_erro || '';

  console.log(
    `  #${String(lembrete.id).padEnd(5)} ${cor(lembrete.estado.padEnd(11))}`
    + ` ${lembrete.tipo.padEnd(16)} envio ${local(lembrete.agendar_para).padEnd(16)}`
    + ` consulta ${local(lembrete.janela).padEnd(16)}`
    + ` ${(lembrete.contato?.nome ?? '—').slice(0, 18).padEnd(18)}`
    + ` ${mascararTelefone(lembrete.contato?.telefone)}`
    + ` ${lembrete.modo_entrega ? `[${lembrete.modo_entrega}]` : ''}`
    + (detalhe ? ` ${amarelo(detalhe)}` : ''),
  );
}

async function main() {
  const configuracao = carregarConfiguracao();
  const comando = process.argv[2] || 'resumo';

  if (!configuracao.banco.configurado) {
    console.error(vermelho('CRMCLINICA_DATABASE_URL não está definida.'));
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);
  const entrega = criarAdaptadorDeLembretes({
    ...configuracao.openclaw,
    modoEntrega: configuracao.lembretes.modoEntrega,
  });
  const lembretes = criarServicoDeLembretes({
    repositorio,
    entrega,
    clinica: configuracao.lembretes.clinica,
    maxTentativas: configuracao.lembretes.maxTentativas,
  });

  try {
    switch (comando) {
      case 'resumo': {
        const resumo = await lembretes.resumo();
        console.log('\nEntrega');
        console.log(`  modo: ${resumo.entrega.modo === 'real' ? verde('real') : amarelo('dry-run')}`);
        console.log(`  ${resumo.entrega.significado}`);
        if (resumo.entrega.motivo) console.log(`  motivo: ${resumo.entrega.motivo}`);

        console.log('\nFila por estado');
        for (const [estado, total] of Object.entries(resumo.fila.por_estado)) {
          console.log(`  ${estado.padEnd(12)} ${total}`);
        }
        console.log('\nFila por tipo');
        for (const [tipo, contagem] of Object.entries(resumo.fila.por_tipo)) {
          console.log(`  ${tipo.padEnd(18)} ${JSON.stringify(contagem)}`);
        }
        console.log(`\nEntregas registradas: ${JSON.stringify(resumo.fila.entregas)}\n`);
        break;
      }

      case 'fila': {
        const fila = await lembretes.listar({
          estado: lerArgumento('estado'),
          tipo: lerArgumento('tipo'),
          agendamentoId: lerArgumento('agendamento'),
          contatoId: lerArgumento('contato'),
          limite: Number(lerArgumento('limite', 30)),
        });
        console.log(`\n${fila.length} lembrete(s):\n`);
        fila.forEach(imprimirLinha);
        console.log('');
        break;
      }

      case 'falhas': {
        const fila = await lembretes.listar({ estado: 'falhou', limite: 100 });
        if (fila.length === 0) {
          console.log(verde('\nNenhum lembrete em falha.\n'));
          break;
        }
        console.log(vermelho(`\n${fila.length} lembrete(s) em falha:\n`));
        fila.forEach(imprimirLinha);
        console.log('');
        break;
      }

      case 'sincronizar': {
        const resultado = await lembretes.sincronizarAgenda({});
        console.log(`\n${JSON.stringify(resultado, null, 2)}\n`);
        break;
      }

      case 'reenfileirar': {
        const id = Number(lerArgumento('id'));
        if (!Number.isInteger(id) || id <= 0) throw new Error('informe --id=<número>');
        const lembrete = await lembretes.reenfileirar(id, {});
        console.log(verde(`\nlembrete #${id} de volta à fila:`));
        imprimirLinha(lembrete);
        console.log('');
        break;
      }

      case 'optout':
      case 'optin': {
        const contatoId = Number(lerArgumento('contato'));
        if (!Number.isInteger(contatoId) || contatoId <= 0) throw new Error('informe --contato=<número>');

        const { contato, cancelados } = await lembretes.definirOptOut(contatoId, {
          optout: comando === 'optout',
          motivo: lerArgumento('motivo'),
          origem: 'operacao',
        });

        console.log(`\ncontato #${contato.id} (${contato.nome ?? 'sem nome'}, `
          + `${mascararTelefone(contato.telefone)}): `
          + (contato.lembretes_optout ? vermelho('não recebe lembretes') : verde('recebe lembretes')));
        if (cancelados.length > 0) console.log(`${cancelados.length} lembrete(s) tirados da fila\n`);
        else console.log('');
        break;
      }

      case 'processar': {
        // Um lote manual, útil para conferir o comportamento sem subir o worker.
        const resultado = await lembretes.processarLote({
          limite: Number(lerArgumento('lote', 20)),
          worker: 'cli',
        });
        console.log(`\n${JSON.stringify(resultado, null, 2)}\n`);
        break;
      }

      default:
        console.error(`comando desconhecido: ${comando}`);
        console.error('use: resumo | fila | falhas | sincronizar | reenfileirar | optout | optin | processar');
        process.exitCode = 1;
    }
  } finally {
    await encerrarPool();
  }
}

main().catch((erro) => {
  console.error(vermelho(`\nfalha: ${erro.message}\n`));
  process.exit(1);
});
