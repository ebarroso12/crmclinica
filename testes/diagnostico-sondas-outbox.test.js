'use strict';

// Comando 7 / achado A-1 da auditoria: o worker da automação (outbox,
// `bin/worker-outbox.js`) não tinha observabilidade nenhuma — nem heartbeat
// verificado, nem contagem de trabalho pendente vencido. `sondaDoWorker`
// (diagnostico-sondas.js) só cobre `lembretes_worker`; esta sonda cobre o
// componente separado `automacao_outbox_worker` que o worker da outbox já
// grava em `system_heartbeats` desde o Comando 3.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sondaDaOutbox } = require('../src/dominio/diagnostico-sondas');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('sem heartbeat nenhum registrado, a sonda diz inativo — não inventa "ativo"', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const sonda = sondaDaOutbox(repositorio);

  const resultado = await sonda();

  assert.equal(resultado.ativo, false);
  assert.equal(resultado.idade_ms, null);
});

test('com heartbeat recente, a sonda diz ativo e devolve o detalhe gravado pelo worker', async () => {
  // Sem simular relógio aqui de propósito: a sonda lê `Date.now()` de verdade
  // (é hora de parede que compara com o heartbeat gravado agora mesmo), então
  // a idade tem que ficar pertinho de zero, não exatamente zero.
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarBatimentoDoSistema('automacao_outbox_worker', {
    status: 'ok',
    detalhe: { worker: 'outbox-1', fila_pendente: 2 },
  });

  const sonda = sondaDaOutbox(repositorio);
  const resultado = await sonda();

  assert.equal(resultado.ativo, true);
  assert.equal(resultado.detalhe.worker, 'outbox-1');
  assert.ok(resultado.idade_ms >= 0 && resultado.idade_ms < 2000, `idade inesperada: ${resultado.idade_ms}`);
});

test('heartbeat velho (acima do limite) conta como inativo, mesmo tendo existido', async () => {
  const gravadoEm = new Date('2026-08-13T12:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => gravadoEm });
  await repositorio.registrarBatimentoDoSistema('automacao_outbox_worker', { status: 'ok' });

  // 10 minutos depois, bem acima do limite padrão de 3 minutos.
  const dezMinutosDepois = new Date(gravadoEm.getTime() + 10 * 60 * 1000);
  const sondaComRelogioAdiantado = sondaDaOutbox(repositorio);
  const originalNow = Date.now;
  Date.now = () => dezMinutosDepois.getTime();
  try {
    const resultado = await sondaComRelogioAdiantado();
    assert.equal(resultado.ativo, false);
    assert.ok(resultado.idade_ms >= 10 * 60 * 1000);
  } finally {
    Date.now = originalNow;
  }
});

test('trabalho pendente vencido (passou de disponivel_em há muito tempo) aparece contado', async () => {
  const inicio = new Date('2026-08-13T12:00:00.000Z');
  let instante = inicio;
  const repositorio = criarRepositorioEmMemoria({ agora: () => instante });

  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: 1, chaveIdempotencia: 'a:1' });

  // Dez minutos depois, sem ninguém ter reivindicado — passou do atraso padrão (5min).
  instante = new Date(inicio.getTime() + 10 * 60 * 1000);
  const originalNow = Date.now;
  Date.now = () => instante.getTime();
  try {
    const sonda = sondaDaOutbox(repositorio);
    const resultado = await sonda();
    assert.equal(resultado.vencidos, 1);
    assert.equal(resultado.fila.pendente, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('trabalho pendente recente (dentro do prazo) não conta como vencido', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: 1, chaveIdempotencia: 'a:1' });

  const sonda = sondaDaOutbox(repositorio);
  const resultado = await sonda();

  assert.equal(resultado.vencidos, 0);
});

test('fila da outbox some junto (morto/incerto) — para o diagnóstico decidir a gravidade', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: 1, chaveIdempotencia: 'a:1' });
  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({ agora: new Date().toISOString(), limite: 1 });
  await repositorio.concluirTrabalhoDeOutbox(trabalho.id, { status: 'morto', tentativas: 5 });

  const sonda = sondaDaOutbox(repositorio);
  const resultado = await sonda();

  assert.equal(resultado.fila.morto, 1);
});
