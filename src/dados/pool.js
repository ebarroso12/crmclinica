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

  const pool = new Pool({
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

  return comPapelGarantido(pool);
}

/**
 * Garante que toda conexão entregue já declarou o papel `backend`.
 *
 * O `options` do startup só chega ao PostgreSQL numa conexão **direta**. Atrás
 * de um pooler — Supavisor no Supabase, PgBouncer — os parâmetros de startup do
 * cliente são descartados, e a conexão nasce sem papel: `current_app_role()`
 * devolve `deny` e o RLS filtra **tudo**.
 *
 * O sintoma disso é o pior possível, porque não parece um erro de conexão: o
 * login responde "credenciais inválidas". O `SELECT` em `usuarios` volta vazio,
 * a aplicação conclui que a conta não existe, e ninguém suspeita do banco —
 * que respondeu na hora, sem erro, com zero linhas.
 *
 * O `SET` é de sessão (não `LOCAL`): vale para a conexão inteira, e as
 * transações continuam livres para restringir o papel com `SET LOCAL` por
 * cima. Roda uma vez por conexão, antes de ela ser usada.
 */
function comPapelGarantido(pool) {
  const conectarOriginal = pool.connect.bind(pool);

  const declarar = async (client) => {
    if (client.__papelDeclarado) return client;
    await client.query(`SET request.jwt.claims = '${CLAIMS_DE_BACKEND}'`);
    // Marcado no client, não no pool: uma conexão reciclada não repete o SET,
    // e uma conexão nova nunca escapa dele.
    client.__papelDeclarado = true;
    return client;
  };

  // `pool.query` chama `pool.connect` com callback; o resto do código usa a
  // forma com promessa. As duas passam por aqui.
  pool.connect = function conectar(callback) {
    const pronto = conectarOriginal().then(declarar);
    if (!callback) return pronto;

    pronto.then(
      (client) => callback(null, client, (erro) => client.release(erro)),
      (erro) => callback(erro),
    );
    return undefined;
  };

  return pool;
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
