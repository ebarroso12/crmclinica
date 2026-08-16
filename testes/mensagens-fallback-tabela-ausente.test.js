'use strict';

// BLOQUEADOR 2 da auditoria independente do PR #34: um rollback da migration
// 037 (ou um deploy do código novo ANTES da migration rodar) faz
// `conversas_eventos` sumir. `listarMensagens` (src/servidor/rotas-conversas.js)
// só testava se o MÉTODO existia no repositório — não se a TABELA existia no
// banco — então o erro de Postgres (`42P01 undefined_table`) subia sem
// `try/catch` e virava HTTP 500 em GET /api/conversas/:id/mensagens: a
// recepção perdia a thread INTEIRA (mensagens que existem de verdade),
// não só os eventos operacionais que a 037 adicionou.
//
// A correção precisa degradar SÓ para 42P01 (objeto ausente — o único erro
// esperado nesse cenário) e propagar qualquer outro (permissão, conexão,
// corrupção) — nunca mascarar o que não é "a tabela não existe". Como
// `repositorio-memoria` nunca lança 42P01 de verdade (não fala SQL), estes
// testes usam um repositório FALSO que embrulha o de memória e troca só o
// método relevante por um que lança o erro exato que o driver `pg` daria —
// prova o comportamento de `rotas-conversas.js` sem precisar de Postgres
// real. A prova equivalente CONTRA Postgres de verdade (DROP TABLE de
// verdade) está em testes/conversas-eventos-tabela-ausente-pg.test.js
// (só roda com `npm run test:pg`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  return {
    disponivel: true,
    despacharEvento: async () => resposta,
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

function erroPg(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { code: codigo });
}

async function montar({ falhaEmEventosOperacionais = null } = {}) {
  const base = criarRepositorioEmMemoria();
  const repositorio = {
    ...base,
    async listarEventosOperacionaisDaConversa(conversaId) {
      if (falhaEmEventosOperacionais) throw falhaEmEventosOperacionais;
      return base.listarEventosOperacionaisDaConversa(conversaId);
    },
  };
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:fallback:1',
    remetente: '5516900000201', nome: 'Paciente Fallback', texto: 'Olá',
  });
  const [conversa] = await repositorio.listarConversas({});

  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste() });
  return { app, repositorio, conversa };
}

test('42P01 (tabela ausente): GET /mensagens degrada para só as mensagens, sem 500', async (t) => {
  const { app, conversa } = await montar({
    falhaEmEventosOperacionais: erroPg('42P01', 'relation "conversas_eventos" does not exist'),
  });
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversa.id}/mensagens`);
  assert.equal(resposta.status, 200, 'a thread precisa continuar acessível mesmo com conversas_eventos ausente');

  const itens = await resposta.json();
  assert.ok(Array.isArray(itens) && itens.length >= 1, 'a mensagem original (fonte de verdade) precisa continuar aparecendo');
  assert.ok(itens.every((item) => item.tipo_item === 'mensagem'), 'sem a tabela, só pode haver itens do tipo mensagem');
});

test('42501 (permissão) ou qualquer outro erro do banco NÃO é mascarado — propaga como falha', async (t) => {
  const { app, conversa } = await montar({
    falhaEmEventosOperacionais: erroPg('42501', 'permission denied for table conversas_eventos'),
  });
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversa.id}/mensagens`);
  assert.equal(resposta.status, 500, 'erro de permissão não pode ser confundido com "tabela ausente" — precisa propagar');
});

test('erro de conexão (sem código de "objeto ausente") também propaga, não vira thread vazia silenciosa', async (t) => {
  const { app, conversa } = await montar({
    falhaEmEventosOperacionais: erroPg('ECONNREFUSED', 'connection refused'),
  });
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversa.id}/mensagens`);
  assert.equal(resposta.status, 500, 'falha de conexão precisa propagar, não degradar como se fosse tabela ausente');
});

test('caminho feliz (sem 42P01): eventos operacionais continuam aparecendo normalmente', async (t) => {
  const { app, repositorio, conversa } = await montar();
  t.after(() => app.encerrar());

  await repositorio.registrarEventoDeConversa({ conversaId: conversa.id, tipo: 'conversa_resolvida', payload: {} });

  const resposta = await app.pedir(`/api/conversas/${conversa.id}/mensagens`);
  assert.equal(resposta.status, 200);
  const itens = await resposta.json();
  assert.ok(itens.some((item) => item.tipo_item === 'evento' && item.tipo === 'conversa_resolvida'),
    'sem falha nenhuma, o evento operacional precisa continuar aparecendo na thread — o fallback não pode virar o comportamento padrão');
});
