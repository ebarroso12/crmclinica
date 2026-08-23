#!/usr/bin/env node
'use strict';

// Ação autorizada expressamente pelo usuário (Edson) em 2026-08-12:
// religar a Serena após confirmar que a grade horária (migração 013) está
// correta. Executa o UPDATE exato fornecido e lê o estado de volta para
// confirmar.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../../src/config');
const { criarPool } = require('../../src/dados/pool');

async function main() {
  const config = carregarConfiguracao(process.env);
  const pool = criarPool(config.banco);
  if (!pool) {
    console.error('CRMCLINICA_DATABASE_URL não configurado.');
    process.exit(1);
  }

  try {
    const antes = await pool.query(
      `SELECT ativa, pausada_ate, ligada_ate, alterado_em FROM serena_configuracao WHERE id = 1;`
    );
    console.log('--- Antes ---');
    console.log(JSON.stringify(antes.rows[0] ?? null, null, 2));

    const resultado = await pool.query(
      `UPDATE serena_configuracao
       SET ativa = true,
           motivo = 'Grade corrigida - atende fora do horario comercial (noite e fds)',
           alterado_em = now()
       WHERE id = 1
       RETURNING ativa, pausada_ate, ligada_ate, motivo, alterado_em;`
    );
    console.log('\n--- UPDATE aplicado (linhas afetadas: %d) ---', resultado.rowCount);
    console.log(JSON.stringify(resultado.rows[0] ?? null, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((erro) => {
  console.error('Erro ao ligar a Serena:', erro.message);
  process.exit(1);
});
