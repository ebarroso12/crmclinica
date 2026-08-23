'use strict';
const fs = require('node:fs');
for (const linha of fs.readFileSync('C:/crmclinica/.env', 'utf8').split(/\r?\n/)) {
  const separador = linha.indexOf('=');
  if (separador > 0 && !linha.startsWith('#')) {
    const chave = linha.slice(0, separador).trim();
    if (!process.env[chave]) process.env[chave] = linha.slice(separador + 1).trim();
  }
}
const { Client } = require('pg');
async function main() {
  const cliente = new Client({ connectionString: process.env.CRMCLINICA_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await cliente.connect();
  await cliente.query('BEGIN');
  await cliente.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ app_role: 'backend' })]);

  const desligada = await cliente.query("select alterado_em, ativa from serena_configuracao where id = 1");
  console.log('INTERRUPTOR:', JSON.stringify(desligada.rows[0]));

  const mensagens = await cliente.query(`
    select m.criado_em, m.direcao, m.autor_tipo, left(m.conteudo, 45) as corpo, m.id_externo, m.conversa_id
    from mensagens m
    where m.criado_em > now() - interval '25 minutes'
    order by m.criado_em asc`);
  console.log(`\n=== mensagens dos últimos 25 min (${mensagens.rows.length}) ===`);
  for (const m of mensagens.rows) {
    console.log(`${m.criado_em.toISOString()} | c${m.conversa_id} | ${m.direcao}/${m.autor_tipo} | ext=${String(m.id_externo).slice(0, 40)} | ${m.corpo}`);
  }
  await cliente.query('ROLLBACK');
  await cliente.end();
}
main().catch((erro) => { console.error('ERRO:', erro.message); process.exit(1); });
