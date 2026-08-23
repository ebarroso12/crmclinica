'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}
async function main() {
  const url = process.env.CRMCLINICA_DATABASE_URL;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const nomes = ['can_access_agendamento', 'can_access_conversa', 'is_admin'];
    const r = await pool.query(
      "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS assinatura, pg_get_functiondef(p.oid) AS definicao, ro.rolname AS owner, p.prosecdef AS security_definer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles ro ON ro.oid=p.proowner WHERE n.nspname='public' AND p.proname = ANY($1) ORDER BY p.proname",
      [nomes],
    );
    console.log(JSON.stringify(r.rows, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
