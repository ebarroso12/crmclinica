#!/usr/bin/env node
'use strict';

// Extração SOMENTE LEITURA do que as migrations 008/009 (aplicadas fora do
// Git) deixaram no banco: definições reais de funções, policies crm008_* e
// privilégios de storage. É a ferramenta do plano de reconstrução
// (docs/PLANO-RECONSTRUCAO-008-009.md) — o SQL versionado nasce DESTA saída,
// nunca de memória ou suposição.
//
//   node ferramentas/extrair-definicoes-008.js > extracao.json
//
// Nenhuma escrita: só pg_catalog e information_schema.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const FUNCOES_DA_008 = [
  'current_app_role', 'current_usuario_id', 'audit_user_changes',
  'is_backend', 'is_gestor_or_admin', 'is_atendente',
];

async function main() {
  const url = process.env.CRMCLINICA_DATABASE_URL;
  if (!url) {
    console.error('CRMCLINICA_DATABASE_URL não está definida.');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });

  try {
    const funcoes = await pool.query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definicao
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1)
      ORDER BY p.proname
    `, [FUNCOES_DA_008]);

    const policies = await pool.query(`
      SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check
      FROM pg_policies
      WHERE policyname LIKE 'crm008%'
      ORDER BY tablename, policyname
    `);

    // Evidência da 009: nenhum privilégio de anon/authenticated em storage.
    const storage = await pool.query(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'storage' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      ORDER BY table_name, grantee, privilege_type
    `).catch((erro) => ({ rows: [{ aviso: erro.message }] }));

    console.log(JSON.stringify({
      consultado_em: new Date().toISOString(),
      funcoes: funcoes.rows,
      policies_crm008: policies.rows,
      storage_grants_anon_auth: storage.rows,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((erro) => {
    console.error(`extração falhou: ${erro.message}`);
    process.exit(1);
  });
}

module.exports = { FUNCOES_DA_008 };
