'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteOpenClaw, assinar, assinaturaValida } = require('../src/integracoes/openclaw');

// Todos os testes usam um cliente gateway falso.
// Nenhuma conexão WebSocket é aberta e nenhum segredo real é lido.

// Configuração com gateway WebSocket (nova interface).
const CONFIGURACAO = Object.freeze({
  gateway: {
    url: 'wss://gateway.invalido',
    token: 'token-sintetico-de-teste',
    timeoutMs: 10000,
  },
});

/**
 * Cria um cliente gateway falso que simula as respostas do OpenClaw.
 *
 * `respostas` é um mapa de método → valor retornado.
 * Permite verificar quais chamadas foram feitas e com quais parâmetros.
 */
function clienteFalso(respostas = {}) {
  const chamadas = [];
  return {
    chamadas,
    disponivel: true,
    async chamar(metodo, parametros) {
      chamadas.push({ metodo, parametros });
      if (respostas[metodo] instanceof Error) throw respostas[metodo];
      return respostas[metodo] ?? null;
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

test('sem telefone no contexto, devolve resposta nula sem chamar o gateway', async () => {
  const cliente = clienteFalso();
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:1',
    tipo: 'conversa.mensagem_recebida',
    contexto: { contato: {}, mensagens: [] },
  });
  assert.deepEqual(resultado, { resposta: null });
  assert.equal(cliente.chamadas.length, 0);
});

test('sem sessão ativa para o telefone, devolve resposta nula', async () => {
  const cliente = clienteFalso({
    'sessions.list': { sessions: [] },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:2',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '5516999999999' },
      mensagens: [{ autor: 'contato', texto: 'Olá' }],
    },
  });
  assert.deepEqual(resultado, { resposta: null });
  // Só sessions.list foi chamado; chat.send não deve ter sido chamado.
  assert.ok(cliente.chamadas.some((c) => c.metodo === 'sessions.list'));
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'chat.send'));
});

test('com sessão ativa, envia via chat.send e aguarda resposta no histórico', async () => {
  const cliente = clienteFalso({
    'sessions.list': {
      sessions: [{
        key: 'sess-abc',
        origin: { from: '+5516999999999', provider: 'whatsapp' },
      }],
    },
    'chat.send': { status: 'started', runId: 'run-1' },
    'chat.history': {
      messages: [
        { role: 'user', content: 'Olá', __openclaw: { id: 'msg-1' } },
        { role: 'assistant', content: 'Olá! Como posso ajudar?', __openclaw: { id: 'msg-2' } },
      ],
    },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:3',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '5516999999999' },
      mensagens: [{ autor: 'contato', texto: 'Olá' }],
    },
  });
  assert.equal(resultado.resposta, 'Olá! Como posso ajudar?');
  // Verifica que chat.send foi chamado com os parâmetros corretos.
  const envio = cliente.chamadas.find((c) => c.metodo === 'chat.send');
  assert.ok(envio, 'chat.send deve ter sido chamado');
  assert.equal(envio.parametros.sessionKey, 'sess-abc');
  assert.equal(envio.parametros.message, 'Olá');
  assert.ok(envio.parametros.idempotencyKey, 'deve ter chave de idempotência');
});

test('localiza sessão pelo sufixo do telefone (com ou sem código de país)', async () => {
  const cliente = clienteFalso({
    'sessions.list': {
      sessions: [{
        key: 'sess-xyz',
        origin: { from: '+5516999999999', provider: 'whatsapp' },
      }],
    },
    'chat.send': { status: 'started' },
    'chat.history': {
      messages: [
        { role: 'assistant', content: 'Boa tarde!' },
      ],
    },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  // Telefone sem código de país — deve encontrar a sessão pelo sufixo.
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:4',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '16999999999' },
      mensagens: [{ autor: 'contato', texto: 'Boa tarde' }],
    },
  });
  assert.equal(resultado.resposta, 'Boa tarde!');
});

test('sem texto na última mensagem, devolve resposta nula sem chamar chat.send', async () => {
  const cliente = clienteFalso({
    'sessions.list': {
      sessions: [{ key: 'sess-1', origin: { from: '+5516999999999', provider: 'whatsapp' } }],
    },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:5',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '5516999999999' },
      mensagens: [],
    },
  });
  assert.deepEqual(resultado, { resposta: null });
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'chat.send'));
});

test('falha no sessions.list vira erro identificável', async () => {
  const falha = Object.assign(new Error('gateway fora do ar'), { codigo: 'gateway_timeout' });
  const cliente = clienteFalso({ 'sessions.list': falha });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  await assert.rejects(
    () => orquestrador.despacharEvento({
      chave_idempotencia: 'evt:6',
      tipo: 'conversa.mensagem_recebida',
      contexto: {
        contato: { telefone: '5516999999999' },
        mensagens: [{ autor: 'contato', texto: 'Oi' }],
      },
    }),
    (erro) => typeof erro.codigo === 'string',
  );
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
