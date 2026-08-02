'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// As rotas da agenda vistas por cada papel.
//
// O RBAC do produto vive no código, não no banco: a aplicação conecta com uma
// credencial só, e o PostgreSQL não tem como saber se quem pediu é atendente ou
// gestor. Então é aqui que "atendente marca consulta mas não mexe na grade da
// clínica" precisa estar provado.

function orquestradorFalso() {
  return {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
}

async function subirAgenda() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  await atendimento.receberMensagem({
    canal: 'whatsapp', id_externo: 'ag:1', remetente: '5516999999999',
    nome: 'Marina', texto: 'Quero marcar',
  });

  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena', duracaoMin: 30 });
  // Todos os dias da semana, para o teste não depender de quando roda.
  await repositorio.definirDisponibilidades(profissional.id, [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
    dia_semana: dia, hora_inicio: '08:00', hora_fim: '18:00',
  })));

  const app = await subirServidor({
    repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste(),
  });

  return { app, repositorio, profissional };
}

/** Amanhã às 10h: dentro da janela e sempre no futuro. */
function amanhaAs(hora) {
  const data = new Date();
  data.setDate(data.getDate() + 1);
  data.setHours(hora, 0, 0, 0);
  return data;
}

function comPapel(app, sessao) {
  return (caminho, corpo, metodo = 'POST') => app.pedirSemAuth(caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessao.access_token}`,
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- leitura

test('os três papéis enxergam a agenda', async (t) => {
  const { app } = await subirAgenda();
  t.after(() => app.encerrar());

  const inicio = amanhaAs(8).toISOString();
  const fim = amanhaAs(18).toISOString();

  for (const papel of ['atendente', 'gestor', 'admin']) {
    const sessao = await app.entrarComo(papel, { email: `${papel}-le@teste.local` });
    const pedir = comPapel(app, sessao);

    const resposta = await pedir(`/api/agenda?inicio=${inicio}&fim=${fim}`, undefined, 'GET');
    assert.equal(resposta.status, 200, `${papel} precisa ver a agenda para atender`);
  }
});

test('sem sessão a agenda não responde nada', async (t) => {
  const { app } = await subirAgenda();
  t.after(() => app.encerrar());

  const inicio = amanhaAs(8).toISOString();
  const fim = amanhaAs(18).toISOString();

  for (const rota of [
    `/api/agenda?inicio=${inicio}&fim=${fim}`,
    '/api/agenda/profissionais',
    '/api/agenda/vocabulario',
  ]) {
    const resposta = await app.pedirSemAuth(rota);
    assert.equal(resposta.status, 401, `${rota} não pode responder sem sessão`);
  }
});

// ---------------------------------------------------------------- marcar

test('atendente marca consulta: é o trabalho da recepção', async (t) => {
  const { app, profissional, repositorio } = await subirAgenda();
  t.after(() => app.encerrar());

  const sessao = await app.entrarComo('atendente', { email: 'recepcao@teste.local' });
  const pedir = comPapel(app, sessao);

  const [contato] = await repositorio.buscarContatos({ termo: 'Marina' });

  const proposta = await pedir('/api/agenda/propor', {
    profissional_id: profissional.id,
    contato_id: contato.id,
    inicio: amanhaAs(10).toISOString(),
    fim: amanhaAs(11).toISOString(),
  });
  assert.equal(proposta.status, 200);

  const { token } = await proposta.json();
  const gravado = await pedir('/api/agenda/confirmar', { token });
  assert.equal(gravado.status, 200);

  // E propor de fato não gravou antes da confirmação.
  assert.equal((await repositorio.listarAgendamentos({})).length, 1);
});

// ---------------------------------------------------------------- grade da clínica

test('atendente não mexe na grade da clínica; gestor e admin sim', async (t) => {
  const { app, profissional } = await subirAgenda();
  t.after(() => app.encerrar());

  const inicio = amanhaAs(12).toISOString();
  const fim = amanhaAs(13).toISOString();

  // Cadastrar profissional, definir disponibilidade e bloquear horário mudam o
  // que a clínica inteira consegue oferecer. Não é decisão de quem atende.
  const atendente = comPapel(app, await app.entrarComo('atendente', { email: 'at@teste.local' }));

  assert.equal(
    (await atendente('/api/agenda/profissionais', { nome: 'Dr. Novo' })).status, 403,
    'atendente não cadastra profissional',
  );
  assert.equal(
    (await atendente('/api/agenda/bloqueios', { inicio, fim, motivo: 'almoço' })).status, 403,
    'atendente não bloqueia a agenda',
  );
  assert.equal(
    (await atendente(`/api/agenda/profissionais/${profissional.id}/disponibilidade`, {
      janelas: [{ dia_semana: 1, hora_inicio: '08:00', hora_fim: '12:00' }],
    }, 'PUT')).status, 403,
    'atendente não muda o horário de atendimento',
  );

  for (const papel of ['gestor', 'admin']) {
    const pedir = comPapel(app, await app.entrarComo(papel, { email: `${papel}-grade@teste.local` }));

    assert.equal(
      (await pedir('/api/agenda/profissionais', { nome: `Dr. ${papel}` })).status, 200,
      `${papel} organiza a agenda`,
    );
    assert.equal(
      (await pedir('/api/agenda/bloqueios', { inicio, fim, motivo: 'reunião' })).status, 200,
      `${papel} bloqueia horário`,
    );
  }
});

// ---------------------------------------------------------------- ações no compromisso

test('atendente confirma presença e cancela; a agenda é atendimento', async (t) => {
  const { app, profissional, repositorio } = await subirAgenda();
  t.after(() => app.encerrar());

  const [contato] = await repositorio.buscarContatos({ termo: 'Marina' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id,
    contatoId: contato.id,
    inicio: amanhaAs(14).toISOString(),
    fim: amanhaAs(15).toISOString(),
  });

  const pedir = comPapel(app, await app.entrarComo('atendente', { email: 'presenca@teste.local' }));

  assert.equal(
    (await pedir(`/api/agenda/${agendamento.id}/status`, { status: 'confirmado' })).status, 200,
    'quem atende o telefone é quem registra a confirmação',
  );
  assert.equal(
    (await pedir(`/api/agenda/${agendamento.id}/cancelar`, { motivo: 'paciente desmarcou' })).status, 200,
  );
});

test('status inventado é recusado antes de chegar ao banco', async (t) => {
  const { app, profissional, repositorio } = await subirAgenda();
  t.after(() => app.encerrar());

  const [contato] = await repositorio.buscarContatos({ termo: 'Marina' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id,
    inicio: amanhaAs(16).toISOString(), fim: amanhaAs(17).toISOString(),
  });

  const pedir = comPapel(app, await app.entrarComo('gestor', { email: 'g-status@teste.local' }));

  // "cancelado" tem rota própria, que exige motivo: entrar por aqui deixaria
  // cancelamento sem justificativa na auditoria.
  for (const status of ['cancelado', 'remarcado', 'qualquer_coisa']) {
    const resposta = await pedir(`/api/agenda/${agendamento.id}/status`, { status });
    assert.equal(resposta.status, 400, `status "${status}" não pode passar`);
  }
});

// ---------------------------------------------------------------- conflito pela API

test('o conflito devolve 409 com o horário que atrapalhou', async (t) => {
  const { app, profissional, repositorio } = await subirAgenda();
  t.after(() => app.encerrar());

  const [contato] = await repositorio.buscarContatos({ termo: 'Marina' });
  const pedir = comPapel(app, await app.entrarComo('atendente', { email: 'conflito@teste.local' }));

  const pedido = {
    profissional_id: profissional.id,
    contato_id: contato.id,
    inicio: amanhaAs(9).toISOString(),
    fim: amanhaAs(10).toISOString(),
  };

  const { token } = await (await pedir('/api/agenda/propor', pedido)).json();
  assert.equal((await pedir('/api/agenda/confirmar', { token })).status, 200);

  const repetido = await pedir('/api/agenda/propor', pedido);
  assert.equal(repetido.status, 409);

  const corpo = await repetido.json();
  assert.equal(corpo.codigo, 'conflito_de_agenda');
  assert.ok(corpo.conflito, 'a recepção precisa saber qual horário ocupou');
});

// ---------------------------------------------------------------- vazamento

test('a agenda não devolve dado clínico que ninguém pediu', async (t) => {
  const { app, profissional, repositorio } = await subirAgenda();
  t.after(() => app.encerrar());

  const [contato] = await repositorio.buscarContatos({ termo: 'Marina' });
  await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id,
    inicio: amanhaAs(11).toISOString(), fim: amanhaAs(12).toISOString(),
  });

  const pedir = comPapel(app, await app.entrarComo('atendente', { email: 'vaza@teste.local' }));
  const inicio = amanhaAs(0).toISOString();
  const fim = amanhaAs(23).toISOString();

  const texto = await (await pedir(`/api/agenda?inicio=${inicio}&fim=${fim}`, undefined, 'GET')).text();

  for (const termo of ['senha_hash', 'hash_refresh', 'totp_segredo', 'senha']) {
    assert.ok(!texto.includes(termo), `a resposta da agenda não deve conter "${termo}"`);
  }
});
