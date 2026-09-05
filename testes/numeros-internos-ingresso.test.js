'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// A guarda de números internos existia só em `sincronia-conversas.js` — uma
// rotina abandonada logo no início quando o transporte é `crm_despacha`, que é
// o modo de produção. No caminho por onde as mensagens REALMENTE entram
// (webhook da Evolution) ela nunca rodou: existem dois contatos no CRM com o
// número do próprio Dr. Edson.

const EQUIPE = ['+5516992943215', '+5516993624116'];

function evento(remetente, texto = 'ok, recebi') {
  return {
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: `wa:${remetente}:${texto.length}`,
    remetente,
    nome: 'Quem escreveu',
    texto,
  };
}

function montar({ numerosInternos = EQUIPE } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: null, numerosInternos });
  return { repositorio, atendimento };
}

test('a resposta do administrador ao resumo não vira contato, conversa nem lead', async () => {
  // O caso que motivou: o resumo do lead volta a sair, o Dr. Edson recebe no
  // WhatsApp e responde "ok". Sem esta guarda, cada resumo criava mais um
  // atendimento que nunca existiu.
  const { repositorio, atendimento } = montar();

  const resultado = await atendimento.receberMensagem(evento('5516992943215'));

  assert.equal(resultado.acao, 'mensagem_interna_ignorada');
  assert.equal(resultado.conversa_id, null);
  assert.deepEqual(await repositorio.listarConversas({}), []);
  assert.deepEqual(await repositorio.buscarContatos({ termo: '992943215' }), []);
});

test('nada é gravado: a guarda vem ANTES do contato, não depois', async () => {
  // Uma linha criada e depois escondida continua sendo uma linha no banco.
  const { repositorio, atendimento } = montar();

  await atendimento.receberMensagem(evento('5516993624116'));

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 0);
});

test('o mesmo número com e sem o nono dígito continua sendo da equipe', async () => {
  // O Brasil escreve o mesmo celular das duas formas; ser interno numa e
  // paciente na outra é o mesmo defeito com outra roupa.
  const { repositorio, atendimento } = montar({ numerosInternos: ['+55 16 99294-3215'] });

  await atendimento.receberMensagem(evento('551692943215'));

  assert.deepEqual(await repositorio.listarConversas({}), []);
});

test('paciente continua sendo atendido normalmente', async () => {
  const { repositorio, atendimento } = montar();

  const resultado = await atendimento.receberMensagem(evento('5516988887777', 'oi, quero marcar'));

  assert.notEqual(resultado.acao, 'mensagem_interna_ignorada');
  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  assert.equal(conversas[0].contato.telefone, '5516988887777');
});

test('sem lista configurada, ninguém é filtrado — o padrão não pode calar paciente', async () => {
  const { repositorio, atendimento } = montar({ numerosInternos: [] });

  await atendimento.receberMensagem(evento('5516992943215'));

  assert.equal((await repositorio.listarConversas({})).length, 1);
});

test('canal sem telefone (Instagram) não passa pela guarda', async () => {
  // No Instagram o remetente é um PSID, não telefone: compará-lo com a lista
  // da equipe seria comparar coisas de tipos diferentes.
  const { repositorio, atendimento } = montar();

  await atendimento.receberMensagem({
    canal: 'instagram',
    estrategia_ia: 'crm_despacha',
    id_externo: 'ig:1',
    remetente: 'psid-5516992943215',
    nome: 'Alguém no Instagram',
    texto: 'oi',
  });

  assert.equal((await repositorio.listarConversas({})).length, 1);
});
