'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteStorage } = require('../src/integracoes/supabase-storage');

const CONFIG = Object.freeze({
  supabaseUrl: 'https://proj.supabase.co',
  chaveServico: 'chave-servico-sintetica',
  bucket: 'anexos-conversas',
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

test('sem supabaseUrl/chaveServico, o cliente fica indisponível e as duas operações recusam', async () => {
  const cliente = criarClienteStorage({});
  assert.equal(cliente.disponivel, false);
  await assert.rejects(() => cliente.gerarUploadAssinado('conversas/1/x.png'));
  await assert.rejects(() => cliente.gerarLeituraAssinada('conversas/1/x.png'));
});

test('gerarUploadAssinado: chama /object/upload/sign/{bucket}/{caminho} com Bearer e devolve URL absoluta', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ url: '/object/upload/sign/anexos-conversas/conversas/1/x.png?token=abc' }),
    { status: 200 },
  ));
  const cliente = criarClienteStorage(CONFIG, { fetchImpl });

  const { urlDeUpload } = await cliente.gerarUploadAssinado('conversas/1/x.png');
  assert.equal(urlDeUpload, 'https://proj.supabase.co/storage/v1/object/upload/sign/anexos-conversas/conversas/1/x.png?token=abc');

  assert.equal(fetchImpl.chamadas.length, 1);
  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://proj.supabase.co/storage/v1/object/upload/sign/anexos-conversas/conversas/1/x.png');
  assert.equal(opcoes.headers.apikey, 'chave-servico-sintetica');
  assert.equal(opcoes.headers.authorization, 'Bearer chave-servico-sintetica');
});

test('gerarLeituraAssinada: chama /object/sign/{bucket}/{caminho} com expiresIn e devolve URL absoluta', async () => {
  const fetchImpl = fetchFalso(async (url, opcoes) => {
    const corpo = JSON.parse(opcoes.body);
    assert.equal(corpo.expiresIn, 900);
    return new Response(JSON.stringify({ signedURL: '/object/sign/anexos-conversas/conversas/1/x.png?token=zzz' }), { status: 200 });
  });
  const cliente = criarClienteStorage(CONFIG, { fetchImpl });

  const url = await cliente.gerarLeituraAssinada('conversas/1/x.png', 900);
  assert.equal(url, 'https://proj.supabase.co/storage/v1/object/sign/anexos-conversas/conversas/1/x.png?token=zzz');
});

test('HTTP não-2xx vira erro com o status', async () => {
  const fetchImpl = fetchFalso(async () => new Response('bucket não encontrado', { status: 404 }));
  const cliente = criarClienteStorage(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.gerarUploadAssinado('conversas/1/x.png'), /HTTP 404/);
});

test('resposta sem "url"/"signedURL" vira erro claro, não undefined silencioso', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteStorage(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.gerarUploadAssinado('conversas/1/x.png'), /não devolveu URL/);
});
