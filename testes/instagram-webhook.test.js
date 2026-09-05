'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarEventoInstagram, normalizarComentarioInstagram, normalizarComentariosInstagram,
} = require('../src/integracoes/instagram-webhook');

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

test('com contaComercialId informado, ignora comentário feito pela própria conta (from.id bate)', () => {
  const evento = {
    entry: [{
      time: 1723500000,
      changes: [{
        field: 'comments',
        value: { id: 'C9', text: 'resposta da clínica', from: { id: '555000111', username: 'clinica_oficial' } },
      }],
    }],
  };
  assert.equal(normalizarComentarioInstagram(evento, { contaComercialId: '555000111' }), null);
});

test('com contaComercialId informado, ignora comentário via self_ig_scoped_id', () => {
  const evento = {
    entry: [{
      time: 1723500000,
      changes: [{
        field: 'comments',
        value: { id: 'C10', text: 'resposta da clínica', from: { id: '999', self_ig_scoped_id: '555000111', username: 'clinica_oficial' } },
      }],
    }],
  };
  assert.equal(normalizarComentarioInstagram(evento, { contaComercialId: '555000111' }), null);
});

test('sem contaComercialId informado, comentário da própria conta NÃO é filtrado (comportamento anterior preservado)', () => {
  const normalizado = normalizarComentarioInstagram(COMENTARIO);
  assert.ok(normalizado, 'sem contaComercialId, o filtro fica desligado — mesmo comportamento de antes');
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


// ----------------------------------------------------- lote de comentários

test('o lote inteiro é lido — a Meta empacota mais de um comentário por chamada', () => {
  // Achado de 05/09: o singular lê só `entry[0].changes[primeiro com field
  // comments]`. O resto do lote era descartado com HTTP 200 — e a Meta não
  // reentrega o que já foi aceito, então o comentário sumia sem rastro.
  const lote = {
    entry: [
      {
        time: 1756900000,
        changes: [
          { field: 'comments', value: { id: 'c1', text: 'quero saber o preço', from: { id: 'ig-1' }, media: { id: 'post-1' } } },
          { field: 'comments', value: { id: 'c2', text: 'me chama no direct', from: { id: 'ig-2' }, media: { id: 'post-1' } } },
        ],
      },
      {
        time: 1756900001,
        changes: [
          { field: 'comments', value: { id: 'c3', text: 'atende em Ribeirão?', from: { id: 'ig-3' }, media: { id: 'post-2' } } },
        ],
      },
    ],
  };

  const comentarios = normalizarComentariosInstagram(lote);

  assert.equal(comentarios.length, 3);
  assert.deepEqual(comentarios.map((c) => c.comentario_id_externo), ['c1', 'c2', 'c3']);
  assert.equal(comentarios[2].post_id, 'post-2');
});

test('no lote, os mesmos cortes do singular continuam valendo', () => {
  const lote = {
    entry: [{
      time: 1756900000,
      changes: [
        // Resposta a outro comentário: reagir a isto encadeia a automação.
        { field: 'comments', value: { id: 'c1', parent_id: 'c0', text: 'obrigada!', from: { id: 'ig-1' } } },
        // Comentário da própria clínica.
        { field: 'comments', value: { id: 'c2', text: 'oi!', from: { id: 'conta-da-clinica' } } },
        // Sem texto não há gatilho a avaliar.
        { field: 'comments', value: { id: 'c3', text: '', from: { id: 'ig-3' } } },
        // Outro campo do webhook, não é comentário.
        { field: 'mentions', value: { id: 'c4', text: 'oi', from: { id: 'ig-4' } } },
        { field: 'comments', value: { id: 'c5', text: 'quanto custa?', from: { id: 'ig-5' } } },
      ],
    }],
  };

  const comentarios = normalizarComentariosInstagram(lote, { contaComercialId: 'conta-da-clinica' });

  assert.deepEqual(comentarios.map((c) => c.comentario_id_externo), ['c5']);
});

test('o singular continua devolvendo o primeiro comentário do lote', () => {
  const lote = {
    entry: [{
      time: 1756900000,
      changes: [
        { field: 'comments', value: { id: 'c1', text: 'primeiro', from: { id: 'ig-1' } } },
        { field: 'comments', value: { id: 'c2', text: 'segundo', from: { id: 'ig-2' } } },
      ],
    }],
  };

  assert.equal(normalizarComentarioInstagram(lote).comentario_id_externo, 'c1');
});
