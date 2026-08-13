'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteEvolucaoEnvio } = require('../src/integracoes/evolution-envio');

const CONFIG = Object.freeze({
  apiUrl: 'https://evo.exemplo.com',
  apiKey: 'chave-sintetica',
  instancia: 'clinica',
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

test('sem apiUrl/apiKey/instancia, o cliente fica indisponível e enviar() recusa', async () => {
  const cliente = criarClienteEvolucaoEnvio({});
  assert.equal(cliente.disponivel, false);
  await assert.rejects(() => cliente.enviar({ telefone: '5511999990000', texto: 'oi' }));
});

test('envia POST /message/sendText/{instancia} com apikey no header e number sem +', async () => {
  const fetchImpl = fetchFalso(async () => new Response(JSON.stringify({ key: { id: 'MSG123' } }), { status: 201 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  const resultado = await cliente.enviar({ telefone: '5511999990000', texto: 'Olá!' });
  assert.equal(resultado.identificador, 'MSG123');

  assert.equal(fetchImpl.chamadas.length, 1);
  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://evo.exemplo.com/message/sendText/clinica');
  assert.equal(opcoes.method, 'POST');
  assert.equal(opcoes.headers.apikey, 'chave-sintetica');
  const corpo = JSON.parse(opcoes.body);
  assert.equal(corpo.number, '5511999990000');
  assert.equal(corpo.text, 'Olá!');
  assert.deepEqual(corpo.options, { delay: 1200, presence: 'composing' });
});

test('HTTP não-2xx vira erro com o status e o corpo', async () => {
  const fetchImpl = fetchFalso(async () => new Response('instância desconectada', { status: 400 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: '5511999990000', texto: 'oi' }),
    /HTTP 400/,
  );
});

test('falha de rede vira erro descritivo, não exceção crua', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviar({ telefone: '5511999990000', texto: 'oi' }),
    /falha de rede/,
  );
});

test('telefone vazio ou só símbolos é recusado antes de chamar a rede', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.enviar({ telefone: '', texto: 'oi' }));
  await assert.rejects(() => cliente.enviar({ telefone: '+--', texto: 'oi' }));
  assert.equal(fetchImpl.chamadas.length, 0);
});
