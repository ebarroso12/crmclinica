'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { assinar } = require('../src/integracoes/openclaw');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

const SEGREDO = 'segredo-sintetico-da-ponte-whatsapp-com-mais-de-32-caracteres';
const EVENTO = Object.freeze({
  tipo: 'mensagem.recebida',
  canal: 'whatsapp',
  id_externo: 'openclaw:mensagem-sintetica-1',
  remetente: '5511999990000',
  nome: 'Contato de Teste',
  texto: 'Olá, gostaria de informações',
  origem: 'openclaw_plugin',
  ocorrido_em: '2026-08-06T12:00:00.000Z',
});

async function subirIngresso(sobrescritas = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: null });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO, ...sobrescritas });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  return { app, repositorio };
}

function enviar(app, corpo, segredo = SEGREDO) {
  const bruto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return app.pedirSemAuth('/api/canais/whatsapp/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(segredo ? { 'x-whatsapp-assinatura': assinar(bruto, segredo) } : {}),
    },
    body: bruto,
  });
}

test('a ponte registra o inbound em Conversas e a rota carimba crm_despacha', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.estrategia_ia, 'crm_despacha');
  assert.equal(typeof recibo.conversa_id, 'number');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  const mensagens = await repositorio.listarMensagens(conversas[0].id);
  assert.equal(mensagens[0].direcao, 'entrada');
  assert.equal(mensagens[0].conteudo, EVENTO.texto);
  assert.equal(mensagens[0].autor_tipo, 'contato');
});

test('a assinatura da ponte é obrigatória e não aceita o segredo do webhook genérico', async (t) => {
  const { app } = await subirIngresso();
  t.after(() => app.encerrar());

  assert.equal((await enviar(app, EVENTO, null)).status, 401);
  assert.equal((await enviar(app, EVENTO, 'outro-segredo-com-tamanho-suficiente-para-o-teste')).status, 401);
});

test('a mesma mensagem é idempotente e não cria segunda linha', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  assert.equal((await enviar(app, EVENTO)).status, 202);
  const repetida = await enviar(app, { ...EVENTO, texto: 'texto alterado na reentrega' });
  assert.equal(repetida.status, 200);
  assert.equal((await repetida.json()).duplicado, true);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1);
});

test('payload não consegue transferir a resposta ao agente direto nem trocar de canal', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  const agenteDireto = await enviar(app, { ...EVENTO, estrategia_ia: 'openclaw_gerencia' });
  assert.equal(agenteDireto.status, 422);

  const outroCanal = await enviar(app, { ...EVENTO, canal: 'site', id_externo: 'site:1' });
  assert.equal(outroCanal.status, 422);
  assert.equal((await repositorio.listarConversas({})).length, 0);
});

test('GET na porta de ingresso é recusado', async (t) => {
  const { app } = await subirIngresso();
  t.after(() => app.encerrar());

  const resposta = await app.pedirSemAuth('/api/canais/whatsapp/eventos');
  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'POST');
});
