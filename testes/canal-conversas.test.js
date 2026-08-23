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

// -------------------------------------------------------------------- Instagram
//
// Achado de 23/08: `enviar` nunca soube rotear pro Instagram — sempre caía no
// caminho de WhatsApp (Evolution/gateway), tratando o PSID como telefone.
// A outbox "concluía" o trabalho sem erro, mas nada era de fato entregue.

test('canal:"instagram" vai direto pro cliente do Instagram — nunca tenta Evolution nem gateway', async () => {
  const evolucao = { disponivel: true, async enviar() { throw new Error('Evolution não deveria ser chamada'); } };
  const cliente = gatewayFalso(() => { throw new Error('gateway não deveria ser chamado'); });
  const instagram = {
    disponivel: true,
    async enviar({ telefone, texto }) {
      // PSID de verdade: numérico longo, mas NÃO é telefone — não pode
      // passar por normalizarTelefone nem levar prefixo de DDI.
      assert.equal(telefone, '17841474502266312');
      assert.equal(texto, 'oi paciente do Instagram');
      return { identificador: 'ig-msg-1' };
    },
  };

  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao, instagram });
  const resultado = await canal.enviar({
    telefone: '17841474502266312', texto: 'oi paciente do Instagram', chave: 'k6', canal: 'instagram',
  });
  assert.equal(resultado.identificador, 'ig-msg-1');
});

test('canal:"instagram" sem cliente do Instagram configurado recusa com erro claro', async () => {
  const evolucao = { disponivel: true, async enviar() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { evolucao }); // sem instagram
  await assert.rejects(
    () => canal.enviar({ telefone: '17841474502266312', texto: 'oi', chave: 'k7', canal: 'instagram' }),
    /Instagram não configurado/,
  );
});

test('canal.disponivel considera o cliente do Instagram mesmo sem Evolution/gateway', () => {
  const instagram = { disponivel: true };
  const canal = criarCanalDeConversas({}, { instagram });
  assert.equal(canal.disponivel, true);
});

test('enviarMidia com canal:"instagram" recusa com erro claro (sem suporte a anexo ainda)', async () => {
  const evolucao = { disponivel: true, async enviarMidia() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { evolucao });
  await assert.rejects(
    () => canal.enviarMidia({ telefone: '17841474502266312', mediaUrl: 'https://x', tipo: 'imagem', canal: 'instagram' }),
    /Instagram.*não é suportado/,
  );
});
