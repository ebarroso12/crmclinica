'use strict';

const { Pool, types } = require('pg');

// Conexão com o PostgreSQL do crmclinica. Um pool por processo.
// A connection string vem só do ambiente e nunca é impressa em log nem devolvida por rota.

// O driver devolve `bigint` (OID 20) como **string**, para não perder precisão
// acima de 2^53. Isso faria `id` ser string no PostgreSQL e number em memória —
// divergência silenciosa que só apareceria numa comparação estrita em produção.
// Identificadores de um CRM clínico não chegam perto de 9 quatrilhões, então
// converter aqui é seguro e mantém as duas implementações idênticas.
types.setTypeParser(types.builtins.INT8, (valor) => (valor === null ? null : Number(valor)));

let poolCompartilhado = null;

// Papel que a conexão assume ao nascer.
//
// As políticas do banco decidem por `request.jwt.claims ->> 'app_role'`. Uma
// conexão que não declara nada é lida como `deny` — e `deny` não escreve em
// tabela nenhuma. Isso não é hipótese: com a conexão muda, todo INSERT desta
// aplicação era recusado pelo RLS.
//
// A aplicação **é** o backend: é ela que recebe webhook, registra tentativa de
// login e roda o worker de lembretes, tudo isso sem nenhum usuário logado por
// trás. Declarar `backend` no startup da conexão é dizer a verdade sobre quem
// está falando.
//
// Quando existe um usuário identificado, `comUsuario` sobrescreve isto com
// `SET LOCAL` dentro da transação, e o papel real (admin, gestor, atendente)
// passa a valer — restringindo, nunca ampliando. Sendo local, o valor morre com
// a transação e a conexão volta ao pool como backend de novo.
//
// Sem espaços no JSON de propósito: `options` é separado por espaço no protocolo
// de startup do PostgreSQL, e um espaço aqui viraria dois parâmetros.
const CLAIMS_DE_BACKEND = '{"app_role":"backend"}';

function criarPool(configuracaoDoBanco) {
  if (!configuracaoDoBanco.configurado) return null;

  return new Pool({
    connectionString: configuracaoDoBanco.url,
    options: `-c request.jwt.claims=${CLAIMS_DE_BACKEND}`,
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

module.exports = { criarPool, obterPool, encerrarPool, CLAIMS_DE_BACKEND };
