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
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agendamentos'
      ORDER BY ordinal_position
    `);
    console.log('Colunas de agendamentos:', cols.rows.map(r=>r.column_name).join(', '));

    const total = await client.query(`SELECT count(*)::int AS total FROM agendamentos`);
    console.log('Total de agendamentos no banco:', total.rows[0].total);

    const recentes = await client.query(`
      SELECT id, inicio, fim, status, google_event_id, atualizado_em, criado_em
      FROM agendamentos
      ORDER BY inicio DESC
      LIMIT 10
    `);
    console.table(recentes.rows);

    const proximos = await client.query(`
      SELECT id, inicio, fim, status, google_event_id
      FROM agendamentos
      WHERE inicio > now()
      ORDER BY inicio ASC
      LIMIT 10
    `);
    console.log('Próximos (inicio > agora):');
    console.table(proximos.rows);
  } catch (e) {
    console.error('erro:', e.message);
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
