'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validarEvento, exigirEstrategiaDoAdaptador } = require('../src/contratos/evento');
const { ErroDeEstrategia } = require('../src/contratos/erros');
const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// O contrato de propriedade do fluxo de IA, fail-closed.
//
// A pergunta que este arquivo responde é uma só: quem decide se o CRM aciona a
// IA para uma mensagem? Nunca o payload — o adaptador confiável que a recebeu.
// Um evento de WhatsApp sem dono declarado é recusado FECHADO (422), porque o
// custo de adivinhar errado é o paciente receber a mesma resposta duas vezes:
// uma do agente do canal, outra do redespacho do CRM.

const BASE = Object.freeze({
  tipo: 'mensagem.recebida',
  id_externo: 'estrategia:1',
  remetente: '5516999990000',
  texto: 'Olá, quero informações',
});

function eventoDe(campos) {
  return validarEvento({ ...BASE, ...campos });
}

function enviar(app, corpo) {
  return app.pedir('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ------------------------------------------------------------ política pura

test('a. WhatsApp com openclaw_gerencia é aceito pela porta do OpenClaw', () => {
  const evento = exigirEstrategiaDoAdaptador(
    eventoDe({ canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia' }),
    'openclaw_webhook',
  );
  assert.equal(evento.estrategia_ia, 'openclaw_gerencia');
});

test('b. WhatsApp sem estratégia é recusado fechado — nunca vira crm_despacha', () => {
  assert.throws(
    () => exigirEstrategiaDoAdaptador(eventoDe({ canal: 'whatsapp' }), 'openclaw_webhook'),
    (erro) => erro instanceof ErroDeEstrategia
      && erro.status === 422
      && erro.codigo === 'estrategia_ia_ambigua',
  );
});

test('c. WhatsApp com crm_despacha é recusado na entrada do OpenClaw', () => {
  assert.throws(
    () => exigirEstrategiaDoAdaptador(
      eventoDe({ canal: 'whatsapp', estrategia_ia: 'crm_despacha' }),
      'openclaw_webhook',
    ),
    (erro) => erro.codigo === 'estrategia_ia_incompativel',
  );
});

test('d. site com crm_despacha é aceito', () => {
  const evento = exigirEstrategiaDoAdaptador(
    eventoDe({ canal: 'site', estrategia_ia: 'crm_despacha' }),
    'openclaw_webhook',
  );
  assert.equal(evento.estrategia_ia, 'crm_despacha');
});

test('e. formulário com crm_despacha é aceito — e sem declaração a porta decide crm_despacha', () => {
  const declarado = exigirEstrategiaDoAdaptador(
    eventoDe({ canal: 'formulario', estrategia_ia: 'crm_despacha' }),
    'openclaw_webhook',
  );
  assert.equal(declarado.estrategia_ia, 'crm_despacha');

  // A porta decide pelo canal — decisão do servidor, não do payload.
  const decidido = exigirEstrategiaDoAdaptador(eventoDe({ canal: 'formulario' }), 'openclaw_webhook');
  assert.equal(decidido.estrategia_ia, 'crm_despacha');
});

test('f. estratégia inexistente é recusada já no contrato', () => {
  assert.throws(
    () => eventoDe({ canal: 'whatsapp', estrategia_ia: 'deixa_que_eu_decido' }),
    /estrategia_ia/,
  );
});

test('g. payload não escolhe o proprietário: canal sem agente não reivindica openclaw_gerencia', () => {
  assert.throws(
    () => exigirEstrategiaDoAdaptador(
      eventoDe({ canal: 'site', estrategia_ia: 'openclaw_gerencia' }),
      'openclaw_webhook',
    ),
    (erro) => erro.codigo === 'estrategia_ia_incompativel',
  );

  // E o sincronizador do WhatsApp carimba o dono ele mesmo — reivindicação
  // contrária que chegasse até ele também é recusada.
  assert.throws(
    () => exigirEstrategiaDoAdaptador(
      eventoDe({ canal: 'whatsapp', estrategia_ia: 'crm_despacha' }),
      'sincronia_whatsapp',
    ),
    (erro) => erro.codigo === 'estrategia_ia_incompativel',
  );
  const carimbado = exigirEstrategiaDoAdaptador(eventoDe({ canal: 'whatsapp' }), 'sincronia_whatsapp');
  assert.equal(carimbado.estrategia_ia, 'openclaw_gerencia');
});

// ------------------------------------------------------------ pela porta HTTP

test('h. reentrega mantém a mesma estratégia no recibo', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const corpo = {
    ...BASE, canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'estrategia:reentrega',
  };
  const primeira = await (await enviar(app, corpo)).json();
  const segunda = await (await enviar(app, corpo)).json();

  assert.equal(primeira.estrategia_ia, 'openclaw_gerencia');
  assert.equal(segunda.estrategia_ia, 'openclaw_gerencia');
  assert.equal(segunda.duplicado, true);
  assert.equal(segunda.decisao_transporte, primeira.decisao_transporte);
});

test('i. a chave de idempotência não muda com a estratégia', async () => {
  const semEstrategia = eventoDe({ canal: 'site' });
  const comEstrategia = eventoDe({ canal: 'site', estrategia_ia: 'crm_despacha' });
  // Identidade é canal+tipo+id_externo. A estratégia diz quem responde, não
  // QUAL evento é — entrar nela mudaria a chave a cada reenvio corrigido.
  assert.equal(semEstrategia.chave_idempotencia, comEstrategia.chave_idempotencia);
});

test('j. a recusa não expõe detalhe interno — e fica auditada', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, { ...BASE, canal: 'whatsapp', id_externo: 'estrategia:ambigua' });
  assert.equal(resposta.status, 422);

  const corpo = await resposta.json();
  assert.deepEqual(Object.keys(corpo).sort(), ['codigo', 'erro']);
  assert.equal(corpo.codigo, 'estrategia_ia_ambigua');
  assert.ok(!/stack|repositorio|sql|node_modules/i.test(JSON.stringify(corpo)));

  // A recusa deixou rastro: sem ele, um integrador quebrado seria invisível.
  const recusa = repositorio._auditoria.find((linha) => linha.acao === 'evento_recusado_estrategia');
  assert.ok(recusa, 'a recusa precisa estar no audit_log');
  assert.equal(recusa.detalhe.codigo, 'estrategia_ia_ambigua');
});

test('k. só o adaptador da Arquitetura B torna WhatsApp crm_despacha', () => {
  const carimbado = exigirEstrategiaDoAdaptador(
    eventoDe({ canal: 'whatsapp' }),
    'sincronia_whatsapp_crm',
  );
  assert.equal(carimbado.estrategia_ia, 'crm_despacha');

  assert.throws(
    () => exigirEstrategiaDoAdaptador(
      eventoDe({ canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia' }),
      'sincronia_whatsapp_crm',
    ),
    (erro) => erro.codigo === 'estrategia_ia_incompativel',
  );
});
