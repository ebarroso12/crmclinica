'use strict';

// Cobre enviarBotaoWhatsapp() de instagram-envio.js — mesma infraestrutura
// de enviar() (URL, timeout, tratamento de erro), só muda o corpo da
// mensagem para um template de botão apontando pro WhatsApp. NÃO cobre
// aqui de novo os casos de rede indeterminada/timeout/ECONNRESET, já
// provados contra enviar() em instagram-envio.test.js — o núcleo
// (enviarPayload) é o mesmo código, testado uma vez só.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteInstagramEnvio } = require('../src/integracoes/instagram-envio');

const CONFIG = Object.freeze({
  accessToken: 'token-sintetico',
  contaComercialId: '17841400000000000',
  timeoutMs: 5000,
});

function fetchFalso(implementacao) {
  const chamadas = [];
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return implementacao(url, opcoes);
  };
  fetchImpl.chamadas = chamadas;
  return fetchImpl;
}

test('envia template de botão com recipient.id, attachment/payload de botão e URL do wa.me', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ recipient_id: 'psid-123', message_id: 'mid.MSG123' }),
    { status: 200 },
  ));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  const resultado = await cliente.enviarBotaoWhatsapp({
    telefone: 'psid-123',
    numeroWhatsapp: '5516999999999',
    texto: 'Vamos continuar pelo WhatsApp?',
  });
  assert.equal(resultado.identificador, 'mid.MSG123');

  assert.equal(fetchImpl.chamadas.length, 1);
  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://graph.instagram.com/v23.0/me/messages');
  assert.equal(opcoes.method, 'POST');
  assert.equal(opcoes.headers.authorization, 'Bearer token-sintetico');

  const corpo = JSON.parse(opcoes.body);
  assert.deepEqual(corpo.recipient, { id: 'psid-123' });
  assert.equal(corpo.message.attachment.type, 'template');
  assert.equal(corpo.message.attachment.payload.template_type, 'button');
  assert.equal(corpo.message.attachment.payload.text, 'Vamos continuar pelo WhatsApp?');
  assert.equal(corpo.message.attachment.payload.buttons.length, 1);
  assert.equal(corpo.message.attachment.payload.buttons[0].url, 'https://wa.me/5516999999999');
  assert.equal(corpo.message.attachment.payload.buttons[0].title, 'Falar no WhatsApp');
});

test('resposta sem message_id lança erro (Graph API não confirmou o envio)', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ recipient_id: 'psid-123' }),
    { status: 200 },
  ));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviarBotaoWhatsapp({ telefone: 'psid-123', numeroWhatsapp: '5516999999999', texto: 'oi' }),
    /não confirmou o envio/,
  );
});

test('HTTP não-2xx da Graph API propaga a mensagem do corpo de erro', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ error: { message: 'token inválido', code: 190 } }),
    { status: 400 },
  ));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviarBotaoWhatsapp({ telefone: 'psid-123', numeroWhatsapp: '5516999999999', texto: 'oi' }),
    /token inválido/,
  );
});

test('sem accessToken/contaComercialId, o cliente fica indisponível e enviarBotaoWhatsapp() recusa', async () => {
  const cliente = criarClienteInstagramEnvio({});
  assert.equal(cliente.disponivel, false);
  await assert.rejects(() => cliente.enviarBotaoWhatsapp({
    telefone: 'psid-123',
    numeroWhatsapp: '5516999999999',
    texto: 'oi',
  }));
});

test('destinatário vazio ou só espaços é recusado antes de chamar a rede', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.enviarBotaoWhatsapp({ telefone: '', numeroWhatsapp: '5516999999999', texto: 'oi' }));
  await assert.rejects(() => cliente.enviarBotaoWhatsapp({ telefone: '   ', numeroWhatsapp: '5516999999999', texto: 'oi' }));
  assert.equal(fetchImpl.chamadas.length, 0);
});
