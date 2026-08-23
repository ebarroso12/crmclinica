'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarEventoInstagram, normalizarComentarioInstagram } = require('../src/integracoes/instagram-webhook');

const MENSAGEM_TEXTO = Object.freeze({
  object: 'instagram',
  entry: [
    {
      id: '17841400000000000',
      time: 1723500000,
      messaging: [
        {
          sender: { id: '1234567890123456' },
          recipient: { id: '17841400000000000' },
          timestamp: 1723500000123,
          message: { mid: 'aWdfZAG1zZAG1zc2FnZAQVAA', text: 'Olá, gostaria de informações' },
        },
      ],
    },
  ],
});

test('traduz uma mensagem de texto do Instagram para o contrato do CRM', () => {
  const normalizado = normalizarEventoInstagram(MENSAGEM_TEXTO);
  assert.ok(normalizado);
  assert.equal(normalizado.tipo, 'mensagem.recebida');
  assert.equal(normalizado.canal, 'instagram');
  assert.equal(normalizado.remetente, '1234567890123456');
  assert.equal(normalizado.nome, null);
  assert.equal(normalizado.texto, 'Olá, gostaria de informações');
  assert.equal(normalizado.origem, 'instagram_webhook');
  assert.equal(normalizado.ocorrido_em, new Date(1723500000123).toISOString());
});

test('id_externo usa o formato instagram:<psid>:<id nativo da mensagem>', () => {
  const normalizado = normalizarEventoInstagram(MENSAGEM_TEXTO);
  assert.equal(normalizado.id_externo, 'instagram:1234567890123456:aWdfZAG1zZAG1zc2FnZAQVAA');
});

test('ignora eco de mensagem enviada pela própria clínica (is_echo)', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        timestamp: 1723500000123,
        message: { mid: 'X1', text: 'oi', is_echo: true },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('ignora evento de leitura (messaging.read, sem messaging.message)', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        recipient: { id: '17841400000000000' },
        timestamp: 1723500000123,
        read: { mid: 'X1', watermark: 1723500000123 },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('ignora evento de entrega (messaging.delivery, sem messaging.message)', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        recipient: { id: '17841400000000000' },
        timestamp: 1723500000123,
        delivery: { mids: ['X1'], watermark: 1723500000123 },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('não derruba com payload vazio, nulo ou malformado', () => {
  assert.equal(normalizarEventoInstagram(), null);
  assert.equal(normalizarEventoInstagram(null), null);
  assert.equal(normalizarEventoInstagram({}), null);
  assert.equal(normalizarEventoInstagram({ entry: [] }), null);
  assert.equal(normalizarEventoInstagram({ entry: [{}] }), null, 'entry[0] sem messaging');
  assert.equal(normalizarEventoInstagram({ entry: [{ messaging: [] }] }), null, 'messaging vazio');
  assert.equal(normalizarEventoInstagram({ entry: [{ messaging: [{}] }] }), null, 'messaging[0] sem message/read/delivery');
  assert.equal(normalizarEventoInstagram({ entry: 'texto solto' }), null);
  assert.equal(normalizarEventoInstagram({ entry: [{ messaging: 'texto solto' }] }), null);
});

test('ignora mensagem sem remetente (sender.id ausente)', () => {
  const evento = {
    entry: [{
      messaging: [{
        recipient: { id: '17841400000000000' },
        timestamp: 1723500000123,
        message: { mid: 'X1', text: 'oi' },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('ignora mensagem sem texto', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        timestamp: 1723500000123,
        message: { mid: 'X1' },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('ignora mensagem sem id nativo (mid) — sem chave de dedupe possível', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        timestamp: 1723500000123,
        message: { text: 'oi' },
      }],
    }],
  };
  assert.equal(normalizarEventoInstagram(evento), null);
});

test('ocorrido_em é null quando não há timestamp no evento', () => {
  const evento = {
    entry: [{
      messaging: [{
        sender: { id: '1234567890123456' },
        message: { mid: 'X1', text: 'oi' },
      }],
    }],
  };
  const normalizado = normalizarEventoInstagram(evento);
  assert.ok(normalizado);
  assert.equal(normalizado.ocorrido_em, null);
});

// ------------------------------------------------- normalizarComentarioInstagram

const COMENTARIO = Object.freeze({
  object: 'instagram',
  entry: [
    {
      id: '17841400000000000',
      time: 1723500000,
      changes: [
        {
          field: 'comments',
          value: {
            id: '17865000000000001',
            text: 'Quero saber mais, preço?',
            from: { id: '9988776655443322', username: 'paciente_curioso' },
            media: { id: '18000000000000001', media_product_type: 'FEED' },
          },
        },
      ],
    },
  ],
});

test('traduz um comentário do Instagram para o contrato interno', () => {
  const normalizado = normalizarComentarioInstagram(COMENTARIO);
  assert.ok(normalizado);
  assert.equal(normalizado.comentario_id_externo, '17865000000000001');
  assert.equal(normalizado.post_id, '18000000000000001');
  assert.equal(normalizado.autor_ig_id, '9988776655443322');
  assert.equal(normalizado.autor_username, 'paciente_curioso');
  assert.equal(normalizado.texto, 'Quero saber mais, preço?');
  assert.equal(normalizado.ocorrido_em, new Date(1723500000 * 1000).toISOString());
});

test('ignora comentário que é resposta a outro comentário (parent_id presente)', () => {
  const evento = {
    entry: [{
      time: 1723500000,
      changes: [{
        field: 'comments',
        value: {
          id: 'C2',
          parent_id: 'C1',
          text: 'obrigado!',
          from: { id: '111', username: 'alguem' },
        },
      }],
    }],
  };
  assert.equal(normalizarComentarioInstagram(evento), null);
});

test('normalizarComentarioInstagram não derruba com payload vazio, nulo ou malformado', () => {
  assert.equal(normalizarComentarioInstagram(), null);
  assert.equal(normalizarComentarioInstagram(null), null);
  assert.equal(normalizarComentarioInstagram({}), null);
  assert.equal(normalizarComentarioInstagram({ entry: [] }), null);
  assert.equal(normalizarComentarioInstagram({ entry: [{}] }), null, 'entry[0] sem changes');
  assert.equal(normalizarComentarioInstagram({ entry: [{ changes: [] }] }), null, 'changes vazio');
  assert.equal(
    normalizarComentarioInstagram({ entry: [{ changes: [{ field: 'mentions', value: {} }] }] }),
    null,
    'changes sem nenhum item field:comments',
  );
  assert.equal(
    normalizarComentarioInstagram({ entry: [{ changes: [{ field: 'comments', value: null }] }] }),
    null,
    'value ausente/malformado',
  );
  assert.equal(
    normalizarComentarioInstagram({ entry: [{ changes: [{ field: 'comments', value: { text: 'oi', from: { id: '1' } } }] }] }),
    null,
    'value sem id do comentário',
  );
  assert.equal(
    normalizarComentarioInstagram({ entry: [{ changes: [{ field: 'comments', value: { id: 'C1', text: 'oi' } }] }] }),
    null,
    'value sem from.id',
  );
  assert.equal(
    normalizarComentarioInstagram({ entry: [{ changes: [{ field: 'comments', value: { id: 'C1', from: { id: '1' } } }] }] }),
    null,
    'value sem texto',
  );
  assert.equal(normalizarComentarioInstagram({ entry: 'texto solto' }), null);
  assert.equal(normalizarComentarioInstagram({ entry: [{ changes: 'texto solto' }] }), null);
});
