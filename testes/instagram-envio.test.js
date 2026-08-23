'use strict';

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

test('sem accessToken/contaComercialId, o cliente fica indisponível e enviar() recusa', async () => {
  const cliente = criarClienteInstagramEnvio({});
  assert.equal(cliente.disponivel, false);
  await assert.rejects(() => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }));
});

test('envia POST /{apiVersion}/me/messages com Bearer no header e recipient/message no corpo', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ recipient_id: 'psid-123', message_id: 'mid.MSG123' }),
    { status: 200 },
  ));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  const resultado = await cliente.enviar({ telefone: 'psid-123', texto: 'Olá!' });
  assert.equal(resultado.identificador, 'mid.MSG123');

  assert.equal(fetchImpl.chamadas.length, 1);
  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://graph.instagram.com/v23.0/me/messages');
  assert.equal(opcoes.method, 'POST');
  assert.equal(opcoes.headers.authorization, 'Bearer token-sintetico');
  const corpo = JSON.parse(opcoes.body);
  assert.deepEqual(corpo.recipient, { id: 'psid-123' });
  assert.deepEqual(corpo.message, { text: 'Olá!' });
});

test('apiVersion customizado é usado na URL', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ recipient_id: 'psid-123', message_id: 'mid.MSG123' }),
    { status: 200 },
  ));
  const cliente = criarClienteInstagramEnvio({ ...CONFIG, apiVersion: 'v20.0' }, { fetchImpl });

  await cliente.enviar({ telefone: 'psid-123', texto: 'oi' });

  const [{ url }] = fetchImpl.chamadas;
  assert.equal(url, 'https://graph.instagram.com/v20.0/me/messages');
});

test('resposta sem message_id lança erro (Graph API não confirmou o envio)', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ recipient_id: 'psid-123' }),
    { status: 200 },
  ));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
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
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    /token inválido/,
  );
});

test('HTTP não-2xx sem corpo de erro decodificável cai no fallback com o status', async () => {
  const fetchImpl = fetchFalso(async () => new Response('não é json', { status: 500 }));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    /HTTP 500/,
  );
});

test('falha de rede vira erro descritivo, não exceção crua', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    /falha de rede/,
  );
});

test('recusa de conexão (ECONNREFUSED) não é indeterminada — seguro retentar', async () => {
  const fetchImpl = async () => {
    const erro = new Error('connect ECONNREFUSED');
    erro.code = 'ECONNREFUSED';
    throw erro;
  };
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    (erro) => erro.indeterminado === false || erro.indeterminado === undefined,
  );
});

test('timeout (TimeoutError) é classificado como indeterminado', async () => {
  const fetchImpl = async () => {
    const erro = new Error('The operation was aborted due to timeout');
    erro.name = 'TimeoutError';
    throw erro;
  };
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    (erro) => erro.indeterminado === true,
  );
});

test('ECONNRESET pós-envio (erro.code direto) é indeterminado', async () => {
  const fetchImpl = async () => {
    const erro = new Error('socket hang up');
    erro.code = 'ECONNRESET';
    throw erro;
  };
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    (erro) => erro.indeterminado === true,
  );
});

test('ECONNRESET pós-envio (erro.cause.code, formato do fetch nativo) é indeterminado', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  };
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: 'psid-123', texto: 'oi' }),
    (erro) => erro.indeterminado === true,
  );
});

test('destinatário vazio ou só espaços é recusado antes de chamar a rede', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.enviar({ telefone: '', texto: 'oi' }));
  await assert.rejects(() => cliente.enviar({ telefone: '   ', texto: 'oi' }));
  assert.equal(fetchImpl.chamadas.length, 0);
});

test('encerrar() existe e resolve sem lançar (cliente é stateless)', async () => {
  const cliente = criarClienteInstagramEnvio(CONFIG, { fetchImpl: fetchFalso(async () => new Response('{}')) });
  await assert.doesNotReject(() => cliente.encerrar());
});
