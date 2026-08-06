'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteOpenClaw, assinar, assinaturaValida } = require('../src/integracoes/openclaw');

// Todos os testes usam um cliente gateway falso.
// Nenhuma conexão WebSocket é aberta e nenhum segredo real é lido.
//
// Arquitetura A: o OpenClaw controla a conversa.
// O CRM não reenvia a mensagem do paciente via chat.send.
// O despacharEvento retorna { resposta: null } — a Serena já respondeu no canal.

const CONFIGURACAO = Object.freeze({
  gateway: {
    url: 'wss://gateway.invalido',
    token: 'token-sintetico-de-teste',
    timeoutMs: 10000,
  },
});

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

// ---------------------------------------------------------------- despacharEvento (Arquitetura A)

test('despacharEvento retorna resposta nula — a Serena já respondeu no canal', async () => {
  const cliente = clienteFalso();
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:1',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '5516999999999' },
      mensagens: [{ autor: 'contato', texto: 'Olá' }],
    },
  });
  assert.deepEqual(resultado, { resposta: null });
  // Na Arquitetura A, o CRM não chama nenhum método do gateway para responder.
  assert.equal(cliente.chamadas.length, 0, 'nenhuma chamada ao gateway — a Serena já respondeu');
});

test('despacharEvento não chama chat.send nem sessions.list', async () => {
  const cliente = clienteFalso({
    'sessions.list': { sessions: [{ key: 'sess-1', origin: { from: '+5516999999999' } }] },
    'chat.send': { status: 'started' },
  });
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:2',
    tipo: 'conversa.mensagem_recebida',
    contexto: {
      contato: { telefone: '5516999999999' },
      mensagens: [{ autor: 'contato', texto: 'Quero agendar' }],
    },
  });
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'chat.send'), 'chat.send não deve ser chamado');
  assert.ok(!cliente.chamadas.some((c) => c.metodo === 'sessions.list'), 'sessions.list não deve ser chamado');
});

test('despacharEvento sem telefone também retorna resposta nula', async () => {
  const cliente = clienteFalso();
  const orquestrador = criarClienteOpenClaw(CONFIGURACAO, { cliente });
  const resultado = await orquestrador.despacharEvento({
    chave_idempotencia: 'evt:3',
    tipo: 'conversa.mensagem_recebida',
    contexto: { contato: {}, mensagens: [] },
  });
  assert.deepEqual(resultado, { resposta: null });
});

// ---------------------------------------------------------------- verificarSaude

test('verificarSaude traduz os estados sem derrubar o CRM', async () => {
  const naoConfigurado = criarClienteOpenClaw({});
  assert.deepEqual(await naoConfigurado.verificarSaude(), { estado: 'nao_configurado' });

  const clienteConectado = clienteFalso({
    'channels.status': { channels: { whatsapp: { connected: true, linked: true } } },
  });
  const conectado = criarClienteOpenClaw(CONFIGURACAO, { cliente: clienteConectado });
  assert.deepEqual(await conectado.verificarSaude(), { estado: 'operacional' });

  const clienteDesconectado = clienteFalso({
    'channels.status': { channels: { whatsapp: { connected: false } } },
  });
  const desconectado = criarClienteOpenClaw(CONFIGURACAO, { cliente: clienteDesconectado });
  assert.deepEqual(await desconectado.verificarSaude(), { estado: 'degradado' });

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
