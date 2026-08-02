'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarProvedorKimi } = require('../src/provedores/kimi');

// Nenhum teste aqui usa chave real nem faz requisição de rede.

test('sem chave, o provedor se declara indisponível e não chama a rede', async () => {
  let chamou = false;
  const provedor = criarProvedorKimi({}, { fetch: async () => { chamou = true; } });

  assert.equal(provedor.disponivel, false);
  assert.equal(provedor.papel, 'provedor opcional de modelo');

  await assert.rejects(
    () => provedor.completar([{ role: 'user', content: 'oi' }]),
    (erro) => erro.codigo === 'kimi_nao_configurado',
  );
  assert.equal(chamou, false);
});

test('com chave sintética, monta a requisição esperada', async () => {
  const chamadas = [];
  const provedor = criarProvedorKimi(
    { chave: 'chave-sintetica-de-teste', modelo: 'modelo-de-teste' },
    {
      fetch: async (url, opcoes) => {
        chamadas.push({ url, opcoes });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'resposta' } }] }) };
      },
    },
  );

  assert.equal(provedor.disponivel, true);
  assert.equal(await provedor.completar([{ role: 'user', content: 'oi' }]), 'resposta');

  const [chamada] = chamadas;
  assert.equal(chamada.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(chamada.opcoes.headers.authorization, 'Bearer chave-sintetica-de-teste');
  assert.equal(JSON.parse(chamada.opcoes.body).model, 'modelo-de-teste');
});

test('erro HTTP e resposta vazia viram falhas explícitas', async () => {
  const comErro = criarProvedorKimi(
    { chave: 'chave-sintetica-de-teste' },
    { fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) },
  );
  await assert.rejects(
    () => comErro.completar([{ role: 'user', content: 'oi' }]),
    (erro) => erro.codigo === 'kimi_resposta_invalida' && erro.status === 429,
  );

  const semConteudo = criarProvedorKimi(
    { chave: 'chave-sintetica-de-teste' },
    { fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) },
  );
  await assert.rejects(() => semConteudo.completar([{ role: 'user', content: 'oi' }]), /sem conteúdo/);
});

test('lista de mensagens vazia é recusada antes de qualquer requisição', async () => {
  let chamou = false;
  const provedor = criarProvedorKimi(
    { chave: 'chave-sintetica-de-teste' },
    { fetch: async () => { chamou = true; return { ok: true, json: async () => ({}) }; } },
  );

  await assert.rejects(() => provedor.completar([]), /lista não vazia/);
  assert.equal(chamou, false);
});
