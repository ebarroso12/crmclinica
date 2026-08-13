'use strict';

// Comando 4, frente 8 — GET /api/serena/canal precisa dizer a verdade sobre
// o canal EFETIVO (Evolution), não só sobre o gateway do OpenClaw.
//
// Achado do Comando 1: o painel podia anunciar "conexão indisponível" com o
// gateway do OpenClaw despareado, mesmo com a Evolution API configurada e
// entregando mensagens de verdade — porque a rota só sabia falar de
// `vinculo` (OpenClaw). Agora ela sempre devolve também `evolucao`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

test('sem gateway do OpenClaw e sem Evolution configurada, os dois dizem "não configurado"', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste();
  const ambiente = await subirServidor({ repositorio, configuracao });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/serena/canal');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.disponivel, false, 'sem gateway do OpenClaw pareado');
  assert.equal(corpo.evolucao.configurada, false, 'sem EVOLUTION_API_URL/KEY');
});

test('sem gateway do OpenClaw, mas COM Evolution configurada, o painel não pode esconder que o canal efetivo funciona', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({
    EVOLUTION_API_URL: 'https://evolution.exemplo.com',
    EVOLUTION_API_KEY: 'chave-sintetica-de-teste',
    EVOLUTION_INSTANCE: 'clinica-teste',
  });
  const ambiente = await subirServidor({ repositorio, configuracao });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/serena/canal');
  const corpo = await resposta.json();

  // O campo antigo continua honesto sobre o GATEWAY do OpenClaw (que
  // realmente não está pareado) — o que muda é que agora existe informação
  // suficiente para a tela não dizer só "indisponível" quando a Evolution já
  // está entregando.
  assert.equal(corpo.disponivel, false, 'o gateway do OpenClaw continua não pareado');
  assert.equal(corpo.evolucao.configurada, true);
  assert.equal(corpo.evolucao.instancia, 'clinica-teste');
});

test('com o gateway do OpenClaw pareado, o campo evolucao continua presente ao lado dele', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const vinculoFalso = {
    async estado() { return { vinculado: true, conectado: true, numero: '5516999999999' }; },
  };
  const configuracao = configuracaoDeTeste({
    EVOLUTION_API_URL: 'https://evolution.exemplo.com',
    EVOLUTION_API_KEY: 'chave-sintetica-de-teste',
  });
  const ambiente = await subirServidor({ repositorio, configuracao, vinculoDoCanal: vinculoFalso });
  t.after(() => ambiente.encerrar());

  const corpo = await (await ambiente.pedir('/api/serena/canal')).json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.vinculado, true);
  assert.equal(corpo.evolucao.configurada, true);
});

test('sem sessão nenhuma, a rota recusa', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste();
  const ambiente = await subirServidor({ repositorio, configuracao });
  t.after(() => ambiente.encerrar());

  const semNenhumPapel = await ambiente.pedirSemAuth('/api/serena/canal');
  assert.equal(semNenhumPapel.status, 401);
});
