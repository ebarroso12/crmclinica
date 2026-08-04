'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  avaliarRiscoDoCanal,
  VOLUME_ATENCAO_DIA, VOLUME_RISCO_DIA,
  RECUSA_ATENCAO, RECUSA_RISCO,
  FALHA_ATENCAO, FALHA_RISCO,
  QUEDAS_ATENCAO, QUEDAS_RISCO,
} = require('../src/dominio/risco-canal');

// Uma clínica de porte comum: algumas dezenas de lembretes por dia, quase
// ninguém pedindo para parar, entrega funcionando.
const ROTINA = Object.freeze({
  enviadosPorDia: 40, enviados: 1200, falhas: 12, contatos: 600, optouts: 4, quedasEm24h: 0,
});

test('uso de clínica não dispara alarme', () => {
  const r = avaliarRiscoDoCanal(ROTINA);
  assert.equal(r.nivel, 'tranquilo');
  assert.deepEqual(r.motivos, []);
});

test('sem histórico, não afirma que está tudo bem', () => {
  // A diferença importa: "não há risco" é uma garantia; "não sei ainda" é a
  // verdade. Prometer segurança sobre zero dado é o erro mais fácil aqui.
  const r = avaliarRiscoDoCanal({});
  assert.equal(r.semDados, true);
  assert.match(r.recomendacao, /ainda não há envios/i);
});

test('volume de disparador acende o alerta', () => {
  const atencao = avaliarRiscoDoCanal({ ...ROTINA, enviadosPorDia: VOLUME_ATENCAO_DIA });
  assert.equal(atencao.nivel, 'atencao');

  const risco = avaliarRiscoDoCanal({ ...ROTINA, enviadosPorDia: VOLUME_RISCO_DIA });
  assert.equal(risco.nivel, 'risco');
  assert.ok(risco.motivos.some((m) => m.chave === 'volume'));
});

test('gente pedindo PARAR é o sinal mais grave', () => {
  // 5% dos contatos recusando. O WhatsApp não vê o nosso opt-out, mas quem
  // chega a pedir para parar é quem já poderia ter denunciado.
  const r = avaliarRiscoDoCanal({ ...ROTINA, contatos: 600, optouts: Math.ceil(600 * RECUSA_RISCO) });
  assert.equal(r.nivel, 'risco');
  assert.ok(r.motivos.some((m) => m.chave === 'recusa'));
});

test('recusa logo acima do limite é atenção, não pânico', () => {
  const r = avaliarRiscoDoCanal({ ...ROTINA, contatos: 1000, optouts: Math.ceil(1000 * RECUSA_ATENCAO) });
  assert.equal(r.nivel, 'atencao');
});

test('falha em série é tratada como bloqueio começando', () => {
  const total = 1000;
  const r = avaliarRiscoDoCanal({
    ...ROTINA, enviados: total, falhas: Math.ceil(total * FALHA_RISCO / (1 - FALHA_RISCO)),
  });
  assert.equal(r.nivel, 'risco');
  assert.ok(r.motivos.some((m) => m.chave === 'falha'));
});

test('uma falha isolada não vira alarme', () => {
  const r = avaliarRiscoDoCanal({ ...ROTINA, enviados: 1000, falhas: 1 });
  assert.equal(r.nivel, 'tranquilo');
});

test('sessão caindo o tempo todo conta como sinal', () => {
  assert.equal(avaliarRiscoDoCanal({ ...ROTINA, quedasEm24h: QUEDAS_ATENCAO }).nivel, 'atencao');
  assert.equal(avaliarRiscoDoCanal({ ...ROTINA, quedasEm24h: QUEDAS_RISCO }).nivel, 'risco');
});

test('o pior sinal manda, mesmo com os outros calmos', () => {
  // Sem isto, um único indicador em brasa ficaria diluído por três tranquilos —
  // e é justamente o indicador isolado que antecede o bloqueio.
  const r = avaliarRiscoDoCanal({ ...ROTINA, contatos: 100, optouts: 10 });
  assert.equal(r.nivel, 'risco');
});

test('a recomendação muda conforme a gravidade, e diz o que fazer', () => {
  assert.match(avaliarRiscoDoCanal(ROTINA).recomendacao, /não há motivo para trocar/i);
  assert.match(
    avaliarRiscoDoCanal({ ...ROTINA, enviadosPorDia: VOLUME_ATENCAO_DIA }).recomendacao,
    /preparar a migração/i,
  );
  assert.match(
    avaliarRiscoDoCanal({ ...ROTINA, enviadosPorDia: VOLUME_RISCO_DIA }).recomendacao,
    /Meta Cloud/,
  );
});

test('divisão por zero não quebra a conta', () => {
  const r = avaliarRiscoDoCanal({ enviadosPorDia: 10, enviados: 0, falhas: 0, contatos: 0, optouts: 0 });
  assert.equal(Number.isFinite(r.indicadores.taxaDeRecusa), true);
  assert.equal(Number.isFinite(r.indicadores.taxaDeFalha), true);
});

test('valor ausente ou sujo é tratado como zero, não como NaN', () => {
  // Um NaN aqui atravessaria as comparações sem erro e devolveria "tranquilo"
  // para qualquer coisa — o alerta ficaria mudo sem ninguém notar.
  const r = avaliarRiscoDoCanal({
    enviadosPorDia: 'abc', enviados: null, falhas: undefined, contatos: 50, optouts: 5,
  });
  assert.equal(r.nivel, 'risco');
  assert.equal(Number.isNaN(r.indicadores.enviadosPorDia), false);
});
