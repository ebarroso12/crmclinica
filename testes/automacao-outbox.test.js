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

// ----------------------------------------------------- Comando 7, achado M-1
//
// A Evolution API (canal primário desde os PRs #30/#31) não tem idempotência
// nativa no endpoint de envio — confirmado no próprio código-fonte
// (evolution-envio.js): a `chave` que canal-conversas.js deriva e repassa
// nunca chega a ser usada ali, e não há mecanismo do lado da Evolution para
// usá-la mesmo se chegasse. Com isso, "reenviar não duplica porque o gateway
// deduplica" (o que o código antigo dizia) é falso pelo canal primário — só é
// verdade pelo gateway WebSocket do OpenClaw (reserva), que de fato usa
// `idempotencyKey`. A defesa real contra duplicata aqui é NÃO reentregar sem
// necessidade — e isso depende de LEASE_MS ter folga suficiente para nunca
// confundir "ainda processando" com "worker morto".
test('LEASE_MS tem folga confortável sobre o pior caso documentado (IA + orquestrador + Evolution)', () => {
  // Valores-padrão hoje (src/config.js): IA_TIMEOUT_MS 30000,
  // OPENCLAW_CLINICA_GATEWAY_TIMEOUT_MS 30000, EVOLUTION_API_TIMEOUT_MS
  // 15000 — somados, ~75s. E essas três chamadas remotas não são a viagem
  // inteira: há leitura/gravação no banco entre elas, sem timeout nenhum
  // contabilizado nessa soma. LEASE_MS é uma constante fixa deste arquivo —
  // não acompanha automaticamente se alguém configurar um timeout maior via
  // env —, então a margem sobre o pior caso DOCUMENTADO precisa ser folgada.
  const PIOR_CASO_DOCUMENTADO_MS = 30000 + 30000 + 15000;
  assert.ok(
    LEASE_MS >= PIOR_CASO_DOCUMENTADO_MS * 2,
    `LEASE_MS (${LEASE_MS}ms) precisa de pelo menos o dobro do pior caso documentado (${PIOR_CASO_DOCUMENTADO_MS}ms) — margem fina demais é o que causa reivindicação prematura de um trabalho que só está demorando, não morto.`,
  );
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
