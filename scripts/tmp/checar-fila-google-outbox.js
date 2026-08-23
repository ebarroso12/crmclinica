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
    const cols = await client.query(`
      SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%google%outbox%'
    `);
    console.log('Tabelas de outbox do google:', cols.rows.map(r=>r.table_name).join(', '));
    for (const t of cols.rows) {
      const r = await client.query(`SELECT * FROM ${t.table_name} ORDER BY id DESC LIMIT 15`);
      console.log('---', t.table_name, '(', r.rows.length, 'linhas mostradas) ---');
      console.table(r.rows.map(row => ({
        id: row.id, agendamento_id: row.agendamento_id, operacao: row.operacao,
        versao: row.versao, status: row.status, tentativas: row.tentativas,
        disponivel_em: row.disponivel_em, ultimo_erro: row.ultimo_erro,
      })));
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
