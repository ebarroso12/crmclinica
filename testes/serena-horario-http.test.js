'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { subirServidor } = require('./auxiliar');

// Horário, pausa e plantão pela porta de entrada.
//
// O teste que mais importa é o mesmo do desligamento: com a Serena calada por
// horário ou por pausa, a mensagem do paciente **continua sendo gravada**. Se
// calar levasse o inbox junto, a clínica perderia quem escreveu de madrugada — e
// não saberia que perdeu.

function orquestradorFalso() {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'Olá! Sou a Serena.' }; },
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  remetente: '5516993120938',
  nome: 'Marina Souza',
  texto: 'Gostaria de marcar uma consulta',
});

const JSON_H = { 'content-type': 'application/json' };

// `id_externo` repetido é tratado como reentrega e ignorado — sem contador, a
// segunda mensagem de um teste sumiria e o teste passaria pelo motivo errado.
let sequencia = 0;

async function montar(t) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });

  const ambiente = await subirServidor({ repositorio, orquestrador, atendimento, servicoDaSerena });
  t.after(() => ambiente.encerrar());

  return { ambiente, repositorio, orquestrador, servicoDaSerena, atendimento };
}

/** Grade que nunca abre — o jeito determinístico de estar "fora do horário". */
const SEMPRE_FECHADO = {
  ativa: true,
  fuso: 'America/Sao_Paulo',
  dias: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
};

const SEMPRE_ABERTO = {
  ativa: true,
  fuso: 'America/Sao_Paulo',
  dias: {
    0: [['00:00', '00:00']], 1: [['00:00', '00:00']], 2: [['00:00', '00:00']],
    3: [['00:00', '00:00']], 4: [['00:00', '00:00']], 5: [['00:00', '00:00']],
    6: [['00:00', '00:00']],
  },
};

test('a grade é salva e volta no status', async (t) => {
  const { ambiente } = await montar(t);

  const salvou = await ambiente.pedir('/api/serena/horario', {
    method: 'PUT', headers: JSON_H,
    body: JSON.stringify({ ativa: true, fuso: 'America/Sao_Paulo', dias: { 1: [['08:00', '18:00']] } }),
  });
  assert.equal(salvou.status, 200);

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.agenda.ativa, true);
  assert.deepEqual(status.horario.agenda.dias['1'], [['08:00', '18:00']]);
  // Os sete dias voltam preenchidos: um dia ausente do JSON não pode ficar
  // ambíguo entre "fechado" e "não configurado".
  assert.deepEqual(status.horario.agenda.dias['4'], []);
});

test('horário inválido é recusado com 400, não salvo pela metade', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await ambiente.pedir('/api/serena/horario', {
    method: 'PUT', headers: JSON_H,
    body: JSON.stringify({ ativa: true, dias: { 2: [['8h', '18:00']] } }),
  });
  assert.equal(resposta.status, 400);

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.agenda, null, 'nada foi gravado');
});

test('fora do horário a Serena não responde — e a mensagem continua gravada', async (t) => {
  const { ambiente, orquestrador, repositorio, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/horario', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify(SEMPRE_FECHADO),
  });

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.atendendo, false);
  assert.equal(status.horario.dentro_do_horario, false);
  // O interruptor continua ligado: quem for investigar precisa ver que o
  // silêncio veio do horário, não de alguém ter desligado a automação.
  assert.equal(status.serena.ativa, true);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: `wa:${++sequencia}` });

  assert.equal(orquestrador.despachos.length, 0, 'a Serena não respondeu');
  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1, 'a conversa do paciente foi gravada mesmo assim');
});

test('o plantão faz a Serena atender fora do horário, sem tocar na grade', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/horario', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify(SEMPRE_FECHADO),
  });
  const plantao = await ambiente.pedir('/api/serena/plantao', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 60 }),
  });
  assert.equal(plantao.status, 200);

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.em_plantao, true);
  assert.equal(status.horario.atendendo, true);
  // A grade continua fechada: o plantão vence, não substitui.
  assert.equal(status.horario.dentro_do_horario, false);
  assert.deepEqual(status.horario.agenda.dias['1'], []);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: `wa:${++sequencia}` });
  assert.equal(orquestrador.despachos.length, 1, 'respondeu durante o plantão');
});

test('a pausa cala dentro do horário e a despausa devolve a palavra', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/horario', { method: 'PUT', headers: JSON_H, body: JSON.stringify(SEMPRE_ABERTO) });

  const pausou = await ambiente.pedir('/api/serena/pausa', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 15, motivo: 'atendimento manual' }),
  });
  assert.equal(pausou.status, 200);
  assert.equal((await pausou.json()).horario.pausada, true);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: `wa:${++sequencia}` });
  assert.equal(orquestrador.despachos.length, 0, 'pausada, não responde');

  const despausou = await ambiente.pedir('/api/serena/pausa', { method: 'DELETE' });
  assert.equal(despausou.status, 200);
  assert.equal((await despausou.json()).horario.pausada, false);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: `wa:${++sequencia}`, texto: 'ainda estou aí?' });
  assert.equal(orquestrador.despachos.length, 1, 'despausada, volta a responder');
});

test('pausar limpa o plantão: os dois são intenções opostas', async (t) => {
  const { ambiente } = await montar(t);

  await ambiente.pedir('/api/serena/plantao', { method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 60 }) });
  await ambiente.pedir('/api/serena/pausa', { method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 10 }) });

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.pausada, true);
  assert.equal(status.horario.em_plantao, false, 'o plantão foi limpo ao pausar');
});

test('o plantão limpa a pausa, na direção contrária', async (t) => {
  const { ambiente } = await montar(t);

  await ambiente.pedir('/api/serena/pausa', { method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 30 }) });
  await ambiente.pedir('/api/serena/plantao', { method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 60 }) });

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.pausada, false, 'a pausa foi limpa ao entrar em plantão');
  assert.equal(status.horario.em_plantao, true);
});

test('o desligamento global vence horário e plantão', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/plantao', { method: 'POST', headers: JSON_H, body: JSON.stringify({ minutos: 60 }) });
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ ativa: false, motivo: 'incidente' }),
  });

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.atendendo, false);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: `wa:${++sequencia}` });
  assert.equal(orquestrador.despachos.length, 0);
});

test('pausa sem prazo válido é recusada — pausa sem fim é desligamento esquecido', async (t) => {
  const { ambiente } = await montar(t);

  for (const corpo of [{}, { minutos: 0 }, { minutos: -5 }, { minutos: 1441 }, { minutos: 'muito' }]) {
    const resposta = await ambiente.pedir('/api/serena/pausa', {
      method: 'POST', headers: JSON_H, body: JSON.stringify(corpo),
    });
    assert.equal(resposta.status, 400, `deveria recusar ${JSON.stringify(corpo)}`);
  }
});

test('remover a grade faz a Serena voltar a atender sempre', async (t) => {
  const { ambiente } = await montar(t);

  await ambiente.pedir('/api/serena/horario', { method: 'PUT', headers: JSON_H, body: JSON.stringify(SEMPRE_FECHADO) });
  assert.equal((await (await ambiente.pedir('/api/serena/status')).json()).horario.atendendo, false);

  // `null` é diferente de "todos os dias vazios": um remove o limite, o outro
  // cala a semana inteira. A tela precisa poder dizer as duas coisas.
  const removeu = await ambiente.pedir('/api/serena/horario', { method: 'PUT', headers: JSON_H, body: 'null' });
  assert.equal(removeu.status, 200);

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.horario.agenda, null);
  assert.equal(status.horario.atendendo, true);
});

test('quem não gerencia a Serena não mexe em horário, pausa nem plantão', async (t) => {
  const { ambiente } = await montar(t);

  const atendente = await ambiente.entrarComo('atendente');
  const comAtendente = (caminho, opcoes = {}) => ambiente.pedirSemAuth(caminho, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), authorization: `Bearer ${atendente.access_token}` },
  });

  // Ler continua liberado: a recepção precisa saber se a Serena está atendendo.
  assert.equal((await comAtendente('/api/serena/status')).status, 200);

  for (const [caminho, metodo] of [
    ['/api/serena/horario', 'PUT'], ['/api/serena/pausa', 'POST'],
    ['/api/serena/pausa', 'DELETE'], ['/api/serena/plantao', 'POST'],
  ]) {
    const resposta = await comAtendente(caminho, {
      method: metodo, headers: JSON_H, body: JSON.stringify({ minutos: 10 }),
    });
    assert.equal(resposta.status, 403, `${metodo} ${caminho} deveria exigir serena:gerenciar`);
  }
});
