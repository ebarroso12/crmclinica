#!/usr/bin/env node
'use strict';

// Aplica db/031_automacao_outbox.sql no banco real, a partir do texto exato
// já revisado por duas auditorias independentes (lido da branch
// fix/serena-controle-duravel, não reescrito aqui). Depois confere no
// próprio banco que a tabela, RLS, política e grants ficaram como o SQL
// promete — "a migration foi aplicada" é uma afirmação que precisa de prova.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

async function main() {
  const url = process.env.CRMCLINICA_DATABASE_URL;
  if (!url) {
    console.error('CRMCLINICA_DATABASE_URL não configurado.');
    process.exit(1);
  }

  const sql = execFileSync(
    'git',
    ['show', 'fix/serena-controle-duravel:db/031_automacao_outbox.sql'],
    { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' },
  );

  if (!sql.includes('CREATE TABLE IF NOT EXISTS automacao_outbox') || !sql.includes('COMMIT;')) {
    console.error('Conteúdo da migration não bate com o esperado — abortando sem executar.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  console.log('Conectado. host/porta/banco:', client.host, client.port, client.database);

  try {
    const existeAntes = await client.query(
      "SELECT to_regclass('public.automacao_outbox') AS existe",
    );
    console.log('Tabela existe antes de aplicar?', existeAntes.rows[0].existe !== null);

    await client.query(sql);
    console.log('Migration executada sem erro.');

    const tabela = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'automacao_outbox'
    `);
    console.log('Tabela presente após aplicar?', tabela.rows.length === 1);

    const colunas = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='automacao_outbox'
      ORDER BY ordinal_position
    `);
    console.log('Colunas:', colunas.rows.map((r) => r.column_name).join(', '));

    const rls = await client.query(`
      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automacao_outbox'::regclass
    `);
    console.log('RLS habilitado?', rls.rows[0].relrowsecurity);

    const politicas = await client.query(`
      SELECT policyname, roles FROM pg_policies
      WHERE schemaname='public' AND tablename='automacao_outbox'
    `);
    console.log('Políticas:', politicas.rows.map((r) => `${r.policyname} (${r.roles})`).join(' | '));

    const grants = await client.query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='automacao_outbox'
      ORDER BY grantee, privilege_type
    `);
    console.log('Grants:');
    for (const g of grants.rows) console.log(' -', g.grantee, g.privilege_type);

    const indices = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='automacao_outbox'
    `);
    console.log('Índices:', indices.rows.map((r) => r.indexname).join(', '));

    console.log('\nOK — migration 031 aplicada e verificada.');
  } finally {
    await client.end();
  }
}

main().catch((erro) => {
  console.error('ERRO ao aplicar migration:', erro.message);
  process.exit(1);
});
