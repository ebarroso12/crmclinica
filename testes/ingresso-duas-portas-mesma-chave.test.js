'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarEventoEvolution } = require('../src/integracoes/evolution-webhook');
const { validarEvento } = require('../src/contratos/evento');

// A duplicação que ESTAVA acontecendo em produção.
//
// A mesma mensagem do paciente chega pelas duas portas de ingresso do
// WhatsApp — o webhook da Evolution e a ponte do OpenClaw — e as duas trazem o
// MESMO `id` nativo do WhatsApp. Enquanto cada porta carimbava o próprio nome
// no `id_externo` (`evolution:` / `openclaw:`), a chave de idempotência saía
// diferente para o mesmo evento: duas linhas em `mensagens`, dois trabalhos na
// outbox e, com a automação ligada, DUAS respostas ao mesmo paciente.
//
// Confirmado no banco de produção em 2026-08-15 por consulta somente leitura:
// 19 mensagens de entrada gravadas duas vezes, sempre com o mesmo sufixo de
// identificador e origens `evolution` + `openclaw`, a maioria com menos de um
// minuto entre as cópias — ou seja, duas portas recebendo o mesmo evento, não
// o paciente escrevendo duas vezes.
//
// Este teste é a trava: as duas portas precisam produzir a MESMA chave.

const ID_NATIVO = '3EB0F1A2B3C4D5E6';
const TELEFONE = '5511999990000';
const INSTANTE = 1786028400;

/** O payload nativo da Evolution para a mensagem. */
function peloWebhookDaEvolution() {
  return normalizarEventoEvolution({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false, id: ID_NATIVO },
      message: { conversation: 'Gostaria de marcar uma consulta' },
      pushName: 'Paciente Sintético',
      messageTimestamp: INSTANTE,
    },
  });
}

/**
 * O mesmo evento pela ponte do OpenClaw.
 *
 * A ponte é um módulo ESM dentro do plugin; carregá-la aqui exigiria import
 * dinâmico e não acrescentaria nada ao que importa provar. O que importa é o
 * contrato do `id_externo` que ela emite para uma mensagem COM `messageId`
 * nativo — replicado aqui e travado pelo teste de igualdade abaixo, com
 * `testes/openclaw-ingresso-plugin.test.js` guardando o outro lado.
 */
function pelaPonteDoOpenClaw() {
  return {
    tipo: 'mensagem.recebida',
    canal: 'whatsapp',
    id_externo: `whatsapp:${ID_NATIVO}`,
    remetente: TELEFONE,
    nome: 'Paciente Sintético',
    texto: 'Gostaria de marcar uma consulta',
    origem: 'openclaw_plugin',
    ocorrido_em: new Date(INSTANTE * 1000).toISOString(),
  };
}

test('as duas portas produzem o MESMO id_externo para a mesma mensagem', () => {
  const evolution = peloWebhookDaEvolution();
  const ponte = pelaPonteDoOpenClaw();

  assert.ok(evolution, 'o payload da Evolution é reconhecido');
  assert.equal(evolution.id_externo, ponte.id_externo);
  assert.equal(evolution.id_externo, `whatsapp:${ID_NATIVO}`);
});

test('as duas portas produzem a MESMA chave de idempotência', () => {
  const porEvolution = validarEvento(peloWebhookDaEvolution());
  const porPonte = validarEvento(pelaPonteDoOpenClaw());

  assert.equal(
    porEvolution.chave_idempotencia, porPonte.chave_idempotencia,
    'chaves diferentes para o mesmo evento = mensagem gravada duas vezes = paciente respondido duas vezes',
  );
});

test('nenhuma porta volta a carimbar o próprio nome quando há id nativo', () => {
  const evolution = peloWebhookDaEvolution();
  assert.ok(
    !evolution.id_externo.startsWith('evolution:'),
    'o nome da porta no prefixo é exatamente o que quebrava a deduplicação',
  );
  assert.ok(!evolution.id_externo.startsWith('openclaw:'));
});

test('mensagens diferentes continuam com chaves diferentes', () => {
  // A correção não pode colar mensagens distintas na mesma chave — isso
  // trocaria resposta duplicada por mensagem de paciente perdida.
  const primeira = validarEvento(peloWebhookDaEvolution());
  const segunda = validarEvento(normalizarEventoEvolution({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false, id: 'OUTRO-ID-NATIVO' },
      message: { conversation: 'Gostaria de marcar uma consulta' },
      pushName: 'Paciente Sintético',
      messageTimestamp: INSTANTE,
    },
  }));

  assert.notEqual(primeira.chave_idempotencia, segunda.chave_idempotencia);
});

test('sem id nativo, a Evolution mantém prefixo próprio — não finge convergir', () => {
  // Sem identificador do canal não há como as duas portas concordarem. Fingir
  // que concordam faria mensagens diferentes colidirem e sumirem.
  const semId = normalizarEventoEvolution({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: `${TELEFONE}@s.whatsapp.net`, fromMe: false },
      message: { conversation: 'Mensagem sem identificador' },
      messageTimestamp: INSTANTE,
    },
  });

  assert.ok(semId.id_externo.startsWith('evolution:'), 'o fallback continua identificado pela origem');
});
