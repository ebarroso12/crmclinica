#!/usr/bin/env node
'use strict';

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

  const url = new URL(config.banco.url);
  console.log('--- Conexão ---');
  console.log('host:', url.hostname);
  console.log('port:', url.port);
  console.log('poolMax configurado no CRM:', config.banco.poolMax);
  console.log('timeoutMs configurado no CRM:', config.banco.tempoLimiteMs);

  try {
    const maxConn = await pool.query('SHOW max_connections;');
    console.log('\n--- max_connections do servidor ---');
    console.log(maxConn.rows[0]);

    const atuais = await pool.query(`
      SELECT count(*) AS total, state, application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state, application_name
      ORDER BY total DESC
      LIMIT 20;
    `);
    console.log('\n--- conexões atuais agrupadas por estado/app ---');
    console.table(atuais.rows);

    const totalGeral = await pool.query(`SELECT count(*) AS total FROM pg_stat_activity;`);
    console.log('\n--- total de conexões (todas as bases) ---');
    console.log(totalGeral.rows[0]);

    const lentas = await pool.query(`
      SELECT pid, state, now() - query_start AS duracao, left(query, 120) AS query
      FROM pg_stat_activity
      WHERE state != 'idle' AND now() - query_start > interval '2 seconds'
      ORDER BY duracao DESC
      LIMIT 10;
    `);
    console.log('\n--- queries rodando há mais de 2s agora ---');
    console.table(lentas.rows);
  } catch (erro) {
    console.error('Erro no diagnóstico:', erro.message);
  } finally {
    await pool.end();
  }
}

main().catch((erro) => {
  console.error('Erro:', erro.message);
  process.exit(1);
});
