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
  // Faltavam estas duas — exatamente as que db/018 referencia sem
  // `CREATE FUNCTION` em lugar nenhum do git. Sem elas na lista, mesmo
  // reexecutando esta extração contra produção, a lacuna nunca aparecia.
  'is_admin_master', 'is_colaborador',
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
    // Definição completa (pg_get_functiondef já embute SECURITY
    // DEFINER/INVOKER e SET search_path, quando configurados) + owner +
    // volatilidade — o que a pendência 1 pede para comparar assinatura,
    // corpo, owner e security definer/invoker de cada função.
    const funcoes = await pool.query(`
      SELECT
        p.proname,
        pg_get_function_identity_arguments(p.oid) AS assinatura,
        pg_get_functiondef(p.oid) AS definicao,
        r.rolname AS owner,
        p.prosecdef AS security_definer,
        p.provolatile,
        p.proconfig AS config_local
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname = ANY($1)
      ORDER BY p.proname
    `, [FUNCOES_DA_008]);

    // Grants de EXECUTE por role — separado da definição porque
    // pg_get_functiondef não carrega privilégios.
    const grants = await pool.query(`
      SELECT routine_name, grantee, privilege_type
      FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = ANY($1)
      ORDER BY routine_name, grantee
    `, [FUNCOES_DA_008]).catch((erro) => ({ rows: [{ aviso: erro.message }] }));

    // Policies com prefixo conhecido (crm008%) — mantido pela extração original.
    const policiesPorPrefixo = await pool.query(`
      SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check
      FROM pg_policies
      WHERE policyname LIKE 'crm008%'
      ORDER BY tablename, policyname
    `);

    // Busca ADICIONAL: qualquer policy, em qualquer nome, cujo corpo (qual ou
    // with_check) MENCIONE uma das seis funções — pega dependência real,
    // mesmo que o nome da policy não siga o prefixo crm008 (é exatamente o
    // caso de is_admin_master/is_colaborador: nunca tiveram CREATE FUNCTION
    // no git, então não há garantia de que as policies que as usam sigam a
    // mesma convenção de nome das que 008/009 documentam).
    const padraoOr = FUNCOES_DA_008.map((f) => `%${f}%`);
    const policiasPorUso = await pool.query(`
      SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check
      FROM pg_policies
      WHERE qual ILIKE ANY($1) OR with_check ILIKE ANY($1)
      ORDER BY tablename, policyname
    `, [padraoOr]).catch((erro) => ({ rows: [{ aviso: erro.message }] }));

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
      grants_execute: grants.rows,
      policies_crm008_por_prefixo: policiesPorPrefixo.rows,
      policies_que_usam_as_funcoes: policiasPorUso.rows,
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
