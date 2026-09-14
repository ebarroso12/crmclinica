'use strict';

// Achado de 14/09/2026: aumentar o pool_size do Supabase no painel fez o
// Supavisor derrubar conexões ociosas existentes (FATAL 57P01 "terminating
// connection due to administrator command") — e três dos seis serviços do
// VPS caíram ao mesmo tempo, cada um com "Unhandled 'error' event" e stack
// trace dentro do driver `pg`. Causa: `pg.Pool` relança como exceção não
// tratada qualquer `'error'` emitido por um CLIENTE OCIOSO quando não há
// ouvinte — regra do EventEmitter do Node, documentada pelo próprio `pg`,
// e nenhum dos seis processos deste repositório tinha o ouvinte. Nenhum
// código de aplicação estava errado: só faltava alguém escutar o pool.
//
// Não depende de banco real — o que se prova aqui é que o ouvinte existe e
// engole o erro, não que a conexão em si funciona (isso já é coberto pela
// suíte contra Postgres real, ver npm run test:pg).

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarPool } = require('../src/dados/pool');

test('o pool tem ouvinte de erro — um cliente ocioso derrubado pelo servidor não derruba o processo', async () => {
  const pool = criarPool({
    configurado: true,
    // Nunca conecta de verdade neste teste — só a CONSTRUÇÃO do Pool e o
    // registro do ouvinte importam aqui.
    url: 'postgres://localhost:1/banco_que_nao_existe',
    poolMax: 2,
    tempoLimiteMs: 1000,
  });

  try {
    assert.equal(
      pool.listenerCount('error') > 0, true,
      'sem isto, o EventEmitter do Node relança "error" como exceção não tratada e mata o processo',
    );

    // A prova de verdade: emitir o mesmo evento que o driver `pg` emite
    // quando o servidor derruba uma conexão ociosa, e confirmar que isso
    // NÃO lança — é exatamente o "Unhandled 'error' event" do incidente.
    const erroSintetico = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    assert.doesNotThrow(() => pool.emit('error', erroSintetico));
  } finally {
    await pool.end();
  }
});

test('sem `criarPool` (função antiga hipotética), o mesmo pool SEM ouvinte lançaria — prova de que o teste acima não é vácuo', () => {
  // Constrói um Pool "cru", do jeito que criarPool fazia antes desta
  // correção — sem o `pool.on('error', ...)`. Garante que o teste acima
  // está provando algo real, e não passando por acaso (ex.: uma versão do
  // `pg` que já engole silenciosamente por conta própria).
  const { Pool } = require('pg');
  const poolCru = new Pool({
    connectionString: 'postgres://localhost:1/banco_que_nao_existe',
    max: 2,
  });
  try {
    assert.equal(poolCru.listenerCount('error'), 0, 'este pool não tem o ouvinte — é o estado de antes da correção');
    assert.throws(() => poolCru.emit('error', new Error('sintético')));
  } finally {
    poolCru.end();
  }
});
