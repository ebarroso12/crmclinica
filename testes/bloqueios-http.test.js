'use strict';

// Rota /api/bloqueios — RBAC (admin/gestor gerenciam, atendente não) e CRUD
// via HTTP real, contra o repositório em memória.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('atendente não pode listar nem criar bloqueio (403)', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'atendente', master: false });
  t.after(() => app.encerrar());

  const respostaListar = await fetch(`${app.base}/api/bloqueios`, {
    headers: { authorization: `Bearer ${app.sessao.access_token}` },
  });
  assert.equal(respostaListar.status, 403);

  const respostaCriar = await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.sessao.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'X', telefone: '11999998888', motivo: 'teste' }),
  });
  assert.equal(respostaCriar.status, 403);
});

test('admin cria, lista, edita e remove um bloqueio', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'admin', master: false });
  t.after(() => app.encerrar());
  const cabecalhos = { authorization: `Bearer ${app.sessao.access_token}`, 'content-type': 'application/json' };

  const vazio = await fetch(`${app.base}/api/bloqueios`, { headers: cabecalhos });
  assert.equal(vazio.status, 200);
  assert.equal((await vazio.json()).total, 0);

  const criar = await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST', headers: cabecalhos,
    body: JSON.stringify({ nome: 'Marciandrea', telefone: '+55 11 99602-6888', motivo: 'Quer retorno' }),
  });
  assert.equal(criar.status, 201);
  const { bloqueio } = await criar.json();
  assert.equal(bloqueio.telefone, '5511996026888', 'telefone precisa sair normalizado (só dígitos)');
  assert.equal(bloqueio.nome, 'Marciandrea');

  const lista = await fetch(`${app.base}/api/bloqueios`, { headers: cabecalhos });
  assert.equal((await lista.json()).total, 1);

  const editar = await fetch(`${app.base}/api/bloqueios/${bloqueio.id}`, {
    method: 'PUT', headers: cabecalhos, body: JSON.stringify({ motivo: 'motivo atualizado' }),
  });
  assert.equal(editar.status, 200);
  assert.equal((await editar.json()).bloqueio.motivo, 'motivo atualizado');

  const remover = await fetch(`${app.base}/api/bloqueios/${bloqueio.id}`, {
    method: 'DELETE', headers: cabecalhos,
  });
  assert.equal(remover.status, 200);

  const listaFinal = await fetch(`${app.base}/api/bloqueios`, { headers: cabecalhos });
  assert.equal((await listaFinal.json()).total, 0, 'hard delete: some da lista de verdade');
});

test('gestor também pode gerenciar (mesmo nível que admin)', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'gestor', master: false });
  t.after(() => app.encerrar());

  const criar = await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.sessao.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'Teste', telefone: '11988887777', motivo: 'motivo' }),
  });
  assert.equal(criar.status, 201);
});

test('telefone duplicado devolve 409, não 500', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'admin', master: false });
  t.after(() => app.encerrar());
  const cabecalhos = { authorization: `Bearer ${app.sessao.access_token}`, 'content-type': 'application/json' };

  await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST', headers: cabecalhos,
    body: JSON.stringify({ nome: 'A', telefone: '11999998888', motivo: 'x' }),
  });
  const segunda = await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST', headers: cabecalhos,
    body: JSON.stringify({ nome: 'B', telefone: '11999998888', motivo: 'y' }),
  });
  assert.equal(segunda.status, 409);
});

test('telefone inválido é recusado com erro de contrato, não aceito calado', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'admin', master: false });
  t.after(() => app.encerrar());

  const resposta = await fetch(`${app.base}/api/bloqueios`, {
    method: 'POST',
    headers: { authorization: `Bearer ${app.sessao.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'X', telefone: 'abc', motivo: 'teste' }),
  });
  assert.equal(resposta.status, 400);
});
