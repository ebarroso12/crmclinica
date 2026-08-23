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
      "SELECT proname, proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname = ANY($1) ORDER BY proname",
      [['current_app_role','current_usuario_id','audit_user_changes','is_backend','is_gestor_or_admin','is_atendente','is_admin_master','is_colaborador']],
    );
    console.log(JSON.stringify(r.rows, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
