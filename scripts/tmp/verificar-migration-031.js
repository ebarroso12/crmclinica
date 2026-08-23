#!/usr/bin/env node
'use strict';

// Só leitura: confere se a migration 031 (aplicada manualmente via SQL
// Editor) deixou o banco exatamente como o SQL promete.

const fs = require('node:fs');
const path = require('node:path');
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

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const tabela = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'automacao_outbox'
    `);
    console.log('Tabela presente?', tabela.rows.length === 1);

    const colunas = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='automacao_outbox'
      ORDER BY ordinal_position
    `);
    console.log('Colunas (' + colunas.rows.length + '):', colunas.rows.map((r) => r.column_name).join(', '));

    const rls = await client.query(`
      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automacao_outbox'::regclass
    `);
    console.log('RLS habilitado?', rls.rows[0].relrowsecurity);

    const politicas = await client.query(`
      SELECT policyname, roles, cmd FROM pg_policies
      WHERE schemaname='public' AND tablename='automacao_outbox'
    `);
    console.log('Políticas:', politicas.rows.map((r) => `${r.policyname} roles=${r.roles} cmd=${r.cmd}`).join(' | '));

    const grants = await client.query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='automacao_outbox'
      ORDER BY grantee, privilege_type
    `);
    console.log('Grants na tabela:');
    for (const g of grants.rows) console.log(' -', g.grantee, g.privilege_type);

    const grantsSeq = await client.query(`
      SELECT grantee, privilege_type FROM information_schema.role_usage_grants
      WHERE object_schema='public' AND object_name='automacao_outbox_id_seq'
      ORDER BY grantee, privilege_type
    `).catch(() => ({ rows: [] }));
    console.log('Grants na sequence (informativo, achado B-1 conhecido):');
    for (const g of grantsSeq.rows) console.log(' -', g.grantee, g.privilege_type);

    const indices = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='automacao_outbox'
    `);
    console.log('Índices:', indices.rows.map((r) => r.indexname).join(', '));

    const trigger = await client.query(`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.automacao_outbox'::regclass AND NOT tgisinternal
    `);
    console.log('Triggers:', trigger.rows.map((r) => r.tgname).join(', '));

    const contagem = await client.query('SELECT count(*)::int AS total FROM automacao_outbox');
    console.log('Linhas na tabela agora:', contagem.rows[0].total, '(esperado: 0, tabela nova)');
  } finally {
    await client.end();
  }
}

main().catch((erro) => {
  console.error('ERRO ao verificar:', erro.message);
  process.exit(1);
});
