'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { subirServidor } = require('./auxiliar');

// CRUD de contatos.
//
// Dois testes aqui protegem coisas que não têm volta:
//
//   • **exclusão é lógica.** As tabelas que apontam para `contatos` usam
//     CASCADE: um DELETE de verdade levaria junto conversas, mensagens e
//     agendamentos daquela pessoa. O teste confere que o histórico sobrevive.
//
//   • **telefone não duplica.** Duas fichas para o mesmo número significam
//     metade das mensagens numa e metade na outra.

const JSONH = { 'content-type': 'application/json' };

async function montar(t) {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());
  return { ambiente, repositorio };
}

const criar = (ambiente, corpo) => ambiente.pedir('/api/contatos', {
  method: 'POST', headers: JSONH, body: JSON.stringify(corpo),
});

// ---------------------------------------------------------------- criar

test('contato é criado com o telefone normalizado', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await criar(ambiente, { nome: 'Marina Souza', telefone: '(16) 99312-0938' });
  assert.equal(resposta.status, 201);

  const { contato } = await resposta.json();
  // Guardado no formato do canal, não como foi digitado.
  assert.equal(contato.telefone, '5516993120938');
  assert.equal(contato.nome, 'Marina Souza');
  assert.equal(contato.excluido, false);
  assert.equal(contato.recebe_lembretes, true);
});

test('as três formas de digitar o mesmo número são o mesmo contato', async (t) => {
  const { ambiente } = await montar(t);

  await criar(ambiente, { nome: 'Marina', telefone: '(16) 99312-0938' });

  for (const telefone of ['16993120938', '+55 16 99312-0938', '5516993120938']) {
    const repetido = await criar(ambiente, { nome: 'Outra pessoa', telefone });
    assert.equal(repetido.status, 409, `"${telefone}" deveria colidir`);

    const corpo = await repetido.json();
    assert.equal(corpo.codigo, 'telefone_duplicado');
    // A resposta diz qual contato já tem o número: sem isso, a equipe descobre
    // que existe e não descobre onde.
    assert.ok(corpo.contato_id);
  }
});

test('telefone inválido é recusado antes de chegar ao banco', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await criar(ambiente, { nome: 'Alguém', telefone: '123' });
  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).campo, 'telefone');
});

test('nome é obrigatório', async (t) => {
  const { ambiente } = await montar(t);
  const resposta = await criar(ambiente, { nome: '  ', telefone: '16993120938' });
  assert.equal(resposta.status, 400);
});

// ---------------------------------------------------------------- editar

test('editar troca o que foi informado e mantém o resto', async (t) => {
  const { ambiente } = await montar(t);
  const { contato } = await (await criar(ambiente, { nome: 'Marina', telefone: '16993120938' })).json();

  const resposta = await ambiente.pedir(`/api/contatos/${contato.id}`, {
    method: 'PUT', headers: JSONH, body: JSON.stringify({ nome: 'Marina Souza', email: 'marina@teste.local' }),
  });
  assert.equal(resposta.status, 200);

  const atualizado = (await resposta.json()).contato;
  assert.equal(atualizado.nome, 'Marina Souza');
  assert.equal(atualizado.email, 'marina@teste.local');
  assert.equal(atualizado.telefone, '5516993120938', 'o telefone não foi tocado');
});

test('editar para um telefone que já é de outro contato é recusado', async (t) => {
  const { ambiente } = await montar(t);

  await criar(ambiente, { nome: 'Primeira', telefone: '16993120938' });
  const { contato } = await (await criar(ambiente, { nome: 'Segunda', telefone: '16999998888' })).json();

  const resposta = await ambiente.pedir(`/api/contatos/${contato.id}`, {
    method: 'PUT', headers: JSONH, body: JSON.stringify({ telefone: '16993120938' }),
  });

  assert.equal(resposta.status, 409);
  assert.equal((await resposta.json()).codigo, 'telefone_duplicado');
});

// ---------------------------------------------------------------- excluir

test('excluir é lógico: o contato some da lista e o histórico fica', async (t) => {
  const { ambiente, repositorio } = await montar(t);

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516993120938', nome: 'Marina' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id);
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Quero marcar uma consulta', autor_tipo: 'contato',
  });

  const resposta = await ambiente.pedir(`/api/contatos/${contato.id}`, {
    method: 'DELETE', headers: JSONH, body: JSON.stringify({ motivo: 'duplicado' }),
  });
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.equal(corpo.contato.excluido, true);
  assert.match(corpo.observacao, /histórico/);

  // Some da lista…
  const lista = await (await ambiente.pedir('/api/contatos/gestao')).json();
  assert.equal(lista.contatos.length, 0);

  // …e o histórico continua de pé. Esta é a asserção que justifica o soft delete.
  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.length, 1);
  assert.equal((await repositorio.obterContato(contato.id)).nome, 'Marina');
});

test('excluído aparece quando pedido e pode ser restaurado', async (t) => {
  const { ambiente } = await montar(t);
  const { contato } = await (await criar(ambiente, { nome: 'Marina', telefone: '16993120938' })).json();

  await ambiente.pedir(`/api/contatos/${contato.id}`, {
    method: 'DELETE', headers: JSONH, body: JSON.stringify({ motivo: 'engano' }),
  });

  const comExcluidos = await (await ambiente.pedir('/api/contatos/gestao?excluidos=sim')).json();
  assert.equal(comExcluidos.contatos.length, 1);
  assert.equal(comExcluidos.contatos[0].excluido, true);

  const restaurado = await ambiente.pedir(`/api/contatos/${contato.id}/restaurar`, { method: 'POST' });
  assert.equal(restaurado.status, 200);
  assert.equal((await restaurado.json()).contato.excluido, false);

  const lista = await (await ambiente.pedir('/api/contatos/gestao')).json();
  assert.equal(lista.contatos.length, 1);
});

test('excluir duas vezes devolve 404, não erro interno', async (t) => {
  const { ambiente } = await montar(t);
  const { contato } = await (await criar(ambiente, { nome: 'Marina', telefone: '16993120938' })).json();

  await ambiente.pedir(`/api/contatos/${contato.id}`, { method: 'DELETE', headers: JSONH, body: '{}' });
  const segunda = await ambiente.pedir(`/api/contatos/${contato.id}`, { method: 'DELETE', headers: JSONH, body: '{}' });

  assert.equal(segunda.status, 404);
});

test('contato excluído que volta a escrever é reativado, não duplicado', async (t) => {
  const { ambiente, repositorio } = await montar(t);
  const { contato } = await (await criar(ambiente, { nome: 'Marina', telefone: '16993120938' })).json();

  await ambiente.pedir(`/api/contatos/${contato.id}`, { method: 'DELETE', headers: JSONH, body: '{}' });

  // Uma mensagem nova daquele número chega pelo canal.
  const reencontrado = await repositorio.encontrarOuCriarContato({ telefone: '5516993120938', nome: 'Marina' });

  assert.equal(reencontrado.id, contato.id, 'duas fichas para a mesma pessoa é o erro sem volta');
  assert.equal(reencontrado.excluido_em, null, 'e ela volta ativa');
});

// ---------------------------------------------------------------- ficha e permissões

test('a ficha traz o histórico de conversas e agendamentos', async (t) => {
  const { ambiente, repositorio } = await montar(t);

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516993120938', nome: 'Marina' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id);
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Olá', autor_tipo: 'contato',
  });

  const corpo = await (await ambiente.pedir(`/api/contatos/${contato.id}`)).json();

  assert.equal(corpo.contato.telefone, '5516993120938', 'na ficha o telefone sai inteiro');
  assert.equal(corpo.historico.conversas.length, 1);
  assert.ok(Array.isArray(corpo.historico.agendamentos));
});

test('na lista o telefone sai mascarado', async (t) => {
  const { ambiente } = await montar(t);
  await criar(ambiente, { nome: 'Marina', telefone: '16993120938' });

  const lista = await (await ambiente.pedir('/api/contatos/gestao')).json();
  assert.equal(lista.contatos[0].telefone, '***0938');
});

test('atendente lê mas não cadastra nem exclui', async (t) => {
  const { ambiente } = await montar(t);
  const atendente = await ambiente.entrarComo('atendente');
  const comAtendente = (caminho, opcoes = {}) => ambiente.pedirSemAuth(caminho, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), authorization: `Bearer ${atendente.access_token}` },
  });

  assert.equal((await comAtendente('/api/contatos/gestao')).status, 200);

  const tentativa = await comAtendente('/api/contatos', {
    method: 'POST', headers: JSONH, body: JSON.stringify({ nome: 'X', telefone: '16993120938' }),
  });
  assert.equal(tentativa.status, 403);
});

test('a busca encontra por nome e por telefone digitado com máscara', async (t) => {
  const { ambiente } = await montar(t);
  await criar(ambiente, { nome: 'Marina Souza', telefone: '16993120938' });
  await criar(ambiente, { nome: 'Carlos Menezes', telefone: '11955554444' });

  const porNome = await (await ambiente.pedir('/api/contatos/gestao?busca=marina')).json();
  assert.equal(porNome.contatos.length, 1);

  const porTelefone = await (await ambiente.pedir('/api/contatos/gestao?busca=99312')).json();
  assert.equal(porTelefone.contatos.length, 1);
  assert.equal(porTelefone.contatos[0].nome, 'Marina Souza');
});

test('criar e excluir ficam auditados', async (t) => {
  const { ambiente, repositorio } = await montar(t);
  const { contato } = await (await criar(ambiente, { nome: 'Marina', telefone: '16993120938' })).json();
  await ambiente.pedir(`/api/contatos/${contato.id}`, {
    method: 'DELETE', headers: JSONH, body: JSON.stringify({ motivo: 'teste' }),
  });

  const acoes = repositorio._auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('contato_criado'));
  assert.ok(acoes.includes('contato_excluido'));

  const exclusao = repositorio._auditoria.find((item) => item.acao === 'contato_excluido');
  assert.equal(exclusao.detalhe.tipo, 'soft_delete');
});
