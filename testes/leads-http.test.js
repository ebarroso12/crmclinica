'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');
const { criarAtendimento } = require('../src/dominio/atendimento');

function orquestradorFalso(resposta = { resposta: 'Olá!' }) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => { despachos.push(carga); return resposta; },
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

async function subirComLead({ papel = 'admin', resposta } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const servicoDeLeads = criarServicoDeLeads({ repositorio });
  const orquestrador = orquestradorFalso(resposta);
  const atendimento = criarAtendimento({ repositorio, orquestrador, leads: servicoDeLeads });

  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha',
    id_externo: 'wa:1', remetente: '5516999999999',
    nome: 'Marina Souza', texto: 'Quero saber sobre a primeira consulta',
    utm_source: 'instagram', utm_campaign: 'verao2026',
  });

  const app = await subirServidor({
    repositorio, atendimento, orquestrador, servicoDeLeads, papel,
    configuracao: configuracaoDeTeste(),
  });

  const [lead] = await repositorio.listarLeads();
  return { app, repositorio, lead, orquestrador, servicoDeLeads };
}

function postar(app, caminho, corpo) {
  return app.pedir(caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- vocabulário

test('GET /api/leads/vocabulario descreve etapas, transições e perguntas', async (t) => {
  const { app } = await subirComLead();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/leads/vocabulario')).json();

  assert.deepEqual(
    dados.etapas.map((e) => e.etapa),
    ['novo', 'qualificando', 'agendado', 'convertido', 'perdido'],
  );
  // Cada etapa explica o que significa na prática da recepção.
  assert.ok(dados.etapas.every((e) => e.rotulo && e.significa));
  assert.deepEqual(dados.pagamentos, ['particular', 'convenio', 'indefinido']);
  assert.equal(dados.perguntas.length, 5);
});

// ---------------------------------------------------------------- qualificação

test('GET /api/leads/:id traz score explicado, próxima ação e jornada', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir(`/api/leads/${lead.id}`)).json();

  assert.equal(dados.lead.id, lead.id);
  assert.equal(typeof dados.score, 'number');
  assert.ok(Array.isArray(dados.score_motivos));
  assert.match(dados.proxima_acao, /Perguntar/);
  assert.equal(dados.proxima_pergunta.campo, 'interesse');
  assert.ok(dados.jornada.length > 0, 'o primeiro contato já está na jornada');
});

test('POST qualificação grava e devolve o que falta', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  const resposta = await postar(app, `/api/leads/${lead.id}/qualificacao`, {
    interesse: 'preenchimento facial', urgencia: 'imediata',
  });
  assert.equal(resposta.status, 200);

  const dados = await resposta.json();
  assert.deepEqual(dados.alterados.sort(), ['interesse', 'urgencia']);
  assert.equal(dados.proxima_pergunta.campo, 'primeira_consulta');
  assert.deepEqual(dados.pendentes, ['primeira_consulta', 'pagamento', 'disponibilidade']);
});

test('valor fora do vocabulário responde 400 apontando o campo', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  for (const [campo, valor] of [['pagamento', 'bitcoin'], ['urgencia', 'ontem'], ['disponibilidade', 'madrugada']]) {
    const resposta = await postar(app, `/api/leads/${lead.id}/qualificacao`, { [campo]: valor });
    assert.equal(resposta.status, 400, `${campo} deveria ser recusado`);
    assert.equal((await resposta.json()).campo, campo);
  }

  const booleano = await postar(app, `/api/leads/${lead.id}/qualificacao`, { primeira_consulta: 'talvez' });
  assert.equal(booleano.status, 400);
});

test('a origem do formulário chega ao lead via UTM', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir(`/api/leads/${lead.id}`)).json();
  assert.equal(dados.lead.utm_source, 'instagram');
  assert.equal(dados.lead.utm_campaign, 'verao2026');
});

// ---------------------------------------------------------------- jornada

test('POST estágio move e devolve de-para', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  // A equipe move com próximo passo; o dono é o usuário autenticado (P1-11).
  await postar(app, `/api/leads/${lead.id}/estagio`, {
    estagio: 'qualificando', proximo_passo: 'Perguntar convênio',
  });
  const resposta = await postar(app, `/api/leads/${lead.id}/estagio`, { estagio: 'agendado' });

  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.equal(dados.de, 'qualificando');
  assert.equal(dados.para, 'agendado');
  assert.match(dados.proxima_acao, /Confirmar presença/);
});

test('salto inválido responde 409 com as opções', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  const resposta = await postar(app, `/api/leads/${lead.id}/estagio`, { estagio: 'convertido' });
  assert.equal(resposta.status, 409);
});

test('GET jornada devolve o histórico e o resumo', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  await postar(app, `/api/leads/${lead.id}/estagio`, {
    estagio: 'qualificando', proximo_passo: 'Perguntar convênio',
  });
  await postar(app, `/api/leads/${lead.id}/estagio`, { estagio: 'agendado' });

  const dados = await (await app.pedir(`/api/leads/${lead.id}/jornada`)).json();

  assert.ok(dados.eventos.length >= 3);
  assert.equal(dados.resumo.ultimo.para, 'agendado');
  // A jornada guarda quem causou cada mudança.
  assert.ok(dados.eventos.some((evento) => evento.origem === 'equipe'));
});

// ---------------------------------------------------------------- temperatura

test('POST temperatura fixa na mão e o cálculo para de mexer', async (t) => {
  const { app, lead, repositorio } = await subirComLead();
  t.after(() => app.encerrar());

  const resposta = await postar(app, `/api/leads/${lead.id}/temperatura`, { temperatura: 'quente' });
  assert.equal(resposta.status, 200);
  assert.equal((await resposta.json()).manual, true);

  const atual = await repositorio.obterLead(lead.id);
  assert.equal(atual.temperatura, 'quente');
  assert.equal(atual.temperatura_manual, true);
});

// ---------------------------------------------------------------- kanban

test('o kanban traz score, próxima ação e a conversa de cada lead', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  await postar(app, `/api/leads/${lead.id}/qualificacao`, { interesse: 'botox', urgencia: 'imediata' });

  const dados = await (await app.pedir('/api/leads')).json();
  const card = dados.colunas.flatMap((coluna) => coluna.leads).find((item) => item.id === lead.id);

  assert.ok(card, 'o lead precisa aparecer no kanban');
  assert.ok(card.score > 0);
  assert.ok(card.proxima_acao);
  assert.equal(card.conversa_id, lead.conversa_id, 'clicar no card abre a conversa certa');
});

test('as colunas do kanban seguem as etapas da jornada', async (t) => {
  const { app } = await subirComLead();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/leads')).json();
  assert.deepEqual(
    dados.colunas.map((coluna) => coluna.estagio),
    ['novo', 'qualificando', 'agendado', 'convertido', 'perdido'],
  );
});

// ---------------------------------------------------------------- RBAC e autenticação

test('as rotas de lead exigem autenticação', async (t) => {
  const { app, lead } = await subirComLead();
  t.after(() => app.encerrar());

  for (const rota of [`/api/leads/${lead.id}`, `/api/leads/${lead.id}/jornada`, '/api/leads/vocabulario']) {
    assert.equal((await app.pedirSemAuth(rota)).status, 401, `rota ${rota}`);
  }
});

test('atendente qualifica e etiqueta, como no atendimento', async (t) => {
  const { app, lead } = await subirComLead({ papel: 'atendente' });
  t.after(() => app.encerrar());

  assert.equal((await postar(app, `/api/leads/${lead.id}/qualificacao`, { interesse: 'x' })).status, 200);
  assert.equal((await postar(app, `/api/leads/${lead.id}/temperatura`, { temperatura: 'morno' })).status, 200);
});

// ---------------------------------------------------------------- contexto ao OpenClaw

test('o orquestrador recebe a qualificação, mas nada clínico', async (t) => {
  const { app, orquestrador } = await subirComLead();
  t.after(() => app.encerrar());

  const [carga] = orquestrador.despachos;
  const contexto = carga.contexto;

  // O que ele precisa para não repetir pergunta já respondida.
  assert.ok(contexto.qualificacao, 'a qualificação precisa ir junto');
  assert.deepEqual(Object.keys(contexto.qualificacao).sort(), [
    'disponibilidade', 'interesse', 'pagamento', 'pendentes', 'primeira_consulta',
    'proxima_pergunta', 'urgencia',
  ]);
  assert.equal(contexto.lead.estagio, 'novo');

  // E nada além disso: nenhum campo clínico atravessa a fronteira.
  const bruto = JSON.stringify(carga).toLowerCase();
  for (const proibido of ['prontuario', 'diagnostico', 'sintoma', 'medicacao', 'alergia', 'exame', 'cid']) {
    assert.ok(!bruto.includes(proibido), `o contexto vazou "${proibido}"`);
  }
  // Nem e-mail, nem nota interna, nem UTM — nada que não sirva para responder.
  assert.ok(!bruto.includes('utm_'), 'UTM é dado de marketing, não de atendimento');
  assert.ok(!bruto.includes('email'));
});

test('a resposta do orquestrador com qualificação é gravada', async (t) => {
  const { app, repositorio } = await subirComLead({
    resposta: {
      resposta: 'Entendi! Você já é paciente da clínica?',
      qualificacao: { interesse: 'preenchimento', urgencia: 'imediata' },
    },
  });
  t.after(() => app.encerrar());

  const [lead] = await repositorio.listarLeads();
  assert.equal(lead.interesse, 'preenchimento');
  assert.equal(lead.urgencia, 'imediata');

  // E a descoberta virou evento de jornada, com origem automação.
  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'qualificacao' });
  assert.ok(eventos.some((evento) => evento.origem === 'automacao'));
});
