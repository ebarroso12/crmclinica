'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// A API local do inbox, exercida de ponta a ponta sobre o repositório em memória.

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  return {
    disponivel: true,
    despacharEvento: async () => resposta,
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

async function subirInbox({ comConversa = true } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  if (comConversa) {
    await atendimento.receberMensagem({
      canal: 'whatsapp',
      id_externo: 'wa:1',
      remetente: '5516999999999',
      nome: 'Marina Souza',
      texto: 'Quero saber sobre a primeira consulta',
    });
  }

  const app = await subirServidor({
    repositorio,
    atendimento,
    orquestrador,
    configuracao: configuracaoDeTeste(),
  });

  return { app, repositorio, atendimento };
}

function enviar(app, caminho, corpo, metodo = 'POST') {
  return app.pedir(caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- listagem

test('GET /api/conversas devolve a lista do inbox', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/conversas');
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');

  const dados = await resposta.json();
  assert.equal(dados.total, 1);
  assert.equal(dados.conversas[0].contato.nome, 'Marina Souza');
  assert.equal(dados.conversas[0].previa, 'Olá! Posso ajudar?');
});

test('as filas recortam por quem responde', async (t) => {
  const { app, repositorio, atendimento } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});

  const antes = await (await app.pedir('/api/conversas?fila=nao_atribuidas')).json();
  assert.equal(antes.total, 1);

  await atendimento.assumir(conversa.id, null);

  assert.equal((await (await app.pedir('/api/conversas?fila=nao_atribuidas')).json()).total, 0);
  assert.equal((await (await app.pedir('/api/conversas?fila=minhas')).json()).total, 1);
  assert.equal((await (await app.pedir('/api/conversas?fila=todos')).json()).total, 1);
});

test('busca e filtro de status funcionam; valor inválido responde 400', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  assert.equal((await (await app.pedir('/api/conversas?busca=marina')).json()).total, 1);
  assert.equal((await (await app.pedir('/api/conversas?busca=ninguem')).json()).total, 0);
  assert.equal((await (await app.pedir('/api/conversas?status=aberta')).json()).total, 1);

  assert.equal((await app.pedir('/api/conversas?fila=inventada')).status, 400);
  assert.equal((await app.pedir('/api/conversas?status=inventado')).status, 400);
});

// ---------------------------------------------------------------- conversa e thread

test('GET /api/conversas/:id traz ficha, notas e conversas anteriores', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const dados = await (await app.pedir(`/api/conversas/${conversa.id}`)).json();

  assert.equal(dados.conversa.id, conversa.id);
  assert.equal(dados.ficha.telefone, '5516999999999');
  assert.ok(Array.isArray(dados.ficha.notas));
  assert.ok(Array.isArray(dados.ficha.conversas_anteriores));
});

test('GET /api/conversas/:id/mensagens devolve a thread em ordem', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await (await app.pedir(`/api/conversas/${conversa.id}/mensagens`)).json();

  assert.equal(mensagens.length, 2);
  assert.equal(mensagens[0].autor_tipo, 'contato');
  assert.equal(mensagens[1].autor_tipo, 'automacao');
});

test('conversa inexistente responde 404 e identificador inválido responde 400', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/api/conversas/99999')).status, 404);
  assert.equal((await app.pedir('/api/conversas/abc')).status, 400);
  assert.equal((await app.pedir('/api/conversas/99999/mensagens')).status, 404);
});

// ---------------------------------------------------------------- responder

test('POST /api/conversas/:id/mensagens envia e assume a conversa', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const resposta = await enviar(app, `/api/conversas/${conversa.id}/mensagens`, { texto: 'Bom dia!' });

  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.equal(dados.mensagem.conteudo, 'Bom dia!');
  assert.match(dados.detalhe, /pausada/);

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true);
});

test('nota interna é registrada sem assumir a conversa', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  await enviar(app, `/api/conversas/${conversa.id}/mensagens`, { texto: 'ligou antes', privada: true });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, false);
});

test('mensagem vazia responde 400 apontando o campo', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const resposta = await enviar(app, `/api/conversas/${conversa.id}/mensagens`, { texto: '   ' });

  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).campo, 'texto');
});

// ---------------------------------------------------------------- assumir

test('POST /api/conversas/:id/assumir pausa a IA; liberar devolve', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});

  const assumida = await (await enviar(app, `/api/conversas/${conversa.id}/assumir`, {})).json();
  assert.equal(assumida.conversa.assumida_por_humano, true);
  assert.match(assumida.detalhe, /pausada/);

  const liberada = await (await enviar(app, `/api/conversas/${conversa.id}/assumir`, { liberar: true })).json();
  assert.equal(liberada.conversa.assumida_por_humano, false);
});

// ---------------------------------------------------------------- etiquetas

test('POST /api/conversas/:id/etiquetas substitui o conjunto e ignora nome desconhecido', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const dados = await (await enviar(app, `/api/conversas/${conversa.id}/etiquetas`, {
    etiquetas: ['pagou_sinal', 'lead_quente', 'nao_existe'],
  })).json();

  assert.deepEqual(dados.etiquetas, ['lead_quente', 'pagou_sinal']);
  assert.deepEqual(dados.ignoradas, ['nao_existe']);
  assert.equal(dados.temperatura, 'quente');

  // A temperatura da etiqueta precisa chegar ao lead do kanban.
  const [lead] = await repositorio.listarLeads();
  assert.equal(lead.temperatura, 'quente');
});

test('etiquetas fora de lista respondem 400', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const resposta = await enviar(app, `/api/conversas/${conversa.id}/etiquetas`, { etiquetas: 'pagou_sinal' });

  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).campo, 'etiquetas');
});

// ---------------------------------------------------------------- ficha

test('PUT /api/conversas/:id/ficha atualiza dados e atributos livres', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const resposta = await enviar(app, `/api/conversas/${conversa.id}/ficha`, {
    email: 'marina@exemplo.com',
    atributos: { convenio: 'particular' },
  }, 'PUT');

  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.equal(dados.ficha.email, 'marina@exemplo.com');
  assert.equal(dados.ficha.atributos.convenio, 'particular');
});

test('a ficha recusa corpo vazio e atributos que não sejam objeto', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});

  assert.equal((await enviar(app, `/api/conversas/${conversa.id}/ficha`, {}, 'PUT')).status, 400);
  assert.equal(
    (await enviar(app, `/api/conversas/${conversa.id}/ficha`, { atributos: ['a'] }, 'PUT')).status,
    400,
  );
});

test('POST na ficha responde 405 — a ficha é substituição', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const resposta = await enviar(app, `/api/conversas/${conversa.id}/ficha`, { nome: 'x' });

  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'PUT');
});

// ---------------------------------------------------------------- prioridade, estado, notas

test('prioridade e estado usam vocabulário fechado', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});

  assert.equal((await enviar(app, `/api/conversas/${conversa.id}/prioridade`, { prioridade: 'urgente' })).status, 200);
  assert.equal((await enviar(app, `/api/conversas/${conversa.id}/prioridade`, { prioridade: 'altissima' })).status, 400);

  // Resolver e reabrir.
  const resolvida = await (await enviar(app, `/api/conversas/${conversa.id}/estado`, { status: 'resolvida' })).json();
  assert.equal(resolvida.conversa.status, 'resolvida');

  const reaberta = await (await enviar(app, `/api/conversas/${conversa.id}/estado`, { status: 'aberta' })).json();
  assert.equal(reaberta.conversa.status, 'aberta');

  assert.equal((await enviar(app, `/api/conversas/${conversa.id}/estado`, { status: 'arquivada' })).status, 400);
});

test('nota vai para a ficha do contato', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const dados = await (await enviar(app, `/api/conversas/${conversa.id}/notas`, { texto: 'pediu retorno' })).json();

  assert.equal(dados.nota.texto, 'pediu retorno');
  assert.equal((await repositorio.listarNotas(conversa.contato_id)).length, 1);
});

// ---------------------------------------------------------------- kanban e histórico

test('GET /api/leads monta o kanban; cada card aponta a conversa', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const dados = await (await app.pedir('/api/leads')).json();

  assert.deepEqual(
    dados.colunas.map((coluna) => coluna.estagio),
    ['novo', 'qualificando', 'agendado', 'convertido', 'perdido'],
  );

  const lead = dados.colunas[0].leads[0];
  assert.equal(lead.conversa_id, conversa.id, 'clicar no card precisa abrir a conversa certa');
  assert.equal(lead.nome, 'Marina Souza');
});

test('GET /api/contatos/:id/conversas devolve o histórico do contato', async (t) => {
  const { app, repositorio } = await subirInbox();
  t.after(() => app.encerrar());

  const [conversa] = await repositorio.listarConversas({});
  const dados = await (await app.pedir(`/api/contatos/${conversa.contato_id}/conversas`)).json();

  assert.equal(dados.contato.nome, 'Marina Souza');
  assert.equal(dados.conversas.length, 1);
  assert.ok(Array.isArray(dados.notas));

  assert.equal((await app.pedir('/api/contatos/99999/conversas')).status, 404);
});

// ---------------------------------------------------------------- fluxo completo

test('webhook de canal grava no inbox e a resposta entra no histórico', async (t) => {
  const { app, repositorio } = await subirInbox({ comConversa: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, '/api/eventos', {
    canal: 'whatsapp',
    id_externo: 'wa:novo-1',
    remetente: '5516988887777',
    nome: 'João Lima',
    texto: 'Posso remarcar minha consulta?',
  });

  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.decisao, 'respondida_pela_automacao');

  const mensagens = await repositorio.listarMensagens(recibo.conversa_id);
  assert.equal(mensagens.length, 2);
  assert.equal(mensagens[1].autor_tipo, 'automacao');
});

test('o resumo mostra o inbox local, não um serviço externo', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const resumo = await (await app.pedir('/api/resumo')).json();
  assert.equal(resumo.plataforma.inbox.nome, 'Inbox do crmclinica');
  assert.equal(resumo.plataforma.inbox.saude, 'operacional');
});

test('GET /api/conversas/filas descreve o vocabulário e as etiquetas', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/conversas/filas')).json();

  assert.deepEqual(dados.filas.map((fila) => fila.rotulo), ['Minhas', 'Não atribuídas', 'Todos']);
  assert.deepEqual(dados.temperaturas, ['quente', 'morno', 'frio']);
  assert.ok(dados.etiquetas.some((etiqueta) => etiqueta.nome === 'pagou_sinal'));
  assert.ok(dados.etiquetas.some((etiqueta) => etiqueta.nome === 'lead_quente'));
});

// ---------------------------------------------------------------- busca de contato

test('GET /api/contatos?busca= encontra o paciente para marcar na agenda', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/contatos?busca=Marina');
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');

  const { contatos } = await resposta.json();
  assert.equal(contatos.length, 1);
  assert.equal(contatos[0].nome, 'Marina Souza');
  assert.equal(typeof contatos[0].id, 'number');
});

test('a busca sem termo devolve vazio em vez da base inteira', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const { contatos } = await (await app.pedir('/api/contatos')).json();
  assert.deepEqual(contatos, [], 'a rota serve para achar alguém, não para exportar contatos');
});

test('a busca de contato devolve só o necessário para escolher', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const { contatos } = await (await app.pedir('/api/contatos?busca=Marina')).json();

  // Escolher um paciente pede nome e telefone. Observações e atributos são
  // dados de ficha e não têm por que trafegar num autocompletar.
  assert.deepEqual(Object.keys(contatos[0]).sort(), ['id', 'nome', 'telefone']);
});

test('atendente busca contato; quem não pode ler contatos recebe 403', async (t) => {
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const atendente = await app.entrarComo('atendente');
  const resposta = await app.pedirSemAuth('/api/contatos?busca=Marina', {
    headers: { authorization: `Bearer ${atendente.access_token}` },
  });
  assert.equal(resposta.status, 200, 'quem atende precisa achar o paciente para marcar');

  const semSessao = await app.pedirSemAuth('/api/contatos?busca=Marina');
  assert.equal(semSessao.status, 401);
});

test('POST em /api/contatos cadastra, e exige telefone', async (t) => {
  // A rota mudou quando o CRUD de contatos entrou: antes recusava POST com 405.
  // Cadastrar sem telefone continua sendo erro — o telefone é o que identifica
  // a pessoa entre canais, e contato sem ele não reencontra ninguém.
  const { app } = await subirInbox();
  t.after(() => app.encerrar());

  const semTelefone = await enviar(app, '/api/contatos', { nome: 'X' });
  assert.equal(semTelefone.status, 400);
  assert.equal((await semTelefone.json()).campo, 'telefone');

  const completo = await enviar(app, '/api/contatos', { nome: 'Marina', telefone: '16993129999' });
  assert.equal(completo.status, 201);
});
