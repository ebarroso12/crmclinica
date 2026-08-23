#!/usr/bin/env node
'use strict';

// Diagnóstico de emergência, somente leitura: estado atual da Serena.
// Não escreve nada no banco.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../../src/config');
const { criarPool } = require('../../src/dados/pool');

async function main() {
  const config = carregarConfiguracao(process.env);
  const pool = criarPool(config.banco);
  if (!pool) {
    console.error('CRMCLINICA_DATABASE_URL não configurado.');
    process.exit(1);
  }

  try {
    const colunas = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'serena_configuracao' ORDER BY column_name;`
    );
    console.log('--- Colunas de serena_configuracao ---');
    for (const linha of colunas.rows) console.log(' -', linha.column_name);

    const temAgenda = colunas.rows.some((l) => l.column_name === 'agenda');
    const temPausadaAte = colunas.rows.some((l) => l.column_name === 'pausada_ate');
    const temLigadaAte = colunas.rows.some((l) => l.column_name === 'ligada_ate');
    console.log('\nMigração 013 aplicada (agenda/pausada_ate/ligada_ate):',
      temAgenda && temPausadaAte && temLigadaAte);

    const estado = await pool.query(
      `SELECT ativa, pausada_ate, ligada_ate, agenda, alterado_em FROM serena_configuracao WHERE id = 1;`
    );
    console.log('\n--- Estado atual (serena_configuracao id=1) ---');
    console.log(JSON.stringify(estado.rows[0] ?? null, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((erro) => {
  console.error('Erro no diagnóstico:', erro.message);
  process.exit(1);
});
