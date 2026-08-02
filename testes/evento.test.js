const test = require('node:test');
const assert = require('node:assert/strict');
const { validarEventoMensagem } = require('../src/contratos/evento');

test('valida evento de mensagem e normaliza campos', () => {
  assert.deepEqual(validarEventoMensagem({
    id_externo: 'wa:1', canal: 'whatsapp', remetente: '5516993120938', texto: 'Olá', nome: 'Pessoa',
  }), {
    id_externo: 'wa:1', canal: 'whatsapp', remetente: '5516993120938', texto: 'Olá', nome: 'Pessoa',
  });
});

test('recusa evento sem id externo', () => {
  assert.throws(() => validarEventoMensagem({ canal: 'whatsapp', remetente: '1', texto: 'Oi' }), /id_externo/);
});
