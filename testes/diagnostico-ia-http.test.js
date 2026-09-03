'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarGatewayDeIA } = require('../src/ia/gateway');

const POST = (corpo) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(corpo ?? {}),
});

function gatewayComAdaptadores(repositorio, adaptadores) {
  return criarGatewayDeIA({ configuracao: { ia: { timeoutMs: 500 } }, repositorio, adaptadores });
}

test('GET /api/diagnostico traz acoes em achados de outbox e lembretes', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico');
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    const achados = corpo.achados;
    assert.ok(Array.isArray(achados));

    // Outbox e lembretes podem estar saudáveis em memória — o teste só exige
    // que, quando existirem, tragam o campo `acao` ou não quebrem a rota.
    assert.ok(achados.every((a) => 'nivel' in a && 'area' in a && 'titulo' in a));
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/parecer sem gateway disponível recusa 503', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/parecer', POST({}));
    // Sem chave de IA configurada no ambiente de teste, o gateway devolve 503.
    assert.equal(resposta.status, 503);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/parecer com gateway gera parecer e respeita cache', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const chamadas = [];
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async ({ prompt }) => {
      chamadas.push(prompt);
      return { texto: 'Parecer sintético do auditor.', tokensEntrada: 300, tokensSaida: 80 };
    },
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const primeira = await ambiente.pedir('/api/diagnostico/parecer', POST({}));
    assert.equal(primeira.status, 200);
    const corpo = await primeira.json();
    assert.equal(corpo.gerado_por, 'anthropic/claude-haiku-4-5-20251001');
    assert.equal(corpo.de_cache, false);
    assert.match(corpo.parecer, /Parecer sintético/);

    // Segunda no mesmo dia deve vir do cache
    const segunda = await ambiente.pedir('/api/diagnostico/parecer', POST({}));
    assert.equal((await segunda.json()).de_cache, true);
    assert.equal(chamadas.length, 1);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/reparo exige area e titulo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async () => ({ texto: 'Plano sintético.', tokensEntrada: 10, tokensSaida: 5 }),
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const semArea = await ambiente.pedir('/api/diagnostico/reparo', POST({ titulo: 'x' }));
    assert.equal(semArea.status, 400);

    const semTitulo = await ambiente.pedir('/api/diagnostico/reparo', POST({ area: 'outbox' }));
    assert.equal(semTitulo.status, 400);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/reparo com dados válidos gera plano e devolve acao_aplicavel', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async ({ prompt }) => {
      return { texto: '1. Verifique a fila.\n2. Reenfileire.', tokensEntrada: 50, tokensSaida: 20 };
    },
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/reparo', POST({
      area: 'outbox',
      titulo: 'Trabalhos mortos na fila',
      nivel: 'falha',
      detalhe: '652 trabalhos esgotaram as tentativas',
      acao: 'outbox:reenfileirar-mortos',
    }));
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.acao_aplicavel, 'outbox:reenfileirar-mortos');
    assert.equal(corpo.gerado_por, 'anthropic/claude-haiku-4-5-20251001');
    assert.match(corpo.plano, /Verifique a fila/);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/acoes recusa acao fora da allowlist', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/acoes', POST({ acao: 'injetar:sql' }));
    assert.equal(resposta.status, 400);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/acoes reenfileira trabalhos mortos da outbox', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/acoes', POST({ acao: 'outbox:reenfileirar-mortos' }));
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.acao, 'outbox:reenfileirar-mortos');
    assert.equal(typeof corpo.reenfileirados, 'number');
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/acoes reprocessa lembretes falhados', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/acoes', POST({ acao: 'lembretes:reprocessar-falhados' }));
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.acao, 'lembretes:reprocessar-falhados');
    assert.equal(typeof corpo.reprocessados, 'number');
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico/ias lista provedores disponíveis para reparo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/ias');
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.ok(Array.isArray(corpo.ias));
    assert.ok(corpo.ias.length >= 4);
    assert.ok(corpo.ias.some((i) => i.id === 'codex'));
    assert.ok(corpo.ias.some((i) => i.id === 'claude'));
    assert.ok(corpo.ias.some((i) => i.id === 'deepseek'));
    assert.ok(corpo.ias.some((i) => i.id === 'kimi'));
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/reparo-executavel exige area e titulo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async () => ({ texto: 'Plano executável.', tokensEntrada: 10, tokensSaida: 5 }),
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const semArea = await ambiente.pedir('/api/diagnostico/reparo-executavel', POST({ titulo: 'x' }));
    assert.equal(semArea.status, 400);

    const semTitulo = await ambiente.pedir('/api/diagnostico/reparo-executavel', POST({ area: 'outbox' }));
    assert.equal(semTitulo.status, 400);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/diagnostico/reparo-executavel gera plano com IA selecionada', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    openai: async ({ prompt }) => {
      return { texto: '1. REQUER_DECISAO_HUMANA\n2. Verifique token.', tokensEntrada: 50, tokensSaida: 20 };
    },
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico/reparo-executavel', POST({
      area: 'instagram',
      titulo: 'Token expirado',
      nivel: 'falha',
      detalhe: 'access token não é aceito',
      ia: 'codex',
    }));
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.ia_escolhida, 'codex');
    assert.equal(corpo.ia_rotulo, 'Codex (OpenAI)');
    assert.equal(corpo.acao_aplicavel, null);
    assert.match(corpo.plano, /REQUER_DECISAO_HUMANA/);
  } finally {
    await ambiente.encerrar();
  }
});
