'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { criarRepositorio } = require('../src/dados/repositorio');

// Trava do resumo (docs/RESUMOS.md, "Duas cópias do worker e pool mínimo"): a
// conexão fica idle in transaction durante toda a varredura. Pool e conexão são
// dublês — nada abre rede. A trava no PostgreSQL real está em
// testes/contrato-repositorio.test.js.

function montarPool() {
  const cliente = new EventEmitter();
  cliente.consultas = [];
  cliente.liberacoes = [];
  cliente.query = async (sql) => {
    cliente.consultas.push(sql);
    return /pg_try_advisory_xact_lock/.test(sql) ? { rows: [{ obtida: true }] } : { rows: [] };
  };
  cliente.release = (erro) => { cliente.liberacoes.push(erro); };
  const pool = { connect: async () => cliente, query: async () => ({ rows: [] }) };
  return { pool, cliente };
}

test('conexão da trava cai durante a varredura: o erro assíncrono não derruba o worker e a conexão é descartada', async () => {
  const { pool, cliente } = montarPool();
  const repositorio = criarRepositorio(pool);
  const queda = new Error('Connection terminated unexpectedly');

  const trava = await repositorio.executarComTravaDeResumo(async () => {
    // Sem ouvinte, o EventEmitter lança — no worker, vindo do socket, derruba o processo.
    cliente.emit('error', queda);
    return 'varreu';
  });

  assert.deepEqual(trava, { obtida: true, resultado: 'varreu' });
  assert.deepEqual(cliente.liberacoes, [queda], 'volta ao pool com o erro: descartada, e a trava vai junto');
});

test('conexão sã: a trava devolve a conexão sem erro e não acumula ouvinte a cada ciclo', async () => {
  const { pool, cliente } = montarPool();
  const repositorio = criarRepositorio(pool);

  for (let ciclo = 0; ciclo < 12; ciclo += 1) {
    assert.deepEqual(await repositorio.executarComTravaDeResumo(async () => ciclo), { obtida: true, resultado: ciclo });
  }

  assert.deepEqual(cliente.liberacoes, Array(12).fill(undefined));
  assert.equal(cliente.listenerCount('error'), 0);
  assert.deepEqual(cliente.consultas.slice(0, 3), ['BEGIN', 'SELECT pg_try_advisory_xact_lock($1::bigint) AS obtida', 'ROLLBACK']);
});
