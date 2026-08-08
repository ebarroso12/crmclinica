#!/usr/bin/env node
'use strict';

// Worker da sincronia com o Google Calendar.
//
//   npm run google:worker
//   npm run google:worker -- --uma-vez          (um ciclo e sai)
//   npm run google:worker -- --intervalo=30     (segundos entre ciclos)
//   npm run google:worker -- --lote=20
//   npm run google:worker -- --reconciliar-ciclos=60
//
// Um ciclo faz três coisas, nesta ordem:
//   1. processa o outbox (CRM -> Google): criações, remarcações e cancelamentos
//      que a agenda enfileirou na mesma transação do banco;
//   2. roda o incremental (Google -> CRM): lê o que mudou no calendário desde
//      o último syncToken, detecta edições e cancelamentos feitos por fora;
//   3. a cada N ciclos, reconcilia: relê no Google os eventos vinculados e
//      confere se os dois lados contam a mesma história.
//
// Pode rodar em duas ou mais cópias ao mesmo tempo: a reivindicação do outbox
// usa `FOR UPDATE SKIP LOCKED`, e as criações são idempotentes pelo id
// determinístico do evento — duas cópias dividem o trabalho, não o duplicam.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { criarCalendarioGoogle } = require('../src/integracoes/google-calendario');
const { criarOutboxGoogle } = require('../src/dominio/google-outbox');
const { criarSincroniaGoogle } = require('../src/dominio/google-sincronia');

function lerArgumento(nome, padrao = null) {
  const prefixo = `--${nome}=`;
  const encontrado = process.argv.find((argumento) => argumento.startsWith(prefixo));
  return encontrado ? encontrado.slice(prefixo.length) : padrao;
}

const temFlag = (nome) => process.argv.includes(`--${nome}`);

async function main() {
  const configuracao = carregarConfiguracao();

  if (!configuracao.banco.configurado) {
    console.error('[google] CRMCLINICA_DATABASE_URL não está definida.');
    console.error('[google] O outbox é persistente por definição: sem banco não há worker.');
    process.exit(1);
  }

  const calendario = criarCalendarioGoogle(configuracao.googleAgenda);
  if (!calendario.configurada) {
    console.error('[google] Google Agenda não configurado (GOOGLE_AGENDA_CREDENCIAL/USUARIO).');
    console.error('[google] Sem credencial não há o que sincronizar — o CRM segue funcionando.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');
  const { criarRepositorioGoogle } = require('../src/dados/repositorio-google');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);
  const repositorioGoogle = criarRepositorioGoogle(pool);

  const clinica = configuracao.lembretes?.clinica ?? null;
  const outbox = criarOutboxGoogle({ repositorio, repositorioGoogle, calendario, clinica });
  const sincronia = criarSincroniaGoogle({ repositorio, repositorioGoogle, calendario, outbox });

  const intervaloMs = Number(lerArgumento('intervalo', '30')) * 1000;
  const lote = Number(lerArgumento('lote', '20'));
  const reconciliarACada = Number(lerArgumento('reconciliar-ciclos', '60'));
  const umaVez = temFlag('uma-vez');

  let encerrando = false;
  process.on('SIGINT', () => { encerrando = true; });
  process.on('SIGTERM', () => { encerrando = true; });

  let ciclo = 0;
  do {
    ciclo += 1;
    try {
      const saida = await outbox.processarLote({ lote });
      if (saida.processados > 0) {
        console.log(`[google] outbox: ${saida.processados} item(ns) processado(s)`);
      }

      const leitura = await sincronia.sincronizar({});
      if (leitura.sincronizado && (leitura.eventos > 0 || leitura.fullSync)) {
        console.log(`[google] incremental: ${leitura.eventos} evento(s), `
          + `${leitura.conflitos} conflito(s)${leitura.fullSync ? ' (full sync)' : ''}`);
      }

      if (ciclo % reconciliarACada === 0) {
        const conferencia = await sincronia.reconciliar({});
        console.log(`[google] reconciliação: ${conferencia.verificados} verificado(s), `
          + `${conferencia.iguais} igual(is), ${conferencia.conflitos} conflito(s)`);
      }
    } catch (erro) {
      // Um ciclo ruim não derruba o worker: o próximo tenta de novo, e os
      // itens falhos do outbox têm backoff próprio.
      console.error(`[google] ciclo falhou: ${erro?.message ?? erro}`);
    }

    if (!umaVez && !encerrando) {
      await new Promise((resolver) => setTimeout(resolver, intervaloMs));
    }
  } while (!umaVez && !encerrando);

  await encerrarPool();
}

main().catch((erro) => {
  console.error(`[google] erro fatal: ${erro?.stack ?? erro}`);
  process.exit(1);
});
