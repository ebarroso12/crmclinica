#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);

async function main() {
  const client = new Client({ connectionString: process.env.CRMCLINICA_DATABASE_URL });
  await client.connect();
  await client.query(`SET request.jwt.claims = '{"app_role":"backend"}'`);
  try {
    const r = await client.query(`
      SELECT componente, status, detalhe, updated_at,
             EXTRACT(EPOCH FROM (now() - updated_at)) AS idade_s
      FROM system_heartbeats
      WHERE componente IN ('automacao_outbox_worker', 'openclaw', 'evolution', 'serena', 'inbox')
      ORDER BY componente
    `);
    console.table(r.rows.map(row => ({
      componente: row.componente, status: row.status,
      idade_s: Number(row.idade_s).toFixed(1),
      detalhe: JSON.stringify(row.detalhe),
    })));
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
