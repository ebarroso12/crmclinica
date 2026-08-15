'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarEventoEvolution } = require('../src/integracoes/evolution-webhook');

const MENSAGEM_TEXTO = Object.freeze({
  event: 'messages.upsert',
  instance: 'clinica',
  data: {
    key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: '3EB0AAAA' },
    pushName: 'Paciente Teste',
    message: { conversation: 'Olá, gostaria de informações' },
    messageType: 'conversation',
    messageTimestamp: 1723500000,
  },
});

test('traduz uma mensagem de texto da Evolution para o contrato do CRM', () => {
  const normalizado = normalizarEventoEvolution(MENSAGEM_TEXTO);
  assert.ok(normalizado);
  assert.equal(normalizado.tipo, 'mensagem.recebida');
  assert.equal(normalizado.canal, 'whatsapp');
  assert.equal(normalizado.remetente, '5511999990000');
  assert.equal(normalizado.nome, 'Paciente Teste');
  assert.equal(normalizado.texto, 'Olá, gostaria de informações');
  assert.equal(normalizado.origem, 'evolution_webhook');
  assert.equal(normalizado.id_externo, 'whatsapp:3EB0AAAA');
  assert.equal(normalizado.ocorrido_em, new Date(1723500000 * 1000).toISOString());
});

test('lê texto de mensagem estendida (extendedTextMessage) quando não há conversation', () => {
  const evento = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'X1' },
      message: { extendedTextMessage: { text: 'resposta a uma citação' } },
      messageTimestamp: 1723500000,
    },
  };
  const normalizado = normalizarEventoEvolution(evento);
  assert.equal(normalizado.texto, 'resposta a uma citação');
});

test('ignora eco de mensagem enviada pela própria clínica (fromMe)', () => {
  const evento = { ...MENSAGEM_TEXTO, data: { ...MENSAGEM_TEXTO.data, key: { ...MENSAGEM_TEXTO.data.key, fromMe: true } } };
  assert.equal(normalizarEventoEvolution(evento), null);
});

test('ignora mensagem de grupo', () => {
  const evento = {
    ...MENSAGEM_TEXTO,
    data: { ...MENSAGEM_TEXTO.data, key: { ...MENSAGEM_TEXTO.data.key, remoteJid: '123456-789@g.us' } },
  };
  assert.equal(normalizarEventoEvolution(evento), null);
});

test('ignora mensagem sem texto reconhecível (mídia sem legenda)', () => {
  const evento = { ...MENSAGEM_TEXTO, data: { ...MENSAGEM_TEXTO.data, message: { imageMessage: {} } } };
  assert.equal(normalizarEventoEvolution(evento), null);
});

test('ignora eventos que não são mensagem (CONNECTION_UPDATE, QRCODE_UPDATED)', () => {
  assert.equal(normalizarEventoEvolution({ event: 'connection.update', data: {} }), null);
  assert.equal(normalizarEventoEvolution({ event: 'qrcode.updated', data: {} }), null);
});

test('não derruba com payload vazio, nulo ou malformado', () => {
  assert.equal(normalizarEventoEvolution(), null);
  assert.equal(normalizarEventoEvolution(null), null);
  assert.equal(normalizarEventoEvolution({}), null);
  assert.equal(normalizarEventoEvolution({ event: 'messages.upsert', data: null }), null);
  assert.equal(normalizarEventoEvolution({ event: 'messages.upsert', data: 'texto solto' }), null);
});

test('remetente inválido (não numérico) é ignorado', () => {
  const evento = { ...MENSAGEM_TEXTO, data: { ...MENSAGEM_TEXTO.data, key: { ...MENSAGEM_TEXTO.data.key, remoteJid: 'nao-e-telefone' } } };
  assert.equal(normalizarEventoEvolution(evento), null);
});
