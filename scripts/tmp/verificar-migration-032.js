#!/usr/bin/env node
'use strict';

// Só leitura: confere se a migration 032 (aplicada manualmente via SQL
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
  // Mesma claim que src/dados/pool.js usa em toda conexão de backend — sem
  // isso, políticas de RLS que leem request.jwt.claims falham (não é bug da
  // migration, é este script não estar dentro do pool normal da aplicação).
  await client.query(`SET request.jwt.claims = '{"app_role":"backend"}'`);

  try {
    const colunas = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='mensagens'
        AND column_name IN ('entrega_falhou', 'entrega_falhou_motivo')
      ORDER BY column_name
    `);
    console.log('Colunas novas encontradas:', colunas.rows.length, 'de 2 esperadas');
    for (const c of colunas.rows) {
      console.log(' -', c.column_name, c.data_type, 'nullable=' + c.is_nullable, 'default=' + c.column_default);
    }

    const contagem = await client.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE entrega_falhou = true)::int AS marcadas_true,
        count(*) FILTER (WHERE entrega_falhou = false)::int AS marcadas_false,
        count(*) FILTER (WHERE entrega_falhou IS NULL)::int AS nulas
      FROM mensagens
    `);
    console.log('Mensagens existentes:', contagem.rows[0]);
    console.log('(esperado: marcadas_true=0, nulas=0 — toda mensagem antiga nasce como "entregue")');

    // RLS/grants não deveriam ter mudado — mensagens já tinha os dois antes da 032.
    const rls = await client.query(`
      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mensagens'::regclass
    `);
    console.log('RLS de mensagens continua habilitado?', rls.rows[0].relrowsecurity);
  } finally {
    await client.end();
  }
}

main().catch((erro) => {
  console.error('ERRO ao verificar:', erro.message);
  process.exit(1);
});
