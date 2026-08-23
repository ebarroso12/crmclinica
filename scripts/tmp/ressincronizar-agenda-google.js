#!/usr/bin/env node
'use strict';
// Reenfileira, usando a logica real do app (registrarMudanca), todo
// agendamento com status 'agendado' -- agora que GOOGLE_AGENDA_CALENDARIO
// aponta pra agenda pessoal correta, os que estavam 'ok' contra o
// calendario errado (da conta de servico) e os que nunca foram
// enfileirados vao ser recriados no calendario certo.

const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);

const { carregarConfiguracao } = require('../../src/config');
const { criarCalendarioGoogle } = require('../../src/integracoes/google-calendario');
const { criarOutboxGoogle } = require('../../src/dominio/google-outbox');
const { criarPool, encerrarPool } = require('../../src/dados/pool');
const { criarRepositorio } = require('../../src/dados/repositorio');
const { criarRepositorioGoogle } = require('../../src/dados/repositorio-google');

async function main() {
  const configuracao = carregarConfiguracao(process.env);
  console.log('calendario alvo:', configuracao.googleAgenda.calendario);

  const calendario = criarCalendarioGoogle(configuracao.googleAgenda);
  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);
  const repositorioGoogle = criarRepositorioGoogle(pool);
  const outbox = criarOutboxGoogle({ repositorio, repositorioGoogle, calendario });

  try {
    const { rows } = await pool.query(`
      SELECT id FROM agendamentos WHERE status = 'agendado' ORDER BY id
    `);
    console.log('Agendamentos ativos (status=agendado) a reenfileirar:', rows.length);

    for (const { id } of rows) {
      const item = await outbox.registrarMudanca(id, 'criar');
      console.log(' - agendamento', id, '-> item de outbox', item?.id ?? '(nulo)');
    }

    console.log('\nEnfileirado. Processando imediatamente (nao esperar o proximo ciclo do worker)...');
    const resultado = await outbox.processarLote({ lote: 30 });
    console.log(JSON.stringify(resultado, null, 2));
  } finally {
    await encerrarPool();
  }
}

main().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
