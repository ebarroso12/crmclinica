'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { subirServidor } = require('./auxiliar');

test('auditoria é paginada, redigida e exclusiva de gestor/admin', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({ entidade: 'usuarios', entidadeId: 9, acao: 'teste', detalhe: { senha_hash: 'nunca-exibir', visivel: true } });
  const app = await subirServidor({ repositorio });
  t.after(() => app.encerrar());
  const resposta = await app.pedir('/api/auditoria?limite=10');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.ok(corpo.itens.length >= 1);
  const evento = corpo.itens.find((item) => item.acao === 'teste');
  assert.deepEqual(evento.detalhe, { visivel: true });
  const atendente = await app.entrarComo('atendente');
  const negada = await fetch(`${app.base}/api/auditoria`, { headers: { authorization: `Bearer ${atendente.access_token}` } });
  assert.equal(negada.status, 403);
});
