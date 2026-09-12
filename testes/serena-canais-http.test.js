'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { subirServidor } = require('./auxiliar');

// Canal calado pela porta de entrada (migration 048).
//
// O que estes testes protegem, e que o teste de unidade não alcança:
//
//   1. a rota existe, está ligada e funciona ponta a ponta — inclusive no
//      repositório EM MEMÓRIA, que é o que sobe quando alguém levanta o CRM
//      local para ensaiar a mudança antes de mexer em produção;
//   2. a mensagem do paciente continua sendo GRAVADA no canal calado. Calar é
//      "não respondemos", nunca "não recebemos" — a mesma invariante do
//      desligamento global;
//   3. os dois interruptores não se apagam: ligar/desligar a Serena não mexe
//      na lista de canais, e escolher canal não liga nem desliga a Serena.

function orquestradorFalso() {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'Olá! Sou a Serena.' }; },
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

const JSON_H = { 'content-type': 'application/json' };

let sequencia = 0;
function eventoDe(canal, remetente) {
  sequencia += 1;
  return {
    canal,
    estrategia_ia: 'crm_despacha',
    remetente,
    nome: 'Marina Souza',
    texto: 'Gostaria de marcar uma consulta',
    id_externo: `canal-${canal}-${sequencia}`,
  };
}

async function montar(t) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });

  const ambiente = await subirServidor({ repositorio, orquestrador, atendimento, servicoDaSerena });
  t.after(() => ambiente.encerrar());

  return { ambiente, repositorio, orquestrador, servicoDaSerena, atendimento };
}

test('a rota grava a lista e ela volta no status e no interruptor', async (t) => {
  const { ambiente } = await montar(t);

  const gravou = await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: ['whatsapp'] }),
  });
  assert.equal(gravou.status, 200, 'a rota precisa existir e funcionar no repositório em memória');
  assert.deepEqual((await gravou.json()).canais_desligados, ['whatsapp']);

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.deepEqual(status.serena.canais_desligados, ['whatsapp']);

  // O botão de parada de emergência lê esta rota: ela precisa contar a mesma coisa.
  const interruptor = await (await ambiente.pedir('/api/serena/interruptor')).json();
  assert.deepEqual(interruptor.canais_desligados, ['whatsapp']);
});

test('canal não silenciável é recusado com erro de contrato, não com 500', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: ['site'] }),
  });
  assert.equal(resposta.status, 400);
});

test('o que não é lista é recusado', async (t) => {
  const { ambiente } = await montar(t);

  for (const corpo of [{ canais_desligados: 'whatsapp' }, { canais_desligados: null }, {}]) {
    const resposta = await ambiente.pedir('/api/serena/canais', {
      method: 'PUT', headers: JSON_H, body: JSON.stringify(corpo),
    });
    assert.equal(resposta.status, 400, `${JSON.stringify(corpo)} deveria ser recusado`);
  }
});

test('no canal calado a mensagem do paciente é GRAVADA e fica para a equipe', async (t) => {
  const { ambiente, repositorio, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: ['whatsapp'] }),
  });

  const entrada = await atendimento.receberMensagem(eventoDe('whatsapp', '5516993120938'));
  assert.equal(entrada.acao, 'aguardando_equipe', 'calar é não responder; a conversa fica para a equipe');

  const conversas = await repositorio.listarConversas({ limite: 50 });
  const conversa = conversas.find((c) => c.canal === 'whatsapp');
  assert.ok(conversa, 'a conversa do canal calado tem de existir');

  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.ok(mensagens.some((m) => m.direcao === 'entrada'), 'a mensagem do paciente ficou gravada');
  assert.ok(!mensagens.some((m) => m.direcao === 'saida'), 'e nenhuma resposta automática saiu');
});

test('o canal ligado continua respondendo — é o pedido inteiro', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: ['whatsapp'] }),
  });

  await atendimento.receberMensagem(eventoDe('instagram', 'paciente.instagram'));
  assert.equal(orquestrador.despachos.length, 1, 'o Instagram foi atendido com o WhatsApp calado');

  await atendimento.receberMensagem(eventoDe('whatsapp', '5516993120938'));
  assert.equal(orquestrador.despachos.length, 1, 'e o WhatsApp seguiu calado');
});

test('os dois interruptores não se apagam', async (t) => {
  const { ambiente } = await montar(t);

  await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: ['whatsapp'] }),
  });

  // Desligar e religar a Serena não pode limpar a escolha de canal: quem
  // religa esperando "só o Instagram" não pode receber o WhatsApp de volta.
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ ativa: false, motivo: 'teste' }),
  });
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ ativa: true }),
  });

  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.deepEqual(status.serena.canais_desligados, ['whatsapp'], 'a lista sobreviveu ao desliga/liga');
  assert.equal(status.serena.ativa, true);

  // E o inverso: mexer em canal não pode ligar nem desligar a automação.
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ ativa: false, motivo: 'uso particular' }),
  });
  await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: [] }),
  });

  const depois = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(depois.serena.ativa, false, 'escolher canal não religa a Serena');
  assert.equal(depois.serena.motivo, 'uso particular', 'nem apaga o motivo do desligamento');
});

test('com a Serena desligada, nenhum canal responde — o geral é soberano', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/canais', {
    method: 'PUT', headers: JSON_H, body: JSON.stringify({ canais_desligados: [] }),
  });
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST', headers: JSON_H, body: JSON.stringify({ ativa: false, motivo: 'emergência' }),
  });

  await atendimento.receberMensagem(eventoDe('instagram', 'paciente.instagram'));
  await atendimento.receberMensagem(eventoDe('whatsapp', '5516993120938'));
  assert.equal(orquestrador.despachos.length, 0, 'a parada de emergência cala todos os canais');
});
