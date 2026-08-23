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
      SELECT id, inicio, fim, status, google_evento_id, google_calendar_id,
             sync_status, last_synced_at, last_sync_error, origem_alteracao
      FROM agendamentos
      ORDER BY inicio DESC
      LIMIT 25
    `);
    console.table(r.rows.map(x => ({
      id: x.id,
      inicio: x.inicio,
      status: x.status,
      google_evento_id: x.google_evento_id ? String(x.google_evento_id).slice(0,10)+'…' : null,
      sync_status: x.sync_status,
      last_synced_at: x.last_synced_at,
      erro: x.last_sync_error,
      origem: x.origem_alteracao,
    })));

    const semGoogle = await client.query(`SELECT count(*)::int AS n FROM agendamentos WHERE google_evento_id IS NULL`);
    console.log('Agendamentos SEM google_evento_id (nunca sincronizados):', semGoogle.rows[0].n);

    const comErro = await client.query(`SELECT count(*)::int AS n FROM agendamentos WHERE last_sync_error IS NOT NULL`);
    console.log('Agendamentos com last_sync_error preenchido:', comErro.rows[0].n);

    const statusCount = await client.query(`SELECT sync_status, count(*)::int AS n FROM agendamentos GROUP BY sync_status`);
    console.log('Por sync_status:');
    console.table(statusCount.rows);
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
