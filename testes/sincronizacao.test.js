'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarSincronizador } = require('../src/dominio/sincronizacao');
const { validarEventoChatwoot } = require('../src/contratos/evento-chatwoot');
const { ETIQUETA_ATENDIMENTO_HUMANO } = require('../src/dominio/conversas');

// Dublês simples: registram o que foi chamado, sem rede e sem credencial.
function chatwootFalso({ etiquetas = [] } = {}) {
  const acoes = [];
  return {
    disponivel: true,
    timeId: '2',
    acoes,
    responder: async (conversaId, texto) => { acoes.push({ acao: 'responder', conversaId, texto }); },
    definirEtiquetas: async (conversaId, lista) => { acoes.push({ acao: 'etiquetas', conversaId, lista }); },
    atribuirTime: async (conversaId, timeId) => { acoes.push({ acao: 'time', conversaId, timeId }); },
    listarEtiquetasDaConversa: async () => etiquetas,
  };
}

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => {
      despachos.push(carga);
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  };
}

function eventoDeMensagem(extras = {}) {
  return validarEventoChatwoot({
    event: 'message_created',
    id: 991,
    content: 'Quero saber sobre a primeira consulta',
    message_type: 'incoming',
    created_at: 1_785_000_000,
    conversation: { id: 4678, status: 'open', labels: [], ...extras.conversation },
    sender: { id: 55, name: 'Marina', phone_number: '+5516999999999' },
    inbox: { id: 3, channel_type: 'Channel::Whatsapp' },
    ...extras.raiz,
  });
}

test('mensagem do paciente sem responsável vai ao orquestrador e a resposta volta ao Chatwoot', async () => {
  const chatwoot = chatwootFalso();
  const orquestrador = orquestradorFalso();
  const sincronizador = criarSincronizador({ chatwoot, orquestrador });

  const resultado = await sincronizador.tratarEvento(eventoDeMensagem());

  assert.equal(resultado.acao, 'respondido_pela_automacao');
  assert.equal(orquestrador.despachos.length, 1);

  // A resposta volta para a conversa do Chatwoot — não existe canal paralelo.
  const respostas = chatwoot.acoes.filter((acao) => acao.acao === 'responder');
  assert.equal(respostas.length, 1);
  assert.equal(respostas[0].conversaId, 4678);
  assert.equal(respostas[0].texto, 'Olá! Posso ajudar?');
});

test('o orquestrador recebe só o contexto mínimo, com chave de idempotência', async () => {
  const orquestrador = orquestradorFalso();
  const sincronizador = criarSincronizador({ chatwoot: chatwootFalso(), orquestrador });

  await sincronizador.tratarEvento(eventoDeMensagem());
  const [carga] = orquestrador.despachos;

  assert.match(carga.chave_idempotencia, /^[0-9a-f]{64}$/);
  assert.equal(carga.contexto.conversa_id, 4678);
  assert.equal(carga.contexto.contato.telefone, '+5516999999999');
  assert.deepEqual(Object.keys(carga.contexto.contato).sort(), ['identificador', 'nome', 'telefone']);
  assert.ok(!JSON.stringify(carga).includes('email'), 'não envia mais dado do que o necessário');
});

test('conversa com responsável humano não vai ao orquestrador', async () => {
  const chatwoot = chatwootFalso();
  const orquestrador = orquestradorFalso();
  const sincronizador = criarSincronizador({ chatwoot, orquestrador });

  const resultado = await sincronizador.tratarEvento(eventoDeMensagem({
    conversation: { meta: { assignee: { id: 7, name: 'Recepção' } } },
  }));

  assert.equal(resultado.acao, 'encaminhado_para_equipe');
  assert.equal(resultado.motivo, 'humano_responsavel');
  assert.equal(orquestrador.despachos.length, 0, 'a IA não pode falar quando há humano');
  assert.equal(chatwoot.acoes.length, 0);
});

test('resposta de agente humano pausa a automação na hora', async () => {
  const orquestrador = orquestradorFalso();
  const sincronizador = criarSincronizador({ chatwoot: chatwootFalso(), orquestrador });

  const evento = validarEventoChatwoot({
    event: 'message_created',
    id: 992,
    content: 'Oi Marina, aqui é a recepção',
    message_type: 'outgoing',
    sender: { id: 7, name: 'Recepção', type: 'user' },
    conversation: { id: 4678, status: 'open', labels: [] },
  });

  const resultado = await sincronizador.tratarEvento(evento);

  assert.equal(resultado.acao, 'automacao_pausada');
  assert.equal(resultado.motivo, 'humano_respondeu');
  assert.equal(orquestrador.despachos.length, 0);
});

test('nota interna é ignorada e nunca chega ao orquestrador', async () => {
  const orquestrador = orquestradorFalso();
  const sincronizador = criarSincronizador({ chatwoot: chatwootFalso(), orquestrador });

  const evento = validarEventoChatwoot({
    event: 'message_created',
    id: 993,
    content: 'paciente já ligou antes',
    message_type: 'outgoing',
    private: true,
    conversation: { id: 4678, status: 'open', labels: [] },
  });

  assert.equal((await sincronizador.tratarEvento(evento)).acao, 'nota_interna_ignorada');
  assert.equal(orquestrador.despachos.length, 0);
});

test('atribuir a um humano pausa e desatribuir libera', async () => {
  const sincronizador = criarSincronizador({ chatwoot: chatwootFalso(), orquestrador: orquestradorFalso() });

  const assumida = await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'assignee_changed',
    conversation: { id: 4678, status: 'open', meta: { assignee: { id: 7, name: 'Recepção' } } },
  }));
  assert.equal(assumida.acao, 'automacao_pausada');
  assert.equal(assumida.motivo, 'humano_assumiu');

  const liberada = await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'assignee_changed',
    conversation: { id: 4678, status: 'open' },
  }));
  assert.equal(liberada.acao, 'automacao_liberada');
});

test('falha do orquestrador escalona para a equipe em vez de travar', async () => {
  const chatwoot = chatwootFalso();
  const falha = Object.assign(new Error('fora do ar'), { codigo: 'openclaw_resposta_invalida' });
  const sincronizador = criarSincronizador({ chatwoot, orquestrador: orquestradorFalso(falha) });

  const resultado = await sincronizador.tratarEvento(eventoDeMensagem());

  assert.equal(resultado.acao, 'escalonado_por_falha');

  const etiquetas = chatwoot.acoes.find((acao) => acao.acao === 'etiquetas');
  assert.ok(etiquetas.lista.includes(ETIQUETA_ATENDIMENTO_HUMANO));
  assert.ok(chatwoot.acoes.some((acao) => acao.acao === 'time'), 'deve cair no time da clínica');
});

test('sem orquestrador configurado, a conversa fica com a equipe', async () => {
  const sincronizador = criarSincronizador({
    chatwoot: chatwootFalso(),
    orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } },
  });

  const resultado = await sincronizador.tratarEvento(eventoDeMensagem());
  assert.equal(resultado.acao, 'sem_orquestrador');
});

test('conversa nova ganha temperatura sem perder as etiquetas da equipe', async () => {
  const chatwoot = chatwootFalso();
  const sincronizador = criarSincronizador({ chatwoot, orquestrador: orquestradorFalso() });

  await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'conversation_created',
    conversation: { id: 4678, status: 'open', labels: ['avaliacao', 'pagou_sinal'] },
    sender: { id: 55, name: 'Marina', phone_number: '+5516999999999' },
    inbox: { id: 3, channel_type: 'Channel::Whatsapp' },
  }));

  const etiquetas = chatwoot.acoes.find((acao) => acao.acao === 'etiquetas');
  assert.ok(etiquetas.lista.includes('avaliacao'));
  assert.ok(etiquetas.lista.includes('pagou_sinal'));
  assert.ok(etiquetas.lista.includes('lead_quente'), 'quem pagou sinal é lead quente');
});

test('temperatura marcada pela equipe não é sobrescrita', async () => {
  const chatwoot = chatwootFalso();
  const sincronizador = criarSincronizador({ chatwoot, orquestrador: orquestradorFalso() });

  const resultado = await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'conversation_updated',
    conversation: { id: 4678, status: 'open', labels: ['lead_frio', 'pagou_sinal'] },
    sender: { id: 55, name: 'Marina' },
  }));

  assert.equal(resultado.temperatura, 'frio');
  assert.equal(resultado.temperatura_origem, 'etiqueta_da_equipe');
  assert.equal(chatwoot.acoes.length, 0, 'a etiqueta da equipe é soberana');
});

test('definir temperatura manualmente preserva as etiquetas existentes', async () => {
  const chatwoot = chatwootFalso({ etiquetas: ['avaliacao', 'positiva', 'lead_frio'] });
  const sincronizador = criarSincronizador({ chatwoot, orquestrador: orquestradorFalso() });

  const resultado = await sincronizador.definirTemperatura(4678, 'quente');

  assert.equal(resultado.temperatura, 'quente');
  const etiquetas = chatwoot.acoes.find((acao) => acao.acao === 'etiquetas').lista;
  assert.deepEqual(etiquetas, ['avaliacao', 'positiva', 'lead_quente']);
});

test('resolver e reabrir são registrados', async () => {
  const sincronizador = criarSincronizador({ chatwoot: chatwootFalso(), orquestrador: orquestradorFalso() });

  const resolvida = await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'conversation_status_changed',
    conversation: { id: 4678, status: 'resolved' },
  }));
  assert.equal(resolvida.acao, 'conversa_resolvida');

  const reaberta = await sincronizador.tratarEvento(validarEventoChatwoot({
    event: 'conversation_status_changed',
    conversation: { id: 4678, status: 'open' },
  }));
  assert.equal(reaberta.acao, 'conversa_reaberta');
});

test('toda decisão fica na trilha de auditoria', async () => {
  const auditoria = [];
  const sincronizador = criarSincronizador({
    chatwoot: chatwootFalso(),
    orquestrador: orquestradorFalso(),
    auditoria,
  });

  await sincronizador.tratarEvento(eventoDeMensagem());
  assert.equal(auditoria.length, 1);
  assert.match(auditoria[0].em, /^\d{4}-\d{2}-\d{2}T/);
});
