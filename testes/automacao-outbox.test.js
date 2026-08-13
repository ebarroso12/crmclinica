'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKOFF_BASE_MS, BACKOFF_TETO_MS, MAX_TENTATIVAS_PADRAO, LEASE_MS,
  proximaTentativa, esgotou, abandonado, decidirDesfecho,
} = require('../src/dominio/automacao-outbox');

test('proximaTentativa dobra a cada tentativa até o teto', () => {
  const agora = new Date('2026-08-13T10:00:00.000Z');

  const t1 = proximaTentativa(1, { agora });
  const t2 = proximaTentativa(2, { agora });
  const t3 = proximaTentativa(3, { agora });

  assert.equal(t1.getTime() - agora.getTime(), BACKOFF_BASE_MS);
  assert.equal(t2.getTime() - agora.getTime(), BACKOFF_BASE_MS * 2);
  assert.equal(t3.getTime() - agora.getTime(), BACKOFF_BASE_MS * 4);
});

test('proximaTentativa não passa do teto mesmo com muitas tentativas', () => {
  const agora = new Date('2026-08-13T10:00:00.000Z');
  const t20 = proximaTentativa(20, { agora });
  assert.equal(t20.getTime() - agora.getTime(), BACKOFF_TETO_MS);
});

test('esgotou é verdadeiro só quando tentativas alcança o máximo', () => {
  assert.equal(esgotou(1, 5), false);
  assert.equal(esgotou(4, 5), false);
  assert.equal(esgotou(5, 5), true);
  assert.equal(esgotou(6, 5), true);
  assert.equal(esgotou(5), true, 'usa MAX_TENTATIVAS_PADRAO quando não informado');
  assert.equal(MAX_TENTATIVAS_PADRAO, 5);
});

test('abandonado só é verdadeiro para trabalho processando há mais que o lease', () => {
  const agora = new Date('2026-08-13T10:10:00.000Z');

  assert.equal(
    abandonado({ status: 'pendente', reivindicado_em: null }, { agora }),
    false,
    'trabalho pendente nunca está abandonado',
  );

  const dentroDoLease = new Date(agora.getTime() - (LEASE_MS - 1000)).toISOString();
  assert.equal(
    abandonado({ status: 'processando', reivindicado_em: dentroDoLease }, { agora }),
    false,
  );

  const foraDoLease = new Date(agora.getTime() - (LEASE_MS + 1000)).toISOString();
  assert.equal(
    abandonado({ status: 'processando', reivindicado_em: foraDoLease }, { agora }),
    true,
  );
});

test('decidirDesfecho: exceção lançada vira falha_transitoria', () => {
  const desfecho = decidirDesfecho(null, new Error('banco fora do ar'));
  assert.equal(desfecho.desfecho, 'falha_transitoria');
  assert.equal(desfecho.motivo, 'banco fora do ar');
});

test('decidirDesfecho: entregaIncerta vira incerto, mesmo com um "acao" de sucesso aparente', () => {
  const desfecho = decidirDesfecho({ acao: 'escalonada_por_falha_entrega', motivo: 'timeout', entregaIncerta: true });
  assert.equal(desfecho.desfecho, 'incerto');
  assert.equal(desfecho.motivo, 'timeout');
});

test('decidirDesfecho: qualquer resultado válido sem entregaIncerta é "resolvido"', () => {
  for (const acao of [
    'respondida_pela_automacao', 'aguardando_equipe', 'resposta_abortada_por_controle',
    'escalonada_por_falha_entrega', 'escalonada', 'escalonada_para_equipe', 'mensagem_duplicada',
    'sem_orquestrador', 'sem_resposta_do_orquestrador', 'importada_do_canal',
  ]) {
    const desfecho = decidirDesfecho({ acao, entregaIncerta: false });
    assert.equal(desfecho.desfecho, 'resolvido', `"${acao}" deveria ser resolvido`);
    assert.equal(desfecho.acao, acao);
  }
});
