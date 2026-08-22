'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarReleituraDeEventos } = require('../src/servidor/eventos-conversas');

// A releitura cross-processo é o que faz a aba do painel ver a resposta que a
// Serena mandou por OUTRO processo (o worker da outbox na VPS). Sem ela, o
// push por-processo só alcança quem está na mesma instância — e na Vercel a
// instância que recebe o SSE quase nunca é a que gravou a resposta.
//
// Estes testes cobrem as travas que mantêm a releitura segura contra ela
// mesma: tick único em voo, desligamento permanente quando a tabela não
// existe, e retentativa quando é só o banco congestionado.

function resFalso() {
  const escrito = [];
  return { escrito, write: (trecho) => { escrito.push(trecho); return true; } };
}

function cursorFalso(inicial = 0) {
  let cursor = inicial;
  return {
    cursorAtual: () => cursor,
    avancarCursor: (id) => { cursor = Math.max(cursor, id); },
    valor: () => cursor,
  };
}

function logFalso() {
  const erros = [];
  return { erros, error: (msg) => erros.push(msg) };
}

function repoCom(eventosPorChamada) {
  const chamadas = [];
  return {
    chamadas,
    async listarEventosDeConversasDesde(args) {
      chamadas.push(args);
      const proxima = eventosPorChamada[Math.min(chamadas.length, eventosPorChamada.length) - 1];
      if (proxima instanceof Error) throw proxima;
      return proxima ?? [];
    },
  };
}

test('intervalo 0 desliga a releitura (kill switch de emergência)', () => {
  const releitura = criarReleituraDeEventos({
    res: resFalso(), repositorio: repoCom([[]]),
    usuarioId: 1, papel: 'admin',
    cursorAtual: () => 0, avancarCursor: () => {},
    intervaloMs: 0,
  });
  assert.equal(releitura, null);
});

test('tick entrega os eventos novos como frames SSE e avança o cursor', async () => {
  const res = resFalso();
  const cursor = cursorFalso(10);
  const repo = repoCom([[{ id: 11, tipo: 'mensagem' }, { id: 12, tipo: 'mensagem' }]]);

  const releitura = criarReleituraDeEventos({
    res, repositorio: repo, usuarioId: 1, papel: 'admin',
    cursorAtual: cursor.cursorAtual, avancarCursor: cursor.avancarCursor,
  });

  await releitura.tick();

  assert.deepEqual(res.escrito, [
    'id: 11\ndata: {"id":11,"tipo":"mensagem"}\n\n',
    'id: 12\ndata: {"id":12,"tipo":"mensagem"}\n\n',
  ]);
  assert.equal(cursor.valor(), 12);
  // A leitura partiu de onde a assinatura estava — nunca do zero.
  assert.equal(repo.chamadas[0].cursor, 10);
});

test('um tick lento não empilha o próximo por cima', async () => {
  const res = resFalso();
  let soltar;
  const trava = new Promise((resolve) => { soltar = resolve; });
  let chamadas = 0;
  const repo = {
    async listarEventosDeConversasDesde() {
      chamadas += 1;
      if (chamadas === 1) await trava;
      return [];
    },
  };
  const releitura = criarReleituraDeEventos({
    res, repositorio: repo, usuarioId: 1, papel: 'admin',
    cursorAtual: () => 0, avancarCursor: () => {},
  });

  const primeiro = releitura.tick();
  const segundo = releitura.tick(); // tem de voltar sem tocar no banco
  await segundo;
  soltar();
  await primeiro;

  assert.equal(chamadas, 1, 'o segundo tick não pode chegar ao banco enquanto o primeiro lê');
});

test('tabela ausente (42P01) desliga a releitura para sempre, sem derrubar o SSE', async () => {
  const erro = new Error('relation "conversas_eventos" does not exist');
  erro.code = '42P01';
  const repo = repoCom([erro]);
  const log = logFalso();

  const releitura = criarReleituraDeEventos({
    res: resFalso(), repositorio: repo, usuarioId: 1, papel: 'admin',
    cursorAtual: () => 0, avancarCursor: () => {}, log,
  });

  await releitura.tick();
  await releitura.tick(); // já desligada: não pode nem tentar

  assert.equal(repo.chamadas.length, 1);
  assert.equal(log.erros.length, 1);
  assert.match(log.erros[0], /42P01/);
});

test('erro transitório só registra — o próximo tick tenta de novo', async () => {
  const repo = repoCom([new Error('banco congestionado'), [{ id: 5, tipo: 'mensagem' }]]);
  const res = resFalso();
  const cursor = cursorFalso(0);
  const log = logFalso();

  const releitura = criarReleituraDeEventos({
    res, repositorio: repo, usuarioId: 1, papel: 'admin',
    cursorAtual: cursor.cursorAtual, avancarCursor: cursor.avancarCursor, log,
  });

  await releitura.tick(); // falha, mas segue viva
  await releitura.tick(); // entrega o que chegou

  assert.equal(repo.chamadas.length, 2);
  assert.equal(log.erros.length, 1);
  assert.deepEqual(res.escrito, ['id: 5\ndata: {"id":5,"tipo":"mensagem"}\n\n']);
  assert.equal(cursor.valor(), 5);
});

test('parar() encerra: nenhum tick posterior toca o banco ou o SSE', async () => {
  const repo = repoCom([[{ id: 7, tipo: 'mensagem' }]]);
  const res = resFalso();

  const releitura = criarReleituraDeEventos({
    res, repositorio: repo, usuarioId: 1, papel: 'admin',
    cursorAtual: () => 0, avancarCursor: () => {},
  });

  releitura.parar();
  await releitura.tick();

  assert.equal(repo.chamadas.length, 0);
  assert.deepEqual(res.escrito, []);
});
