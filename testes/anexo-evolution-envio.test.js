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

test('enviarMidia: envia POST /message/sendMedia/{instancia} com mediatype mapeado de "imagem"', async () => {
  const fetchImpl = fetchFalso(async () => new Response(JSON.stringify({ key: { id: 'MSG-MIDIA-1' } }), { status: 201 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  const resultado = await cliente.enviarMidia({
    telefone: '5511999990000', mediaUrl: 'https://storage.exemplo.com/f.png', tipo: 'imagem', legenda: 'olha só',
  });
  assert.equal(resultado.identificador, 'MSG-MIDIA-1');

  assert.equal(fetchImpl.chamadas.length, 1);
  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://evo.exemplo.com/message/sendMedia/clinica');
  assert.equal(opcoes.method, 'POST');
  assert.equal(opcoes.headers.apikey, 'chave-sintetica');
  const corpo = JSON.parse(opcoes.body);
  assert.equal(corpo.number, '5511999990000');
  assert.equal(corpo.mediatype, 'image');
  assert.equal(corpo.media, 'https://storage.exemplo.com/f.png');
  assert.equal(corpo.caption, 'olha só');
});

test('enviarMidia: mapeia documento/audio/video para os mediatype certos', async () => {
  const casos = [['documento', 'document'], ['audio', 'audio'], ['video', 'video']];
  for (const [tipo, mediatype] of casos) {
    const fetchImpl = fetchFalso(async () => new Response(JSON.stringify({ id: 'x' }), { status: 201 }));
    const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });
    // eslint-disable-next-line no-await-in-loop
    await cliente.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo });
    const corpo = JSON.parse(fetchImpl.chamadas[0].opcoes.body);
    assert.equal(corpo.mediatype, mediatype, `tipo ${tipo} deveria virar mediatype ${mediatype}`);
  }
});

test('enviarMidia: tipo fora do vocabulário conhecido é recusado antes de chamar a rede', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo: 'sistema' }),
    /tipo de mídia não suportado/,
  );
  assert.equal(fetchImpl.chamadas.length, 0);
});

test('enviarMidia: sem mediaUrl é recusado antes de chamar a rede', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviarMidia({ telefone: '5511999990000', mediaUrl: '', tipo: 'imagem' }),
    /mediaUrl é obrigatório/,
  );
  assert.equal(fetchImpl.chamadas.length, 0);
});

test('enviarMidia: HTTP não-2xx vira erro com o status', async () => {
  const fetchImpl = fetchFalso(async () => new Response('instância desconectada', { status: 400 }));
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await assert.rejects(
    () => cliente.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo: 'imagem' }),
    /HTTP 400/,
  );
});

test('enviarMidia: cliente sem apiUrl/apiKey/instancia recusa sem chamar a rede', async () => {
  const cliente = criarClienteEvolucaoEnvio({});
  await assert.rejects(() => cliente.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo: 'imagem' }));
});
