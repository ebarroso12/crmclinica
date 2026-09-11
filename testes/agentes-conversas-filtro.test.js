'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { validarAgente } = require('../src/dominio/agentes/regras');

// Filtro "de quem é a conversa" na lista do inbox (GET /api/conversas?agente=…),
// exercido de ponta a ponta sobre o repositório em memória. O filtro no banco já
// existia (`listarConversas({ agenteId })`, com teste de contrato); isto prova
// que a rota HTTP o repassa e que valor estranho vira 400, não lista inteira.
//
// NÃO prova o SQL do PostgreSQL (coberto pela suíte de contrato com banco) nem
// o desenho do seletor na tela.

async function subir() {
  const repositorio = criarRepositorioEmMemoria();
  const agente = await repositorio.criarAgente(
    validarAgente({ slug: 'alpins', nome: 'Agente Alpins' }),
    { usuarioId: null },
  );
  const cliente = await repositorio.encontrarOuCriarContato({ telefone: '5516900002001', nome: 'Cliente da Loja' });
  const paciente = await repositorio.encontrarOuCriarContato({ telefone: '5516900002002', nome: 'Paciente da Clínica' });
  const doAgente = await repositorio.encontrarOuCriarConversaAberta(cliente.id, 'whatsapp', { agenteId: agente.id });
  const daClinica = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp');

  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste() });
  return { app, agente, doAgente, daClinica };
}

async function listar(app, consulta) {
  const resposta = await app.pedir(`/api/conversas?${consulta}`);
  return { status: resposta.status, dados: await resposta.json() };
}

test('sem filtro, a lista traz clínica e agente, com o nome do agente na conversa dele', async (t) => {
  const { app, doAgente, daClinica } = await subir();
  t.after(() => app.encerrar());

  const { status, dados } = await listar(app, 'fila=todos');
  assert.equal(status, 200);
  const porId = new Map(dados.conversas.map((conversa) => [conversa.id, conversa]));
  assert.equal(porId.get(doAgente.id)?.agente_nome, 'Agente Alpins');
  assert.equal(porId.get(daClinica.id)?.agente_nome, null);
});

test('agente=clinica traz só as conversas sem agente', async (t) => {
  const { app, doAgente, daClinica } = await subir();
  t.after(() => app.encerrar());

  const { status, dados } = await listar(app, 'fila=todos&agente=clinica');
  assert.equal(status, 200);
  const ids = dados.conversas.map((conversa) => conversa.id);
  assert.ok(ids.includes(daClinica.id));
  assert.ok(!ids.includes(doAgente.id), 'conversa do agente não aparece no filtro da clínica');
});

test('agente=<id> traz só as conversas daquele agente', async (t) => {
  const { app, agente, doAgente } = await subir();
  t.after(() => app.encerrar());

  const { status, dados } = await listar(app, `fila=todos&agente=${agente.id}`);
  assert.equal(status, 200);
  assert.deepEqual(dados.conversas.map((conversa) => conversa.id), [doAgente.id]);
});

test('agente com valor inválido responde 400 em vez de ignorar o filtro', async (t) => {
  const { app } = await subir();
  t.after(() => app.encerrar());

  for (const valor of ['abc', '0', '-1', '1.5']) {
    const { status } = await listar(app, `fila=todos&agente=${valor}`);
    assert.equal(status, 400, `agente=${valor}`);
  }
});
