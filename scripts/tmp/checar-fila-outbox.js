#!/usr/bin/env node
'use strict';
// Só leitura: quantas mensagens estão esperando na fila nova, sem worker ainda.

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

async function main() {
  const client = new Client({ connectionString: process.env.CRMCLINICA_DATABASE_URL });
  await client.connect();
  await client.query(`SET request.jwt.claims = '{"app_role":"backend"}'`);
  try {
    const r = await client.query(`
      SELECT status, count(*)::int AS total, min(criado_em) AS mais_antiga, max(criado_em) AS mais_recente
      FROM automacao_outbox GROUP BY status ORDER BY status
    `);
    if (r.rows.length === 0) {
      console.log('Fila vazia — nenhum trabalho enfileirado ainda.');
    } else {
      console.table(r.rows);
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
