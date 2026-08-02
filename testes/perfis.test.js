'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// Matriz de perfis: quem pode o quê, rota por rota.
//
// A matriz do RBAC vive em `src/seguranca/rbac.js` e já tem teste unitário. Este
// arquivo prova a outra ponta: que cada rota **de fato** exige a permissão que
// deveria. Uma rota que esqueceu de chamar `exigirPermissao` passa em todos os
// testes de unidade do RBAC e mesmo assim abre a clínica inteira para quem só
// deveria atender.
//
// O quarto perfil é o backend — o webhook, que não tem papel nem token: entra
// por assinatura HMAC.

const SEGREDO_WEBHOOK = 'segredo-de-teste-para-o-webhook-1234567890';

function orquestradorFalso() {
  return {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
}

async function subir() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  await atendimento.receberMensagem({
    canal: 'whatsapp', id_externo: 'perfis:1', remetente: '5516999999999',
    nome: 'Marina', texto: 'Olá',
  });

  const configuracao = configuracaoDeTeste();
  configuracao.openclaw = { ...configuracao.openclaw, segredoWebhook: SEGREDO_WEBHOOK };

  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao });
  const [conversa] = await repositorio.listarConversas({});

  return { app, repositorio, conversa, atendimento };
}

/**
 * Cada linha: rota, método, corpo e quem pode.
 * `403` esperado para quem não pode — nunca 404 nem 500, que esconderiam a
 * diferença entre "não existe" e "não é seu".
 */
function casos(conversa) {
  return [
    {
      o_que: 'ler o inbox',
      rota: '/api/conversas', metodo: 'GET',
      podem: ['atendente', 'gestor', 'admin'],
    },
    {
      o_que: 'responder ao paciente',
      rota: `/api/conversas/${conversa.id}/mensagens`, metodo: 'POST', corpo: { texto: 'oi' },
      podem: ['atendente', 'gestor', 'admin'],
    },
    {
      o_que: 'etiquetar conversa',
      rota: `/api/conversas/${conversa.id}/etiquetas`, metodo: 'POST', corpo: { etiquetas: ['urgente'] },
      podem: ['atendente', 'gestor', 'admin'],
    },
    {
      o_que: 'priorizar conversa',
      rota: `/api/conversas/${conversa.id}/prioridade`, metodo: 'POST', corpo: { prioridade: 'alta' },
      podem: ['gestor', 'admin'],
    },
    {
      o_que: 'editar a ficha do paciente',
      rota: `/api/conversas/${conversa.id}/ficha`, metodo: 'PUT', corpo: { nome: 'Marina Souza' },
      podem: ['gestor', 'admin'],
    },
    {
      o_que: 'buscar contato',
      rota: '/api/contatos?busca=Marina', metodo: 'GET',
      podem: ['atendente', 'gestor', 'admin'],
    },
    {
      o_que: 'ver o kanban de leads',
      rota: '/api/leads', metodo: 'GET',
      podem: ['atendente', 'gestor', 'admin'],
    },
    {
      o_que: 'listar usuários',
      rota: '/api/usuarios', metodo: 'GET',
      podem: ['admin'],
    },
  ];
}

test('matriz de perfis: cada rota exige a permissão certa', async (t) => {
  const { app, conversa } = await subir();
  t.after(() => app.encerrar());

  const sessoes = {};
  for (const papel of ['atendente', 'gestor', 'admin']) {
    sessoes[papel] = await app.entrarComo(papel, {
      email: `${papel}-matriz@teste.local`,
      master: papel === 'admin',
    });
  }

  for (const caso of casos(conversa)) {
    for (const papel of ['atendente', 'gestor', 'admin']) {
      const resposta = await app.pedirSemAuth(caso.rota, {
        method: caso.metodo,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessoes[papel].access_token}`,
        },
        body: caso.corpo ? JSON.stringify(caso.corpo) : undefined,
      });

      const deveria = caso.podem.includes(papel);
      if (deveria) {
        assert.ok(
          resposta.status < 400,
          `${papel} deveria poder ${caso.o_que} — recebeu ${resposta.status}`,
        );
      } else {
        assert.equal(
          resposta.status, 403,
          `${papel} NÃO deveria poder ${caso.o_que}`,
        );
      }
    }
  }
});

test('sem token, toda a matriz responde 401', async (t) => {
  const { app, conversa } = await subir();
  t.after(() => app.encerrar());

  for (const caso of casos(conversa)) {
    const resposta = await app.pedirSemAuth(caso.rota, {
      method: caso.metodo,
      headers: { 'content-type': 'application/json' },
      body: caso.corpo ? JSON.stringify(caso.corpo) : undefined,
    });

    assert.equal(resposta.status, 401, `${caso.o_que} respondeu sem sessão`);
  }
});

// ---------------------------------------------------------------- backend

test('backend: o webhook entra por assinatura, não por papel', async (t) => {
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const evento = {
    canal: 'whatsapp',
    id_externo: 'perfis:backend:1',
    remetente: '5516988887777',
    nome: 'Paciente Novo',
    texto: 'Bom dia, gostaria de marcar',
  };
  const corpo = JSON.stringify(evento);
  const assinatura = crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(corpo).digest('hex');

  const antes = (await repositorio.listarConversas({})).length;

  const resposta = await app.pedirSemAuth('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': `sha256=${assinatura}` },
    body: corpo,
  });

  assert.ok(resposta.status < 300, `webhook assinado deveria passar — recebeu ${resposta.status}`);
  assert.equal((await repositorio.listarConversas({})).length, antes + 1);
});

test('backend: assinatura errada não entra, mesmo com corpo válido', async (t) => {
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const corpo = JSON.stringify({
    canal: 'whatsapp', id_externo: 'perfis:backend:2',
    remetente: '5516911112222', texto: 'oi',
  });
  const antes = (await repositorio.listarConversas({})).length;

  const resposta = await app.pedirSemAuth('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': 'sha256=naoconfere' },
    body: corpo,
  });

  assert.equal(resposta.status, 401);
  assert.equal((await repositorio.listarConversas({})).length, antes, 'nada pode ser gravado');
});

test('backend: token de usuário não abre o webhook', async (t) => {
  const { app } = await subir();
  t.after(() => app.encerrar());

  // O webhook é uma porta de máquina. Um admin logado no painel não deve poder
  // injetar mensagem de paciente por ela — o caminho dele é a rota de conversas.
  const admin = await app.entrarComo('admin', { email: 'admin-webhook@teste.local', master: true });

  const resposta = await app.pedirSemAuth('/api/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${admin.access_token}`,
    },
    body: JSON.stringify({
      canal: 'whatsapp', id_externo: 'perfis:backend:3',
      remetente: '5516933334444', texto: 'oi',
    }),
  });

  assert.equal(resposta.status, 401, 'sem assinatura não entra, nem com token de admin');
});
