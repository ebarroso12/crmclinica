'use strict';

// CRUD de contatos_bloqueados contra o repositório em memória — mesma
// interface do PostgreSQL real (db/040_contatos_bloqueados.sql).

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('cria, lista e obtém por telefone', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const criado = await repositorio.criarContatoBloqueado({
    telefone: '5511996026888', nome: 'Marciandrea', motivo: 'teste',
  });

  assert.ok(criado.id);
  assert.equal(criado.telefone, '5511996026888');

  const lista = await repositorio.listarContatosBloqueados();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, criado.id);

  const porTelefone = await repositorio.obterBloqueioPorTelefone('5511996026888');
  assert.equal(porTelefone.id, criado.id);

  const semBloqueio = await repositorio.obterBloqueioPorTelefone('5500000000000');
  assert.equal(semBloqueio, null);
});

test('telefone duplicado é recusado com código de conflito (23505)', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.criarContatoBloqueado({ telefone: '5511996026888', nome: 'A', motivo: 'x' });

  await assert.rejects(
    () => repositorio.criarContatoBloqueado({ telefone: '5511996026888', nome: 'B', motivo: 'y' }),
    (erro) => erro.code === '23505',
  );
});

test('atualiza campos parciais sem apagar os demais', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const criado = await repositorio.criarContatoBloqueado({
    telefone: '5511996026888', nome: 'Marciandrea', motivo: 'motivo original',
  });

  const atualizado = await repositorio.atualizarContatoBloqueado(criado.id, { motivo: 'motivo novo' });
  assert.equal(atualizado.motivo, 'motivo novo');
  assert.equal(atualizado.nome, 'Marciandrea', 'nome não deve mudar quando só motivo foi enviado');
});

test('remove de verdade — hard delete, some da lista e do lookup por telefone', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const criado = await repositorio.criarContatoBloqueado({
    telefone: '5511996026888', nome: 'Marciandrea', motivo: 'teste',
  });

  const removido = await repositorio.removerContatoBloqueado(criado.id);
  assert.equal(removido, true);

  assert.equal(await repositorio.obterContatoBloqueado(criado.id), null);
  assert.equal(await repositorio.obterBloqueioPorTelefone('5511996026888'), null);
  assert.deepEqual(await repositorio.listarContatosBloqueados(), []);
});

test('remover id inexistente devolve false, não lança', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const removido = await repositorio.removerContatoBloqueado(999999);
  assert.equal(removido, false);
});
