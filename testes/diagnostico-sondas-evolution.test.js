'use strict';

// Comando 4, frente 9 — sondaDaEvolution, usada tanto por
// src/servidor/rotas-diagnostico.js (centro operacional, sob demanda) quanto
// por bin/worker-heartbeat.js (batimento contínuo). Sem teste de domínio
// dedicado até este comando — os únicos testes que cobriam este arquivo
// passavam por HTTP inteiro.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sondaDaEvolution } = require('../src/dominio/diagnostico-sondas');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('sem EVOLUTION_API_URL/KEY, a sonda não tenta rede nenhuma', async () => {
  let fetchChamado = false;
  const sonda = sondaDaEvolution(null, { fetchImpl: async () => { fetchChamado = true; return { ok: true }; } });

  const resultado = await sonda();

  assert.deepEqual(resultado, { configurada: false, instancia: null, alcancavel: null, fila: null });
  assert.equal(fetchChamado, false);
});

test('configurada e o host responde: alcançável', async () => {
  const sonda = sondaDaEvolution(
    { apiUrl: 'https://evolution.exemplo.com', apiKey: 'chave', instancia: 'clinica' },
    { fetchImpl: async () => ({ ok: true, status: 200 }) },
  );

  const resultado = await sonda();

  assert.equal(resultado.configurada, true);
  assert.equal(resultado.instancia, 'clinica');
  assert.equal(resultado.alcancavel, true);
});

test('configurada e a chamada falha (rede fora do ar): não alcançável, sem lançar', async () => {
  const sonda = sondaDaEvolution(
    { apiUrl: 'https://evolution.exemplo.com', apiKey: 'chave' },
    { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
  );

  const resultado = await sonda();

  assert.equal(resultado.configurada, true);
  assert.equal(resultado.alcancavel, false);
});

test('qualquer resposta HTTP conta como alcançável — mesmo 401/404, já que a rota exata da API não é presumida', async () => {
  const sonda = sondaDaEvolution(
    { apiUrl: 'https://evolution.exemplo.com', apiKey: 'chave' },
    { fetchImpl: async () => ({ ok: false, status: 404 }) },
  );

  const resultado = await sonda();
  assert.equal(resultado.alcancavel, true, 'o host respondeu — é isso que "alcançável" verifica');
});

test('com repositório, a fila da outbox acompanha o resultado (sinal real de entrega recente)', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: 1, mensagemEntradaId: 1, chaveIdempotencia: 'x:1' });

  const sonda = sondaDaEvolution(
    { apiUrl: 'https://evolution.exemplo.com', apiKey: 'chave' },
    { fetchImpl: async () => ({ ok: true }), repositorio },
  );

  const resultado = await sonda();
  assert.equal(resultado.fila.pendente, 1);
});

test('sem repositório, a fila vem null — não inventa contagem', async () => {
  const sonda = sondaDaEvolution(
    { apiUrl: 'https://evolution.exemplo.com', apiKey: 'chave' },
    { fetchImpl: async () => ({ ok: true }) },
  );

  const resultado = await sonda();
  assert.equal(resultado.fila, null);
});
