'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRegistroEmMemoria } = require('../src/armazenamento/idempotencia');

// Segredo sintético de teste. Não corresponde a nenhum ambiente real.
const SEGREDO = 'segredo-sintetico-de-webhook-do-chatwoot';

function chatwootFalso() {
  const acoes = [];
  return {
    disponivel: true,
    contaId: '1',
    inboxId: '3',
    timeId: '2',
    acoes,
    listarConversas: async ({ fila, estado }) => {
      acoes.push({ acao: 'listar', fila, estado });
      return {
        fila,
        rotulo: 'Não atribuídas',
        total: 1,
        conversas: [{
          id: 4678,
          estado: 'open',
          prioridade: 'high',
          etiquetas: ['avaliacao'],
          tipoDeCanal: 'Channel::Whatsapp',
          ultimaAtividadeEm: new Date().toISOString(),
          contato: { id: 55, nome: 'Marina', telefone: '+5516999999999' },
        }],
      };
    },
    obterConversa: async (id) => ({
      id,
      estado: 'open',
      prioridade: 'high',
      etiquetas: ['avaliacao'],
      tipoDeCanal: 'Channel::Whatsapp',
      contato: { id: 55, nome: 'Marina', telefone: '+5516999999999' },
    }),
    listarMensagens: async () => [{ id: 1, texto: 'Olá', autor: 'contato', privada: false }],
    obterContato: async (id) => ({ id, nome: 'Marina', telefone: '+5516999999999', atributos: {} }),
    listarConversasDoContato: async () => [{ id: 4000, estado: 'resolved', ultimaAtividadeEm: null }],
    listarNotas: async () => [{ id: 1, texto: 'ligou antes' }],
    responder: async (id, texto, opcoes) => { acoes.push({ acao: 'responder', id, texto, ...opcoes }); return { id: 9 }; },
    atribuirAgente: async (id, agenteId) => { acoes.push({ acao: 'agente', id, agenteId }); return { ok: true }; },
    atribuirTime: async (id, timeId) => { acoes.push({ acao: 'time', id, timeId }); return { ok: true }; },
    definirPrioridade: async (id, p) => { acoes.push({ acao: 'prioridade', id, p }); return { ok: true }; },
    definirEstado: async (id, e) => { acoes.push({ acao: 'estado', id, e }); return { ok: true }; },
    listarEtiquetasDaConversa: async () => ['avaliacao', 'lead_frio'],
    definirEtiquetas: async (id, lista) => { acoes.push({ acao: 'etiquetas', id, lista }); return { ok: true }; },
    criarNota: async (id, texto) => { acoes.push({ acao: 'nota', id, texto }); return { ok: true }; },
    verificarSaude: async () => ({ estado: 'operacional' }),
    garantirEtiquetasDeTemperatura: async () => ({ criadas: ['lead_morno'], preservadas: ['avaliacao'] }),
  };
}

function orquestradorFalso() {
  return {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'Olá!' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

async function subirComInbox(sobrescritas = {}) {
  const chatwoot = chatwootFalso();
  const app = await subirServidor({
    chatwoot,
    orquestrador: orquestradorFalso(),
    idempotencia: criarRegistroEmMemoria(),
    configuracao: configuracaoDeTeste(sobrescritas),
  });
  return { app, chatwoot };
}

function postar(app, caminho, corpo, cabecalhos = {}) {
  return app.pedir(caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

test('GET /api/conversas/filas descreve as três filas e o vocabulário', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/conversas/filas')).json();

  assert.deepEqual(dados.filas.map((f) => f.rotulo), ['Minhas', 'Não atribuídas', 'Todos']);
  assert.deepEqual(dados.temperaturas, ['quente', 'morno', 'frio']);
  assert.ok(dados.prioridades.includes('urgent'));
});

test('GET /api/conversas lista a fila pedida', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/conversas?fila=minhas&estado=open');
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');

  const dados = await resposta.json();
  assert.equal(dados.conversas[0].id, 4678);
  assert.deepEqual(chatwoot.acoes[0], { acao: 'listar', fila: 'minhas', estado: 'open' });
});

test('fila ou estado desconhecido responde 400', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/api/conversas?fila=inventada')).status, 400);
  assert.equal((await app.pedir('/api/conversas?estado=inventado')).status, 400);
});

test('GET /api/conversas/:id devolve thread, ficha e lead juntos', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/conversas/4678')).json();

  assert.equal(dados.conversa.id, 4678);
  assert.equal(dados.mensagens.length, 1);
  assert.equal(dados.ficha.telefone, '+5516999999999');
  assert.equal(dados.ficha.notas.length, 1);
  assert.equal(dados.ficha.conversas_anteriores.length, 1);
  assert.equal(dados.lead.origem, 'WHATSAPP');
  assert.equal(dados.lead.prioridade, 'ALTA');
});

test('identificador inválido de conversa responde 400', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/api/conversas/abc')).status, 400);
  assert.equal((await app.pedir('/api/conversas/-1')).status, 400);
});

test('resposta humana chega ao Chatwoot; nota vai como privada', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  assert.equal((await postar(app, '/api/conversas/4678/mensagens', { texto: 'Bom dia!' })).status, 200);
  await postar(app, '/api/conversas/4678/mensagens', { texto: 'interna', privada: true });

  const respostas = chatwoot.acoes.filter((acao) => acao.acao === 'responder');
  assert.equal(respostas[0].texto, 'Bom dia!');
  assert.equal(respostas[0].privada, false);
  assert.equal(respostas[1].privada, true);
});

test('mensagem sem texto responde 400', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const resposta = await postar(app, '/api/conversas/4678/mensagens', { texto: '   ' });
  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).campo, 'texto');
});

test('atribuição aceita agente ou time e recusa corpo vazio', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  await postar(app, '/api/conversas/4678/atribuicao', { agente_id: 7 });
  await postar(app, '/api/conversas/4678/atribuicao', { time_id: 2 });
  assert.equal((await postar(app, '/api/conversas/4678/atribuicao', {})).status, 400);

  assert.equal(chatwoot.acoes.find((a) => a.acao === 'agente').agenteId, 7);
  assert.equal(chatwoot.acoes.find((a) => a.acao === 'time').timeId, 2);
});

test('prioridade e estado usam vocabulário fechado', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  assert.equal((await postar(app, '/api/conversas/4678/prioridade', { prioridade: 'urgent' })).status, 200);
  assert.equal((await postar(app, '/api/conversas/4678/prioridade', { prioridade: 'altissima' })).status, 400);

  // Resolver e reabrir.
  assert.equal((await postar(app, '/api/conversas/4678/estado', { estado: 'resolved' })).status, 200);
  assert.equal((await postar(app, '/api/conversas/4678/estado', { estado: 'open' })).status, 200);
  assert.equal((await postar(app, '/api/conversas/4678/estado', { estado: 'arquivada' })).status, 400);

  const estados = chatwoot.acoes.filter((a) => a.acao === 'estado').map((a) => a.e);
  assert.deepEqual(estados, ['resolved', 'open']);
});

test('temperatura preserva as etiquetas existentes', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  const resposta = await postar(app, '/api/conversas/4678/temperatura', { temperatura: 'quente' });
  assert.equal(resposta.status, 200);

  const etiquetas = chatwoot.acoes.find((a) => a.acao === 'etiquetas').lista;
  assert.deepEqual(etiquetas, ['avaliacao', 'lead_quente']);
  assert.equal((await postar(app, '/api/conversas/4678/temperatura', { temperatura: 'gelada' })).status, 400);
});

test('nota é gravada na ficha do contato', async (t) => {
  const { app, chatwoot } = await subirComInbox();
  t.after(() => app.encerrar());

  const dados = await (await postar(app, '/api/conversas/4678/notas', { texto: 'paciente pediu retorno' })).json();
  assert.equal(dados.contato_id, 55);
  assert.equal(chatwoot.acoes.find((a) => a.acao === 'nota').texto, 'paciente pediu retorno');
});

test('GET /api/leads monta o kanban a partir do inbox', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/leads')).json();
  assert.equal(dados.total, 1);
  assert.deepEqual(dados.colunas.map((c) => c.estado), ['NOVO', 'CONTATADO', 'AGENDADO', 'CONVERTIDO', 'PERDIDO']);
  assert.equal(dados.colunas[0].leads[0].telefone, '+5516999999999');
});

test('sem Chatwoot configurado, as rotas respondem 503 em vez de quebrar', async (t) => {
  const app = await subirServidor({ configuracao: configuracaoDeTeste() });
  t.after(() => app.encerrar());

  for (const rota of ['/api/conversas', '/api/conversas/4678', '/api/leads']) {
    const resposta = await app.pedir(rota);
    assert.equal(resposta.status, 503, `rota ${rota}`);
    assert.equal((await resposta.json()).codigo, 'chatwoot_nao_configurado');
  }
});

// ---------- Webhook do Chatwoot ----------

const EVENTO_WEBHOOK = {
  event: 'message_created',
  id: 991,
  content: 'Quero agendar uma avaliação',
  message_type: 'incoming',
  created_at: 1_785_000_000,
  conversation: { id: 4678, status: 'open', labels: [] },
  sender: { id: 55, name: 'Marina', phone_number: '+5516999999999' },
  inbox: { id: 3, channel_type: 'Channel::Whatsapp' },
};

function assinar(corpo, segredo) {
  return crypto.createHmac('sha256', segredo).update(corpo).digest('hex');
}

test('webhook autenticado é aceito e a resposta volta ao Chatwoot', async (t) => {
  const { app, chatwoot } = await subirComInbox({ CHATWOOT_WEBHOOK_SECRET: SEGREDO });
  t.after(() => app.encerrar());

  const corpo = JSON.stringify(EVENTO_WEBHOOK);
  const resposta = await postar(app, '/api/webhooks/chatwoot', corpo, {
    'x-chatwoot-assinatura': assinar(corpo, SEGREDO),
  });

  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.decisao, 'respondido_pela_automacao');
  assert.ok(chatwoot.acoes.some((a) => a.acao === 'responder'));
});

test('webhook sem assinatura válida responde 401 e nada é processado', async (t) => {
  const { app, chatwoot } = await subirComInbox({ CHATWOOT_WEBHOOK_SECRET: SEGREDO });
  t.after(() => app.encerrar());

  const corpo = JSON.stringify(EVENTO_WEBHOOK);

  assert.equal((await postar(app, '/api/webhooks/chatwoot', corpo)).status, 401);
  assert.equal(
    (await postar(app, '/api/webhooks/chatwoot', corpo, { 'x-chatwoot-assinatura': assinar(corpo, 'outro') })).status,
    401,
  );
  // Corpo adulterado com assinatura do corpo original.
  const adulterado = JSON.stringify({ ...EVENTO_WEBHOOK, content: 'outra coisa' });
  assert.equal(
    (await postar(app, '/api/webhooks/chatwoot', adulterado, { 'x-chatwoot-assinatura': assinar(corpo, SEGREDO) })).status,
    401,
  );

  assert.equal(chatwoot.acoes.length, 0, 'nada não autenticado pode gerar ação');
});

test('webhook aceita token compartilhado no cabeçalho', async (t) => {
  const { app } = await subirComInbox({ CHATWOOT_WEBHOOK_SECRET: SEGREDO });
  t.after(() => app.encerrar());

  const resposta = await postar(app, '/api/webhooks/chatwoot', EVENTO_WEBHOOK, { 'x-crmclinica-token': SEGREDO });
  assert.equal(resposta.status, 202);
});

test('reentrega do mesmo webhook é idempotente', async (t) => {
  const { app, chatwoot } = await subirComInbox({ CHATWOOT_WEBHOOK_SECRET: SEGREDO });
  t.after(() => app.encerrar());

  const cabecalhos = { 'x-crmclinica-token': SEGREDO };
  const primeira = await (await postar(app, '/api/webhooks/chatwoot', EVENTO_WEBHOOK, cabecalhos)).json();
  const segunda = await postar(app, '/api/webhooks/chatwoot', EVENTO_WEBHOOK, cabecalhos);

  assert.equal(segunda.status, 200);
  const repetida = await segunda.json();
  assert.equal(repetida.duplicado, true);
  assert.equal(repetida.chave_idempotencia, primeira.chave_idempotencia);

  // O ponto da idempotência: o paciente não recebe duas respostas.
  assert.equal(chatwoot.acoes.filter((a) => a.acao === 'responder').length, 1);
});

test('evento não tratado responde 400 sem quebrar', async (t) => {
  const { app } = await subirComInbox({ CHATWOOT_WEBHOOK_SECRET: SEGREDO });
  t.after(() => app.encerrar());

  const resposta = await postar(app, '/api/webhooks/chatwoot', { event: 'webwidget_triggered' }, {
    'x-crmclinica-token': SEGREDO,
  });
  assert.equal(resposta.status, 400);
  assert.match((await resposta.json()).erro, /não tratado/);
});

test('em produção sem segredo, o webhook do Chatwoot fica indisponível', async (t) => {
  const { app } = await subirComInbox({ NODE_ENV: 'production', CHATWOOT_WEBHOOK_SECRET: '' });
  t.after(() => app.encerrar());

  assert.equal((await postar(app, '/api/webhooks/chatwoot', EVENTO_WEBHOOK)).status, 503);
});

test('GET no webhook responde 405', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/webhooks/chatwoot');
  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'POST');
});

test('o resumo mostra o Chatwoot como inbox da equipe', async (t) => {
  const { app } = await subirComInbox();
  t.after(() => app.encerrar());

  const resumo = await (await app.pedir('/api/resumo')).json();
  assert.equal(resumo.plataforma.inbox.nome, 'Chatwoot');
  assert.equal(resumo.plataforma.inbox.papel, 'inbox operacional da equipe humana');
  assert.equal(resumo.plataforma.inbox.saude, 'operacional');
});

test('nenhuma rota devolve o token do Chatwoot', async (t) => {
  const { app } = await subirComInbox({ CHATWOOT_API_TOKEN: 'token-secreto-do-chatwoot' });
  t.after(() => app.encerrar());

  for (const rota of ['/api/resumo', '/api/conversas', '/api/conversas/4678', '/api/leads', '/api/conversas/filas']) {
    const bruto = await (await app.pedir(rota)).text();
    assert.ok(!bruto.includes('token-secreto-do-chatwoot'), `a rota ${rota} vazou o token`);
  }
});
