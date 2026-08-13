'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// O Centro operacional vivia quebrado sem ninguém notar: `GET /api/diagnostico`
// estava no mapa de rotas da Serena, mas o guarda de prefixo (`/api/serena`)
// abortava antes de chegar ao mapa — 404 em produção, com o botão "Verificar
// agora" da tela apontando exatamente para cá. Este arquivo garante que a rota
// responde por HTTP, não só no domínio.

test('GET /api/diagnostico responde 200 para admin, com as quatro sondas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico');
    assert.equal(resposta.status, 200, 'a rota precisa existir por HTTP, não só no mapa');

    const corpo = await resposta.json();
    assert.ok(['ok', 'atencao', 'falha', 'critico'].includes(corpo.nivel), 'a varredura devolve um nível');
    assert.equal(typeof corpo.saudavel, 'boolean');
    assert.ok(Array.isArray(corpo.achados));
    assert.ok(typeof corpo.resumo === 'string' && corpo.resumo.length > 0);
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico recusa quem não gerencia usuários', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'atendente' });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico');
    assert.equal(resposta.status, 403, 'a varredura expõe infraestrutura; atendente não vê');
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico sem sessão é recusado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedirSemAuth('/api/diagnostico');
    assert.equal(resposta.status, 401);
  } finally {
    await ambiente.encerrar();
  }
});

// ------------------------------------------------------------- Comando 4, frente 9
//
// Antes, o diagnóstico só sabia falar do gateway do OpenClaw: sem ele
// pareado, dizia "crítico: nenhum telefone conectado", mesmo com a Evolution
// (o canal primário desde os PRs #30/#31) configurada e respondendo. Estes
// testes provam que a varredura agora sonda a Evolution e ajusta a
// severidade do achado do gateway de acordo — sem fingir estar tudo bem
// quando os DOIS canais estão fora.
//
// `sondaDoCanal` só existe quando `vinculoDoCanal` está configurado (ver
// criarAplicacao em src/servidor/http.js) — sem ele, a sonda nem roda e não
// há achado de canal nenhum, comportamento que já existia antes deste
// comando. Para exercitar o achado, os testes injetam um vínculo falso e
// DESPAREADO — o cenário exato que a Evolution precisa cobrir.
const VINCULO_DESPAREADO = { async estado() { return { vinculado: false, conectado: false, numero: null }; } };

test('Evolution configurada e alcançável: o gateway do OpenClaw despareado vira aviso, não crítico', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({
    EVOLUTION_API_URL: 'https://evolution.exemplo.com',
    EVOLUTION_API_KEY: 'chave-sintetica',
    EVOLUTION_INSTANCE: 'clinica-teste',
  });
  const evolucaoFetchImpl = async () => ({ ok: true, status: 200 });

  const ambiente = await subirServidor({
    repositorio, papel: 'admin', configuracao, evolucaoFetchImpl, vinculoDoCanal: VINCULO_DESPAREADO,
  });
  try {
    const corpo = await (await ambiente.pedir('/api/diagnostico')).json();

    const achadoDoCanal = corpo.achados.find((a) => a.area === 'canal');
    assert.ok(achadoDoCanal, 'o gateway despareado ainda gera achado');
    assert.equal(achadoDoCanal.nivel, 'aviso', 'não pode ser crítico com a Evolution respondendo');
    assert.match(achadoDoCanal.titulo, /Evolution/);

    // Nenhum achado de "evolucao" — ela está saudável.
    assert.ok(!corpo.achados.some((a) => a.area === 'evolucao'));
  } finally {
    await ambiente.encerrar();
  }
});

test('Evolution configurada mas inalcançável: gera achado próprio, crítico se nem o gateway atende', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({
    EVOLUTION_API_URL: 'https://evolution.exemplo.com',
    EVOLUTION_API_KEY: 'chave-sintetica',
  });
  const evolucaoFetchImpl = async () => { throw new Error('ECONNREFUSED'); };

  const ambiente = await subirServidor({
    repositorio, papel: 'admin', configuracao, evolucaoFetchImpl, vinculoDoCanal: VINCULO_DESPAREADO,
  });
  try {
    const corpo = await (await ambiente.pedir('/api/diagnostico')).json();

    const achadoDaEvolucao = corpo.achados.find((a) => a.area === 'evolucao');
    assert.ok(achadoDaEvolucao, 'a Evolution configurada e fora do ar precisa gerar achado');
    // Sem gateway pareado (o padrão de teste) e sem Evolution respondendo:
    // nenhum canal atende — isso é crítico de verdade.
    assert.equal(achadoDaEvolucao.nivel, 'critico');
  } finally {
    await ambiente.encerrar();
  }
});

// ------------------------------------------------------------- Comando 7, achado A-1
//
// A varredura por HTTP precisa incluir a sonda da outbox — sem ela nem
// heartbeat perdido nem trabalho vencido apareciam no painel, porque a rota
// (rotas-diagnostico.js) nunca chamava a sonda nenhuma.

test('GET /api/diagnostico: worker da outbox sem heartbeat vira achado crítico de área "outbox"', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const corpo = await (await ambiente.pedir('/api/diagnostico')).json();
    const achadoDaOutbox = corpo.achados.find((a) => a.area === 'outbox');
    assert.ok(achadoDaOutbox, 'sem heartbeat da outbox registrado, tem que aparecer achado');
    assert.equal(achadoDaOutbox.nivel, 'critico');
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico: worker da outbox com heartbeat recente e fila limpa não gera achado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarBatimentoDoSistema('automacao_outbox_worker', { status: 'ok' });
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const corpo = await (await ambiente.pedir('/api/diagnostico')).json();
    assert.ok(!corpo.achados.some((a) => a.area === 'outbox'));
  } finally {
    await ambiente.encerrar();
  }
});

test('sem Evolution configurada, o comportamento antigo do gateway continua — crítico quando despareado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste();

  const ambiente = await subirServidor({
    repositorio, papel: 'admin', configuracao, vinculoDoCanal: VINCULO_DESPAREADO,
  });
  try {
    const corpo = await (await ambiente.pedir('/api/diagnostico')).json();

    const achadoDoCanal = corpo.achados.find((a) => a.area === 'canal');
    assert.ok(achadoDoCanal);
    assert.equal(achadoDoCanal.nivel, 'critico', 'sem Evolution, o gateway despareado continua crítico');
    assert.ok(!corpo.achados.some((a) => a.area === 'evolucao'), 'sem configuração, não há o que reportar sobre a Evolution');
  } finally {
    await ambiente.encerrar();
  }
});
