'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarGatewayDeIA } = require('../src/ia/gateway');

// As rotas da frente de IA por HTTP: menu de modelos, relatório com fallback
// determinístico, assistente por aba, telemetria restrita e notificações.

const POST = (corpo) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(corpo ?? {}),
});

function gatewayComAdaptadores(repositorio, adaptadores) {
  return criarGatewayDeIA({ configuracao: { ia: { timeoutMs: 500 } }, repositorio, adaptadores });
}

test('GET /api/ia/modelos devolve o menu por provedor, com modelos dependentes', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/ia/modelos');
    assert.equal(resposta.status, 200);

    const { provedores } = await resposta.json();
    const nomes = provedores.map((linha) => linha.provedor).sort();
    assert.deepEqual(nomes, ['anthropic', 'deepseek', 'google', 'kimi', 'openai']);

    const anthropic = provedores.find((linha) => linha.provedor === 'anthropic');
    assert.ok(anthropic.modelos.length >= 2, 'o menu de modelo depende do provedor');
    assert.equal(anthropic.disponivel, false, 'sem chave no servidor de teste');
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/ia/relatorio sem provedor disponível cai no relatório determinístico', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedir('/api/ia/relatorio', POST({}));
    assert.equal(resposta.status, 200, 'o botão nunca quebra por falta de chave');

    const corpo = await resposta.json();
    assert.equal(corpo.gerado_por, 'deterministico');
    assert.equal(corpo.motivo_fallback, 'ia_indisponivel');
    assert.match(corpo.relatorio, /Relatório do período/);
    assert.match(corpo.relatorio, /America\/Sao_Paulo/);
  } finally {
    await ambiente.encerrar();
  }
});

test('POST /api/ia/relatorio com provedor: gera, registra telemetria e repete do cache', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const chamadas = [];
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async ({ prompt }) => {
      chamadas.push(prompt);
      return { texto: 'Relatório gerencial sintético.', tokensEntrada: 500, tokensSaida: 120 };
    },
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const primeira = await ambiente.pedir('/api/ia/relatorio', POST({}));
    const corpo = await primeira.json();
    assert.equal(corpo.gerado_por, 'anthropic/claude-haiku-4-5-20251001');
    assert.equal(corpo.de_cache, false);

    // O prompt leva os NÚMEROS agregados, nunca conteúdo de paciente.
    assert.match(chamadas[0], /DADOS:/);
    assert.ok(!/telefone.*55\d{10}/.test(chamadas[0]), 'nenhum telefone de paciente no prompt');

    const segunda = await ambiente.pedir('/api/ia/relatorio', POST({}));
    assert.equal((await segunda.json()).de_cache, true, 'clicar de novo no mesmo dia não paga de novo');
    assert.equal(chamadas.length, 1);
  } finally {
    await ambiente.encerrar();
  }
});

test('assistente por aba: aba fora da allowlist é recusada; a permitida responde', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gatewayDeIA = gatewayComAdaptadores(repositorio, {
    anthropic: async () => ({ texto: 'Os leads cresceram.', tokensEntrada: 10, tokensSaida: 5 }),
  });
  const ambiente = await subirServidor({ repositorio, gatewayDeIA });
  try {
    const invalida = await ambiente.pedir('/api/ia/assistente', POST({ aba: 'prontuario', pergunta: 'x' }));
    assert.equal(invalida.status, 400, 'aba desconhecida não ganha assistente');

    const valida = await ambiente.pedir('/api/ia/assistente', POST({
      aba: 'metricas', pergunta: 'Como estão os leads da semana?',
    }));
    assert.equal(valida.status, 200);
    assert.equal((await valida.json()).aba, 'metricas');
  } finally {
    await ambiente.encerrar();
  }
});

test('telemetria: gestor lê sem o texto das respostas; atendente é recusado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarChamadaDeIA({
    chaveIdempotencia: 'k1', finalidade: 'teste', provedor: 'anthropic',
    modelo: 'claude-haiku-4-5-20251001', resposta: 'CONTEUDO-QUE-NAO-SAI',
  });

  const ambiente = await subirServidor({ repositorio, papel: 'gestor', master: false });
  try {
    const resposta = await ambiente.pedir('/api/ia/chamadas');
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.total, 1);
    assert.ok(!JSON.stringify(corpo).includes('CONTEUDO-QUE-NAO-SAI'),
      'telemetria é metadado; o texto não trafega na listagem');

    const atendente = await ambiente.entrarComo('atendente');
    const recusada = await ambiente.pedirSemAuth('/api/ia/chamadas', {
      headers: { authorization: `Bearer ${atendente.access_token}` },
    });
    assert.equal(recusada.status, 403);
  } finally {
    await ambiente.encerrar();
  }
});

test('central de notificações: lista, marca lida uma vez, e some da lista de não lidas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    await repositorio.criarNotificacao({
      chave: 'teste:1', tipo: 'avaliacao_ia', titulo: 'Resposta reprovada',
    });

    const lista = await (await ambiente.pedir('/api/notificacoes')).json();
    assert.equal(lista.total, 1);

    const lida = await ambiente.pedir(`/api/notificacoes/${lista.notificacoes[0].id}/lida`, POST({}));
    assert.equal(lida.status, 200);

    const denovo = await ambiente.pedir(`/api/notificacoes/${lista.notificacoes[0].id}/lida`, POST({}));
    assert.equal(denovo.status, 404, 'marcar lida duas vezes não é sucesso silencioso');

    const vazia = await (await ambiente.pedir('/api/notificacoes')).json();
    assert.equal(vazia.total, 0);
  } finally {
    await ambiente.encerrar();
  }
});

test('avaliações por HTTP: varrer exige serena:gerenciar; a lista sai por veredito', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const contato = await repositorio.encontrarOuCriarContato({
      telefone: '5511955550001', nome: 'P', canal: 'whatsapp',
    });
    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
    await repositorio.registrarMensagem(conversa.id, {
      direcao: 'saida', conteudo: 'Você tem sinusite, tome antibiótico.', autor_tipo: 'automacao',
    });

    const varrida = await ambiente.pedir('/api/ia/avaliacoes/varrer', POST({}));
    assert.equal(varrida.status, 200);
    assert.equal((await varrida.json()).reprovadas, 1);

    const reprovadas = await (await ambiente.pedir('/api/ia/avaliacoes?veredito=reprovada')).json();
    assert.equal(reprovadas.total, 1);
    assert.equal(reprovadas.avaliacoes[0].veredito, 'reprovada');
  } finally {
    await ambiente.encerrar();
  }
});
