'use strict';

const { Pool } = require('pg');

// Conexão com o PostgreSQL do crmclinica. Um pool por processo.
// A connection string vem só do ambiente e nunca é impressa em log nem devolvida por rota.

let poolCompartilhado = null;

function criarPool(configuracaoDoBanco) {
  if (!configuracaoDoBanco.configurado) return null;

  return new Pool({
    connectionString: configuracaoDoBanco.url,
    max: configuracaoDoBanco.poolMax,
    connectionTimeoutMillis: configuracaoDoBanco.tempoLimiteMs,
    idleTimeoutMillis: 30000,
    // Supabase e a maioria dos provedores gerenciados exigem TLS, mas usam
    // certificado de cadeia própria — a verificação estrita quebraria a conexão.
    ssl: /supabase|amazonaws|render|neon/i.test(configuracaoDoBanco.url)
      ? { rejectUnauthorized: false }
      : undefined,
  });
}

function obterPool(configuracaoDoBanco) {
  if (!poolCompartilhado) poolCompartilhado = criarPool(configuracaoDoBanco);
  return poolCompartilhado;
}

async function encerrarPool() {
  if (!poolCompartilhado) return;
  const pool = poolCompartilhado;
  poolCompartilhado = null;
  await pool.end();
}

module.exports = { criarPool, obterPool, encerrarPool };
