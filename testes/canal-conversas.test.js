'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCanalDeConversas } = require('../src/integracoes/canal-conversas');

function gatewayFalso(implementacao) {
  const chamadas = [];
  return {
    disponivel: true,
    async chamar(metodo, parametros) {
      chamadas.push({ metodo, parametros });
      return implementacao(metodo, parametros);
    },
    async encerrar() {},
    chamadas,
  };
}

test('sem Evolution nem gateway configurados, o canal fica indisponível', () => {
  const canal = criarCanalDeConversas({});
  assert.equal(canal.disponivel, false);
});

test('com Evolution disponível, ela é tentada primeiro e o gateway nunca é chamado', async () => {
  const cliente = gatewayFalso(() => { throw new Error('gateway não deveria ser chamado'); });
  const evolucao = {
    disponivel: true,
    async enviar({ telefone, texto }) {
      assert.equal(telefone, '5511999990000');
      assert.equal(texto, 'oi paciente');
      return { identificador: 'evo-123' };
    },
  };

  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });
  const resultado = await canal.enviar({ telefone: '(11) 99999-0000', texto: 'oi paciente', chave: 'k1' });
  assert.equal(resultado.identificador, 'evo-123');
});

test('Evolution falha e existe gateway configurado — cai para o gateway como reserva', async () => {
  const cliente = gatewayFalso((metodo, parametros) => {
    assert.equal(metodo, 'send');
    assert.equal(parametros.channel, 'whatsapp');
    assert.equal(parametros.to, '+5511999990000');
    return { messageId: 'gw-456' };
  });
  const evolucao = {
    disponivel: true,
    async enviar() { throw new Error('instância desconectada'); },
  };

  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });
  const resultado = await canal.enviar({ telefone: '5511999990000', texto: 'oi', chave: 'k2' });
  assert.equal(resultado.identificador, 'gw-456');
  assert.equal(cliente.chamadas.length, 1);
});

test('Evolution falha e NÃO há gateway configurado — o erro da Evolution sobe, sem reserva', async () => {
  const evolucao = {
    disponivel: true,
    async enviar() { throw new Error('instância desconectada'); },
  };

  const canal = criarCanalDeConversas({}, { evolucao }); // sem url de gateway
  await assert.rejects(
    () => canal.enviar({ telefone: '5511999990000', texto: 'oi', chave: 'k3' }),
    /instância desconectada/,
  );
});

test('sem Evolution configurada, o comportamento é idêntico ao de sempre (só gateway)', async () => {
  const cliente = gatewayFalso(() => ({ messageId: 'gw-789' }));
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente });
  const resultado = await canal.enviar({ telefone: '5511999990000', texto: 'oi', chave: 'k4' });
  assert.equal(resultado.identificador, 'gw-789');
});

test('telefone inválido é recusado antes de tentar qualquer via', async () => {
  const evolucao = { disponivel: true, async enviar() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { evolucao });
  await assert.rejects(() => canal.enviar({ telefone: 'abc', texto: 'oi', chave: 'k5' }));
});
