'use strict';

// Extração complementar, somente leitura: TODAS as policies crm008_* e
// restrict_* com as colunas necessárias para regerar CREATE POLICY exato
// (inclui `permissive`, que a primeira extração não pegou).

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

async function main() {
  const url = process.env.CRMCLINICA_DATABASE_URL;
  if (!url) {
    console.error('CRMCLINICA_DATABASE_URL não está definida.');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });

  try {
    const policies = await pool.query(`
      SELECT schemaname, tablename, policyname, permissive, cmd, roles::text, qual, with_check
      FROM pg_policies
      WHERE policyname LIKE 'crm008%' OR policyname LIKE 'restrict_%'
      ORDER BY tablename, policyname
    `);

    // RLS habilitado por tabela — necessário para o script de reconstrução
    // saber se precisa de ALTER TABLE ... ENABLE ROW LEVEL SECURITY também.
    const rls = await pool.query(`
      SELECT c.relname AS tablename, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          SELECT DISTINCT tablename FROM pg_policies
          WHERE policyname LIKE 'crm008%' OR policyname LIKE 'restrict_%'
        )
      ORDER BY c.relname
    `);

    console.log(JSON.stringify({
      consultado_em: new Date().toISOString(),
      total_policies: policies.rows.length,
      policies: policies.rows,
      rls_por_tabela: rls.rows,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((erro) => {
  console.error('extração falhou: ' + erro.message);
  process.exit(1);
});
