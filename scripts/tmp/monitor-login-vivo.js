#!/usr/bin/env node
'use strict';
// Monitor ao vivo, só leitura: imprime cada tentativa de login da conta
// master assim que acontece (sucesso = sessao criada; falha = audit_log).
// Poll simples a cada 2s, sem alterar nada.
const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);

const { criarPool } = require('../../src/dados/pool');
const { carregarConfiguracao } = require('../../src/config');

async function main() {
  const configuracao = carregarConfiguracao(process.env);
  const pool = criarPool(configuracao.banco);
  await pool.query("SELECT set_config('request.jwt.claims', '{\"app_role\":\"backend\"}', true)");

  let desde = new Date().toISOString();
  console.log('Monitorando a partir de', desde, '(UTC) — tente logar agora.');

  for (;;) {
    const { rows: falhas } = await pool.query(
      `SELECT criado_em, acao, detalhe FROM audit_log
       WHERE entidade = 'usuario' AND (entidade_id = 1 OR entidade_id IS NULL)
         AND acao IN ('login_recusado','segundo_fator_recusado','login_bloqueado','senha_trocada','senha_redefinida')
         AND criado_em > $1
       ORDER BY criado_em ASC`,
      [desde],
    );
    for (const f of falhas) {
      console.log(`[${f.criado_em}] ${f.acao}`, f.detalhe ? JSON.stringify(f.detalhe) : '');
      desde = f.criado_em;
    }

    const { rows: sessoes } = await pool.query(
      `SELECT id, criado_em, ip FROM sessoes WHERE usuario_id = 1 AND criado_em > $1 ORDER BY criado_em ASC`,
      [desde],
    );
    for (const s of sessoes) {
      console.log(`[${s.criado_em}] LOGIN BEM-SUCEDIDO — sessao ${s.id} criada, ip=${s.ip}`);
      desde = s.criado_em;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
