'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteOpenClaw, assinar, assinaturaValida } = require('../src/integracoes/openclaw');

// Todos os testes usam um cliente gateway falso.
// Nenhuma conexão WebSocket é aberta e nenhum segredo real é lido.

// Configuração com gateway WebSocket e a sessão INTERNA do CRM — o despacho
// nunca toca sessão de paciente. Timeout curto: os testes de "não achou
// resposta nova" esperam o timeout de verdade, e ninguém quer 20 s disso.
const CONFIGURACAO = Object.freeze({
  sessao: 'sessao-interna-do-crm',
  gateway: {
    url: 'wss://gateway.invalido',
    token: 'token-sintetico-de-teste',
    timeoutMs: 3000,
  },
});

/**
 * Cria um cliente gateway falso que simula as respostas do OpenClaw.
 *
 * `respostas` é um mapa de método → valor retornado. Valor-função é chamado
 * com (parametros, nº da chamada daquele método) — é como um histórico "muda"
 * entre a linha de base e o polling da resposta.
 */
function clienteFalso(respostas = {}) {
  const chamadas = [];
  const contadores = new Map();
  return {
    chamadas,
    disponivel: true,
    async chamar(metodo, parametros) {
      chamadas.push({ metodo, parametros });
      const vez = (contadores.get(metodo) ?? 0) + 1;
      contadores.set(metodo, vez);
      const valor = typeof respostas[metodo] === 'function'
        ? respostas[metodo](parametros, vez)
        : respostas[metodo];
      if (valor instanceof Error) throw valor;
      return valor ?? null;
    },
    async encerrar() {},
  };
}

// ---------------------------------------------------------------- disponível

test('sem gateway configurado, o cliente se declara indisponível', () => {
  const semNada = criarClienteOpenClaw({});
  assert.equal(semNada.disponivel, false);

  const semUrl = criarClienteOpenClaw({ gateway: { token: 'x' } });
  assert.equal(semUrl.disponivel, false);

  const semToken = criarClienteOpenClaw({ gateway: { url: 'wss://x' } });
  assert.equal(semToken.disponivel, false);
});

test('cliente indisponível recusa despacho com código próprio, sem tocar o gateway', async () => {
  const cliente = clienteFalso();
  const orquestrador = criarClienteOpenClaw({}, { cliente });
  await assert.rejects(
    () => orquestrador.despacharEvento({ chave_idempotencia: 'x' }),
    (erro) => erro.codigo === 'openclaw_nao_configurado',
  );
  assert.equal(cliente.chamadas.length, 0);
});

// ---------------------------------------------------------------- despacharEvento
//
// O despacho é o fluxo `crm_despacha`: sessão INTERNA configurada, linha de
// base antes do envio, e só resposta NOVA volta. O que estes testes vigiam é
// o mecanismo exato da resposta duplicada e da resposta velha.

const EVENTO_DE_DESPACHO = Object.freeze({
  chave_idempotencia: 'evt:1',
  tipo: 'conversa.mensagem_recebida',
  contexto: Object.freeze({
    contato: Object.freeze({ telefone: '5516999999999' }),
    mensagens: Object.freeze([{ autor: 'contato', texto: 'Olá' }]),
  }),
});

test('sem sessão interna configurada, falha fechado sem tocar o gateway', async () => {
  const cliente = clienteFalso();
  const orquestrador = criarClienteOpenClaw({ gateway: CONFIGURACAO.gateway }, { cliente });

  const resultado = await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);

  // Nada de cair de volta para a sessão de um paciente: sem motor próprio, a
  // conversa vai para a equipe com o motivo dizendo o que falta ligar.
  assert.deepEqual(resultado, { resposta: null, escalonar: true, motivo: 'motor_ia_nao_configurado' });
  assert.equal(cliente.chamadas.length, 0);
});

test('nunca localiza sessão de paciente: o despacho fala só com a sessão interna', async () => {
  const cliente = clienteFalso({
    'chat.history': { messages: [] },
    'chat.send': { status: 'started' },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);

  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'sessions.list'),
    'sessions.list era o mecanismo da resposta duplicada — não pode voltar');
  for (const chamada of cliente.chamadas) {
    if (chamada.metodo === 'chat.send' || chamada.metodo === 'chat.history') {
      assert.equal(chamada.parametros.sessionKey, 'sessao-interna-do-crm');
    }
  }
});

test('lê a linha de base antes do envio e devolve só a resposta nova', async () => {
  const antiga = { role: 'assistant', content: 'Resposta da pergunta anterior', __openclaw: { id: 'msg-1' } };
  const nova = { role: 'assistant', content: 'Resposta desta pergunta', __openclaw: { id: 'msg-3' } };
  let enviou = false;

  const cliente = clienteFalso({
    'chat.history': () => ({ messages: enviou ? [antiga, nova] : [antiga] }),
    'chat.send': () => { enviou = true; return { status: 'started', runId: 'run-1' }; },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });

  const resultado = await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);
  assert.equal(resultado.resposta, 'Resposta desta pergunta');

  const envio = cliente.chamadas.find((c) => c.metodo === 'chat.send');
  assert.equal(envio.parametros.message, 'Olá');
  assert.equal(envio.parametros.idempotencyKey, 'evt:1',
    'a chave do evento é a chave do envio: retentativa reusa a mesma');

  // A primeira consulta ao histórico veio ANTES do envio: é a linha de base.
  const ordem = cliente.chamadas.map((c) => c.metodo);
  assert.ok(ordem.indexOf('chat.history') < ordem.indexOf('chat.send'));
});

test('resposta antiga nunca é devolvida como nova: sem mensagem nova, timeout devolve null', async () => {
  const antiga = { role: 'assistant', content: 'Resposta de ontem', __openclaw: { id: 'msg-1' } };
  const cliente = clienteFalso({
    'chat.history': { messages: [antiga] },
    'chat.send': { status: 'started' },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });

  const resultado = await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);
  assert.equal(resultado.resposta, null,
    'devolver "Resposta de ontem" seria responder o paciente com história');
});

test('resposta de outra execução (runId divergente) não é aceita', async () => {
  const deOutraExecucao = {
    role: 'assistant', content: 'Sou de outro envio', __openclaw: { id: 'msg-9', runId: 'run-OUTRO' },
  };
  let enviou = false;
  const cliente = clienteFalso({
    'chat.history': () => ({ messages: enviou ? [deOutraExecucao] : [] }),
    'chat.send': () => { enviou = true; return { status: 'started', runId: 'run-1' }; },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });

  const resultado = await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);
  assert.equal(resultado.resposta, null);
});

test('retentativa do mesmo evento envia com a mesma chave de idempotência', async () => {
  const cliente = clienteFalso({
    'chat.history': { messages: [] },
    'chat.send': { status: 'started' },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });

  await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);
  await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);

  const envios = cliente.chamadas.filter((c) => c.metodo === 'chat.send');
  assert.equal(envios.length, 2);
  assert.equal(envios[0].parametros.idempotencyKey, envios[1].parametros.idempotencyKey,
    'é a chave repetida que permite ao gateway recusar a duplicata');
});

test('sem texto na última mensagem, devolve resposta nula sem chamar chat.send', async () => {
  const cliente = clienteFalso({ 'chat.history': { messages: [] } });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    ...EVENTO_DE_DESPACHO,
    contexto: { contato: { telefone: '5516999999999' }, mensagens: [] },
  });
  assert.deepEqual(resultado, { resposta: null });
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'chat.send'));
});

test('falha ao ler a linha de base vira erro identificável, sem envio', async () => {
  const falha = Object.assign(new Error('gateway fora do ar'), { codigo: 'gateway_timeout' });
  const cliente = clienteFalso({ 'chat.history': falha });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  await assert.rejects(
    () => orquestrador.despacharEvento(EVENTO_DE_DESPACHO),
    (erro) => typeof erro.codigo === 'string',
  );
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'chat.send'),
    'sem linha de base não há envio: enviar às cegas é aceitar resposta velha');
});

test('pane do agente no histórico não vira resposta: escalona para a equipe', async () => {
  // O OpenClaw grava a própria pane como fala do assistente. Em produção essa
  // frase foi ENVIADA a um paciente como se fosse a Serena respondendo.
  const pane = {
    role: 'assistant',
    content: 'The agent run failed before producing a reply.',
    __openclaw: { id: 'msg-pane', runId: 'run-1' },
  };
  let enviou = false;
  const cliente = clienteFalso({
    'chat.history': () => ({ messages: enviou ? [pane] : [] }),
    'chat.send': () => { enviou = true; return { status: 'started', runId: 'run-1' }; },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });

  const resultado = await orquestrador.despacharEvento(EVENTO_DE_DESPACHO);

  assert.deepEqual(resultado, { resposta: null, escalonar: true, motivo: 'motor_ia_falhou' },
    'a frase de erro nunca pode ser devolvida como texto de resposta');
});

test('ehFalhaDoAgente reconhece só o sentinela, não uma resposta que o menciona', () => {
  const { ehFalhaDoAgente } = require('../src/integracoes/openclaw');
  assert.equal(ehFalhaDoAgente('The agent run failed before producing a reply.'), true);
  assert.equal(ehFalhaDoAgente('  the agent run failed before producing a reply.  '), true);
  assert.equal(ehFalhaDoAgente('The agent execution was aborted.'), true);
  assert.equal(ehFalhaDoAgente('Boa tarde! Como posso ajudar?'), false);
  assert.equal(ehFalhaDoAgente('Vi aqui que apareceu "the agent run failed" no seu teste.'), false);
  assert.equal(ehFalhaDoAgente(''), false);
  assert.equal(ehFalhaDoAgente(null), false);
});

// ---------------------------------------------------------------- verificarSaude

test('verificarSaude traduz os estados sem derrubar o CRM', async () => {
  // Não configurado.
  const naoConfigurado = criarClienteOpenClaw({});
  assert.deepEqual(await naoConfigurado.verificarSaude(), { estado: 'nao_configurado' });

  // Canal conectado → operacional.
  const clienteConectado = clienteFalso({
    'channels.status': { channels: { whatsapp: { connected: true, linked: true } } },
  });
  const conectado = criarClienteOpenClaw(CONFIGURACAO, { cliente: clienteConectado });
  assert.deepEqual(await conectado.verificarSaude(), { estado: 'operacional' });

  // Canal desconectado → degradado.
  const clienteDesconectado = clienteFalso({
    'channels.status': { channels: { whatsapp: { connected: false } } },
  });
  const desconectado = criarClienteOpenClaw(CONFIGURACAO, { cliente: clienteDesconectado });
  assert.deepEqual(await desconectado.verificarSaude(), { estado: 'degradado' });

  // Gateway fora do ar → indisponível, sem propagar exceção.
  const clienteForaDoAr = clienteFalso({
    'channels.status': new Error('conexão recusada'),
  });
  const foraDoAr = criarClienteOpenClaw(CONFIGURACAO, { cliente: clienteForaDoAr });
  assert.deepEqual(await foraDoAr.verificarSaude(), { estado: 'indisponivel' });
});

// ---------------------------------------------------------------- assinatura HMAC

test('verificação de assinatura aceita a correta e recusa o resto', () => {
  const segredo = 'segredo-sintetico-de-teste-para-hmac';
  const corpo = '{"canal":"whatsapp"}';
  const correta = assinar(corpo, segredo);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo }), true);
  // O prefixo sha256= é opcional na recepção.
  assert.equal(
    assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta.replace('sha256=', ''), segredo }),
    true,
  );
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo: 'outro' }), false);
  assert.equal(assinaturaValida({ corpoBruto: '{"canal":"site"}', assinaturaRecebida: correta, segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: '', segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: 'curta', segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo: '' }), false);
});
