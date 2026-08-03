'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

// A API da fila, pela porta de entrada: com token, com RBAC, com JSON de verdade.

const HORA = 60 * 60 * 1000;

function daquiA(horas) {
  return new Date(Date.now() + horas * HORA);
}

async function prepararAgenda(repositorio) {
  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516993120938', nome: 'Marina Souza' });

  const inicio = daquiA(72);
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id,
    contatoId: contato.id,
    inicio: inicio.toISOString(),
    fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
  });

  return { profissional, contato, agendamento, inicio };
}

test('a fila responde com o que está enfileirado e em que modo a entrega está', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const { agendamento } = await prepararAgenda(repositorio);
  // Enfileira pela API, como faria a sincronização de uma agenda já existente.
  const sincronizada = await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' });
  assert.equal(sincronizada.status, 200);
  assert.equal((await sincronizada.json()).criados, 2);

  const resposta = await ambiente.pedir('/api/lembretes');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.lembretes.length, 2);
  assert.equal(corpo.modo_entrega, 'dry_run');
  assert.ok(corpo.lembretes.every((item) => item.agendamento_id === agendamento.id));
  // O telefone não trafega inteiro numa tela de operação.
  assert.equal(corpo.lembretes[0].contato.telefone, '***0938');
});

test('sincronizar duas vezes não duplica nada', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  await prepararAgenda(repositorio);
  await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' });
  const segunda = await (await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' })).json();

  assert.equal(segunda.criados, 0);
  assert.equal(segunda.repetidos, 2);
});

test('o resumo diz, sem rodeios, que em dry-run nada sai', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/lembretes/resumo');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.entrega.modo, 'dry_run');
  assert.equal(corpo.entrega.metodo, 'gateway.send');
  assert.match(corpo.entrega.significado, /nenhuma mensagem sai/);
  // Sem gateway configurado no teste, o resumo diz o que falta para enviar.
  assert.match(corpo.entrega.motivo, /OPENCLAW_GATEWAY_URL/);
  assert.match(corpo.observacao, /dry-run/);
});

test('a agenda expõe a fila do próprio agendamento', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const { agendamento } = await prepararAgenda(repositorio);
  await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' });

  const resposta = await ambiente.pedir(`/api/agenda/${agendamento.id}/lembretes`);
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.agendamento_id, agendamento.id);
  assert.equal(corpo.lembretes.length, 2);
});

test('agendamento inexistente devolve 404, não lista vazia', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/agenda/9999/lembretes');
  assert.equal(resposta.status, 404);
});

test('marcar pela API já enfileira os dois lembretes', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999991111', nome: 'Pedro' });

  const inicio = daquiA(48);
  // Disponibilidade que cobre o horário proposto, seja qual for o dia.
  await repositorio.definirDisponibilidades(
    profissional.id,
    [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia_semana: dia, hora_inicio: '00:00', hora_fim: '23:30' })),
  );

  const proposta = await (await ambiente.pedir('/api/agenda/propor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profissional_id: profissional.id,
      contato_id: contato.id,
      inicio: inicio.toISOString(),
      fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
    }),
  })).json();

  assert.ok(proposta.token, `propor deveria devolver token: ${JSON.stringify(proposta)}`);

  const confirmada = await ambiente.pedir('/api/agenda/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: proposta.token }),
  });
  assert.equal(confirmada.status, 200);

  const fila = await (await ambiente.pedir('/api/lembretes')).json();
  assert.equal(fila.lembretes.length, 2);
  assert.ok(fila.lembretes.every((item) => item.estado === 'pendente'));
});

test('cancelar pela API tira os lembretes da fila', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const { agendamento } = await prepararAgenda(repositorio);
  await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' });

  const cancelada = await ambiente.pedir(`/api/agenda/${agendamento.id}/cancelar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ motivo: 'paciente desmarcou' }),
  });
  assert.equal(cancelada.status, 200);

  const fila = await (await ambiente.pedir('/api/lembretes')).json();
  assert.ok(fila.lembretes.every((item) => item.estado === 'ignorado'));
  assert.ok(fila.lembretes.every((item) => item.ignorado_motivo === 'agendamento_cancelado'));
});

test('o opt-out do contato é uma rota, cancela a fila e fica auditado', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const { contato } = await prepararAgenda(repositorio);
  await ambiente.pedir('/api/lembretes/sincronizar', { method: 'POST' });

  const resposta = await ambiente.pedir(`/api/contatos/${contato.id}/lembretes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receber: false, motivo: 'pediu no telefone' }),
  });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.contato.recebe_lembretes, false);
  assert.equal(corpo.cancelados, 2);
  assert.equal(corpo.contato.telefone, '***0938');

  assert.ok(repositorio._auditoria.some((item) => item.acao === 'lembretes_optout'));

  // E volta atrás quando a pessoa muda de ideia.
  const volta = await (await ambiente.pedir(`/api/contatos/${contato.id}/lembretes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receber: true }),
  })).json();
  assert.equal(volta.contato.recebe_lembretes, true);
});

test('opt-out sem o campo "receber" é recusado com 400', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const { contato } = await prepararAgenda(repositorio);
  const resposta = await ambiente.pedir(`/api/contatos/${contato.id}/lembretes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ motivo: 'sem dizer se liga ou desliga' }),
  });

  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).campo, 'receber');
});

test('a fila exige autenticação', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedirSemAuth('/api/lembretes');
  assert.equal(resposta.status, 401);
});

test('atendente consulta a fila, mas não mexe nela', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const atendente = await ambiente.entrarComo('atendente');
  const comAtendente = (caminho, opcoes = {}) => ambiente.pedirSemAuth(caminho, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), authorization: `Bearer ${atendente.access_token}` },
  });

  assert.equal((await comAtendente('/api/lembretes')).status, 200);
  // Sincronizar e reenfileirar são operação da agenda, não atendimento.
  assert.equal((await comAtendente('/api/lembretes/sincronizar', { method: 'POST' })).status, 403);
});

test('estado inexistente na consulta é erro de contrato, não lista vazia', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/lembretes?estado=quase');
  assert.equal(resposta.status, 400);
});

test('rota inexistente sob /api/lembretes devolve 404', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  assert.equal((await ambiente.pedir('/api/lembretes/inventado')).status, 404);
});

test('com os lembretes desligados, marcar não enfileira nada', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({
    repositorio,
    configuracao: configuracaoDeTeste({ LEMBRETES_ATIVOS: 'nao' }),
  });
  t.after(() => ambiente.encerrar());

  const { agendamento } = await prepararAgenda(repositorio);
  await repositorio.atualizarAgendamento(agendamento.id, { status: 'agendado' });

  const fila = await (await ambiente.pedir('/api/lembretes')).json();
  assert.equal(fila.lembretes.length, 0);
});

test('a fila do reenfileiramento recusa lembrete inexistente com 404', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const resposta = await ambiente.pedir('/api/lembretes/999/reenfileirar', { method: 'POST' });
  assert.equal(resposta.status, 404);
});

test('vocabulário publica os tipos e estados que a interface precisa conhecer', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const corpo = await (await ambiente.pedir('/api/lembretes/vocabulario')).json();
  assert.deepEqual(corpo.tipos, ['confirmacao_24h', 'confirmacao_2h']);
  assert.deepEqual(corpo.estados, ['pendente', 'processando', 'enviado', 'ignorado', 'falhou']);
});
