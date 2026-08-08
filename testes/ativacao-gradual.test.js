'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { decidirResposta, contatoNaAtivacao } = require('../src/dominio/serena');
const { subirServidor } = require('./auxiliar');

// Ativação gradual da Serena (P3-05): religar sem ser tudo-ou-nada.
//
// As garantias: o percentual é DETERMINÍSTICO por contato (nada de sorteio por
// mensagem), a lista é explícita, o desligado global continua soberano, e quem
// fica de fora tem a mensagem REGISTRADA — só a resposta cala.

test('percentual é determinístico: o mesmo contato cai sempre do mesmo lado', () => {
  const configuracao = { ativa: true, modo_ativacao: 'percentual', ativacao_percentual: 50 };

  for (let contatoId = 1; contatoId <= 20; contatoId += 1) {
    const primeira = contatoNaAtivacao(contatoId, configuracao);
    for (let repeticao = 0; repeticao < 5; repeticao += 1) {
      assert.equal(contatoNaAtivacao(contatoId, configuracao), primeira,
        `contato ${contatoId} mudou de lado entre chamadas`);
    }
  }
});

test('0% não atende ninguém; 100% atende todos', () => {
  for (let contatoId = 1; contatoId <= 50; contatoId += 1) {
    assert.equal(contatoNaAtivacao(contatoId, {
      modo_ativacao: 'percentual', ativacao_percentual: 0,
    }), false);
    assert.equal(contatoNaAtivacao(contatoId, {
      modo_ativacao: 'percentual', ativacao_percentual: 100,
    }), true);
  }
});

test('o percentual reparte de verdade: 30% atende perto de 30 em cada 100', () => {
  const configuracao = { modo_ativacao: 'percentual', ativacao_percentual: 30 };
  let atendidos = 0;
  for (let contatoId = 1; contatoId <= 1000; contatoId += 1) {
    if (contatoNaAtivacao(contatoId, configuracao)) atendidos += 1;
  }
  assert.ok(atendidos > 200 && atendidos < 400,
    `30% de 1000 deveria atender ~300; atendeu ${atendidos}`);
});

test('modo lista: só quem está na allowlist', () => {
  const configuracao = { modo_ativacao: 'lista', ativacao_contatos: [7, 42] };
  assert.equal(contatoNaAtivacao(7, configuracao), true);
  assert.equal(contatoNaAtivacao(42, configuracao), true);
  assert.equal(contatoNaAtivacao(8, configuracao), false);
});

test('o desligado global é soberano sobre qualquer modo de ativação', () => {
  const decisao = decidirResposta(
    { contato_id: 7 },
    { ativa: false, modo_ativacao: 'lista', ativacao_contatos: [7] },
  );
  assert.equal(decisao.responder, false);
  assert.equal(decisao.motivo, 'serena_desligada', 'estar na lista não fura o desligamento');
});

test('fora da ativação: a mensagem é registrada, a resposta cala, o motivo fica auditado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const despachos = [];
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: true, despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'oi' }; } },
    serena,
  });

  await serena.definirAtivacao({ modo: 'percentual', percentual: 0 });

  const resultado = await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:ativ:1',
    remetente: '5511966660001', nome: 'Fora do Rollout', texto: 'Olá!',
  });

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'fora_da_ativacao_gradual');
  assert.equal(despachos.length, 0);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1,
    'ficar fora do rollout não apaga o inbox');
});

test('modo lista funciona de ponta a ponta: incluído responde, não incluído espera a equipe', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const despachos = [];
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: true, despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'oi' }; } },
    serena,
  });

  await serena.definirAtivacao({ modo: 'lista' });

  const incluido = await repositorio.encontrarOuCriarContato({
    telefone: '5511966660002', nome: 'Incluído', canal: 'whatsapp',
  });
  await serena.definirContatoDeAtivacao(incluido.id, true);

  const dele = await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:ativ:2',
    remetente: '5511966660002', nome: 'Incluído', texto: 'Oi!',
  });
  assert.equal(dele.acao, 'respondida_pela_automacao');

  const deFora = await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:ativ:3',
    remetente: '5511966660003', nome: 'De Fora', texto: 'Oi!',
  });
  assert.equal(deFora.acao, 'aguardando_equipe');
  assert.equal(deFora.motivo, 'fora_da_ativacao_gradual');
});

test('validações: modo desconhecido e percentual fora de 0-100 são recusados', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });

  await assert.rejects(() => serena.definirAtivacao({ modo: 'metade' }), /todos, percentual ou lista/);
  await assert.rejects(() => serena.definirAtivacao({ modo: 'percentual', percentual: 150 }), /0 a 100/);
});

test('PUT /api/serena/ativacao por HTTP: admin define, atendente é recusado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const resposta = await ambiente.pedir('/api/serena/ativacao', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modo: 'percentual', percentual: 25 }),
    });
    assert.equal(resposta.status, 200);
    assert.deepEqual((await resposta.json()).ativacao, { modo: 'percentual', percentual: 25 });

    const atendente = await ambiente.entrarComo('atendente');
    const recusada = await ambiente.pedirSemAuth('/api/serena/ativacao', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${atendente.access_token}` },
      body: JSON.stringify({ modo: 'todos' }),
    });
    assert.equal(recusada.status, 403);
  } finally {
    await ambiente.encerrar();
  }
});
