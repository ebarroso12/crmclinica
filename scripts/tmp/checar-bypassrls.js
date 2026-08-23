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
    const r = await pool.query(
      "SELECT rolname, rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname IN ('crmclinica_app','postgres','authenticated','anon','service_role') ORDER BY rolname",
    );
    console.log(JSON.stringify(r.rows, null, 2));
    // current connection identity
    const quem = await pool.query('SELECT current_user, session_user');
    console.log('conectado como:', JSON.stringify(quem.rows[0]));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
