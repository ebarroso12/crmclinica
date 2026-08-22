'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarEventoEvolution, normalizarEcoDeEnvioEvolution } = require('../src/integracoes/evolution-webhook');

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
  assert.equal(normalizado.id_externo, 'whatsapp:5511999990000:3EB0AAAA');
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

// ---------------------------------------------------------------------------
// normalizarEcoDeEnvioEvolution — migration 042 / pedido do Dr. Edson
// (2026-08-17): mensagem enviada pela equipe direto no WhatsApp Web/app
// (mesmo número, outro dispositivo — não pelo CRM) precisa aparecer na
// tela. É o OUTRO LADO do que `normalizarEventoEvolution` ignora com
// `fromMe:true`.
// ---------------------------------------------------------------------------

const ECO_DE_ENVIO = Object.freeze({
  event: 'messages.upsert',
  instance: 'clinica',
  data: {
    key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: true, id: '3EB0BBBB' },
    message: { conversation: 'Pode vir amanhã às 14h' },
    messageType: 'conversation',
    messageTimestamp: 1723500100,
  },
});

test('traduz um envio da equipe direto no WhatsApp (fromMe:true) para registro', () => {
  const normalizado = normalizarEcoDeEnvioEvolution(ECO_DE_ENVIO);
  assert.ok(normalizado);
  assert.equal(normalizado.telefone, '5511999990000');
  assert.equal(normalizado.texto, 'Pode vir amanhã às 14h');
  assert.equal(normalizado.id_provedor, 'whatsapp:5511999990000:3EB0BBBB');
});

test('normalizarEcoDeEnvioEvolution ignora mensagem de ENTRADA (fromMe:false) — não é o caso dela', () => {
  const evento = { ...ECO_DE_ENVIO, data: { ...ECO_DE_ENVIO.data, key: { ...ECO_DE_ENVIO.data.key, fromMe: false } } };
  assert.equal(normalizarEcoDeEnvioEvolution(evento), null);
});

test('normalizarEcoDeEnvioEvolution: o id_provedor usa o MESMO formato whatsapp:<telefone>:<id> que id_externo de entrada', () => {
  // Esta igualdade de formato é o que faz o índice único de id_provedor
  // reconhecer, do lado do banco, que um envio do próprio CRM (marcado por
  // marcarIdProvedorDaMensagem com esta MESMA string) e o eco que a Evolution
  // manda de volta são o MESMO evento — ver db/042_mensagens_id_provedor.sql.
  const entrada = normalizarEventoEvolution({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'IGUAL1' },
      message: { conversation: 'oi' },
      messageTimestamp: 1723500000,
    },
  });
  const eco = normalizarEcoDeEnvioEvolution({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: true, id: 'IGUAL1' },
      message: { conversation: 'oi de volta' },
      messageTimestamp: 1723500000,
    },
  });
  assert.equal(entrada.id_externo, 'whatsapp:5511999990000:IGUAL1');
  assert.equal(eco.id_provedor, 'whatsapp:5511999990000:IGUAL1');
});

test('normalizarEcoDeEnvioEvolution ignora grupo, sem texto, sem id nativo, e payload malformado', () => {
  assert.equal(normalizarEcoDeEnvioEvolution({
    ...ECO_DE_ENVIO, data: { ...ECO_DE_ENVIO.data, key: { ...ECO_DE_ENVIO.data.key, remoteJid: '123-456@g.us' } },
  }), null, 'grupo');
  assert.equal(normalizarEcoDeEnvioEvolution({
    ...ECO_DE_ENVIO, data: { ...ECO_DE_ENVIO.data, message: { imageMessage: {} } },
  }), null, 'sem texto reconhecível');
  assert.equal(normalizarEcoDeEnvioEvolution({
    ...ECO_DE_ENVIO, data: { ...ECO_DE_ENVIO.data, key: { ...ECO_DE_ENVIO.data.key, id: '' } },
  }), null, 'sem id nativo — sem chave de dedupe possível');
  assert.equal(normalizarEcoDeEnvioEvolution(), null);
  assert.equal(normalizarEcoDeEnvioEvolution(null), null);
  assert.equal(normalizarEcoDeEnvioEvolution({}), null);
  assert.equal(normalizarEcoDeEnvioEvolution({ event: 'connection.update', data: {} }), null);
});

// ---------------------------------------------------------------------------
// Tratamento de JID @lid (Linked ID) — Anexo B.5 da auditoria.
//
// O WhatsApp pode entregar mensagens com `remoteJid` terminado em `@lid`
// (identidade opaca) em vez de `@s.whatsapp.net`. Os dígitos de um `@lid`
// NÃO são um telefone: tratá-los como número criava contato fantasma no CRM.
// O telefone real chega no campo alternativo (`remoteJidAlt`).
// ---------------------------------------------------------------------------

test('mensagem com remoteJid @lid usa remoteJidAlt para extrair o telefone', () => {
  const evento = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '123456789012345@lid', remoteJidAlt: '5511999990000@s.whatsapp.net', fromMe: false, id: 'LID001' },
      pushName: 'Paciente LID',
      message: { conversation: 'Oi, preciso de ajuda' },
      messageTimestamp: 1723500000,
    },
  };
  const normalizado = normalizarEventoEvolution(evento);
  assert.ok(normalizado);
  assert.equal(normalizado.remetente, '5511999990000');
  assert.equal(normalizado.id_externo, 'whatsapp:5511999990000:LID001');
});

test('mensagem @lid sem remoteJidAlt é recusada — não cria contato fantasma', () => {
  const evento = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '123456789012345@lid', fromMe: false, id: 'LID002' },
      message: { conversation: 'Oi' },
      messageTimestamp: 1723500000,
    },
  };
  assert.equal(normalizarEventoEvolution(evento), null);
});

test('eco fromMe:true com @lid usa remoteJidAlt para formar id_provedor', () => {
  const evento = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '123456789012345@lid', remoteJidAlt: '5511999990000@s.whatsapp.net', fromMe: true, id: 'LID003' },
      message: { conversation: 'Resposta da equipe' },
      messageTimestamp: 1723500000,
    },
  };
  const normalizado = normalizarEcoDeEnvioEvolution(evento);
  assert.ok(normalizado);
  assert.equal(normalizado.telefone, '5511999990000');
  assert.equal(normalizado.id_provedor, 'whatsapp:5511999990000:LID003');
});

test('eco fromMe:true com @lid mas sem remoteJidAlt é recusado', () => {
  const evento = {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '123456789012345@lid', fromMe: true, id: 'LID004' },
      message: { conversation: 'Oi' },
      messageTimestamp: 1723500000,
    },
  };
  assert.equal(normalizarEcoDeEnvioEvolution(evento), null);
});
