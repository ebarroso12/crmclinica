'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validarEventoChatwoot, EVENTOS } = require('../src/contratos/evento-chatwoot');
const { ErroDeContrato } = require('../src/contratos/erros');

const MENSAGEM = {
  event: 'message_created',
  id: 991,
  content: 'Olá',
  message_type: 'incoming',
  created_at: 1_785_000_000,
  conversation: { id: 4678, status: 'open', priority: 'high', labels: ['avaliacao'] },
  sender: { id: 55, name: 'Marina', phone_number: '+5516999999999', identifier: 'wa:55' },
  inbox: { id: 3, channel_type: 'Channel::Whatsapp' },
  account: { id: 1 },
};

test('normaliza um evento de mensagem do Chatwoot', () => {
  const evento = validarEventoChatwoot(MENSAGEM);

  assert.equal(evento.fonte, 'chatwoot');
  assert.equal(evento.evento, 'message_created');
  assert.equal(evento.conta_id, 1);
  assert.equal(evento.inbox_id, 3);
  assert.equal(evento.conversa_id, 4678);
  assert.equal(evento.conversa.canal, 'Channel::Whatsapp');
  assert.equal(evento.contato.telefone, '+5516999999999');
  assert.equal(evento.mensagem.direcao, 'incoming');
  assert.equal(evento.ocorrido_em, new Date(1_785_000_000 * 1000).toISOString());
  assert.match(evento.chave_idempotencia, /^[0-9a-f]{64}$/);
});

test('a chave de idempotência identifica o fato, não a entrega', () => {
  const primeira = validarEventoChatwoot(MENSAGEM);
  const reentrega = validarEventoChatwoot({ ...MENSAGEM });
  assert.equal(primeira.chave_idempotencia, reentrega.chave_idempotencia);

  // Mensagem diferente é fato diferente.
  const outra = validarEventoChatwoot({ ...MENSAGEM, id: 992 });
  assert.notEqual(primeira.chave_idempotencia, outra.chave_idempotencia);
});

test('todos os eventos declarados são aceitos', () => {
  for (const nome of EVENTOS) {
    const evento = validarEventoChatwoot({
      event: nome,
      id: 1,
      conversation: { id: 4678, status: 'open' },
      sender: { id: 55, name: 'Marina' },
    });
    assert.equal(evento.evento, nome);
  }
});

test('evento fora da lista é recusado', () => {
  assert.throws(
    () => validarEventoChatwoot({ event: 'webwidget_triggered', conversation: { id: 1 } }),
    ErroDeContrato,
  );
  assert.throws(() => validarEventoChatwoot({ conversation: { id: 1 } }), /event/);
  assert.throws(() => validarEventoChatwoot('texto'), /objeto/);
  assert.throws(() => validarEventoChatwoot([]), /objeto/);
});

test('mensagem sem identificador é recusada', () => {
  assert.throws(
    () => validarEventoChatwoot({ event: 'message_created', conversation: { id: 4678 } }),
    /identificador/,
  );
});

test('data ausente ou inválida vira o instante da recepção', () => {
  const evento = validarEventoChatwoot({ ...MENSAGEM, created_at: undefined });
  assert.match(evento.ocorrido_em, /^\d{4}-\d{2}-\d{2}T/);

  const invalida = validarEventoChatwoot({ ...MENSAGEM, created_at: 'ontem' });
  assert.match(invalida.ocorrido_em, /^\d{4}-\d{2}-\d{2}T/);
});

test('a chave não depende do relógio da recepção', async () => {
  // Regressão: quando o Chatwoot não manda `created_at`, usar o instante da recepção
  // fazia cada reentrega parecer um fato novo — e o paciente receberia resposta dobrada.
  const semData = {
    event: 'conversation_created',
    conversation: { id: 4678, status: 'open', labels: [] },
    sender: { id: 55, name: 'Marina' },
  };

  const primeira = validarEventoChatwoot(semData);
  await new Promise((resolver) => setTimeout(resolver, 5));
  const reentrega = validarEventoChatwoot(semData);

  assert.equal(primeira.chave_idempotencia, reentrega.chave_idempotencia);
  assert.notEqual(primeira.ocorrido_em, reentrega.ocorrido_em, 'o instante registrado difere');
});

test('a chave ainda distingue fatos diferentes sem data de origem', () => {
  const base = { event: 'conversation_created', conversation: { id: 4678, status: 'open' } };
  const outra = { event: 'conversation_created', conversation: { id: 4679, status: 'open' } };

  assert.notEqual(
    validarEventoChatwoot(base).chave_idempotencia,
    validarEventoChatwoot(outra).chave_idempotencia,
  );
});

test('responsável e time são normalizados quando existem', () => {
  const evento = validarEventoChatwoot({
    event: 'assignee_changed',
    conversation: {
      id: 4678,
      status: 'open',
      meta: { assignee: { id: 7, name: 'Recepção' }, team: { id: 2, name: 'clinica dr edson' } },
    },
  });

  assert.equal(evento.conversa.responsavel.nome, 'Recepção');
  assert.equal(evento.conversa.time.nome, 'clinica dr edson');
});

test('conversa sem responsável devolve null em vez de objeto vazio', () => {
  const evento = validarEventoChatwoot({ event: 'assignee_changed', conversation: { id: 4678, status: 'open' } });
  assert.equal(evento.conversa.responsavel, null);
  assert.equal(evento.conversa.time, null);
});
