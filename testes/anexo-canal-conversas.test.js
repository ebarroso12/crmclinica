'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCanalDeConversas } = require('../src/integracoes/canal-conversas');

test('enviarMidia: com Evolution disponível, chama evolucao.enviarMidia com o telefone normalizado', async () => {
  const evolucao = {
    disponivel: true,
    async enviarMidia({ telefone, mediaUrl, tipo, legenda, nomeArquivo }) {
      assert.equal(telefone, '5511999990000');
      assert.equal(mediaUrl, 'https://storage.exemplo/foto.png');
      assert.equal(tipo, 'imagem');
      assert.equal(legenda, 'olha');
      assert.equal(nomeArquivo, 'foto.png');
      return { identificador: 'evo-midia-1' };
    },
  };

  const canal = criarCanalDeConversas({}, { evolucao });
  const resultado = await canal.enviarMidia({
    telefone: '(11) 99999-0000', mediaUrl: 'https://storage.exemplo/foto.png', tipo: 'imagem', legenda: 'olha', nomeArquivo: 'foto.png',
  });
  assert.equal(resultado.identificador, 'evo-midia-1');
});

test('enviarMidia: SEM Evolution disponível, recusa com erro claro — nunca tenta o gateway do OpenClaw', async () => {
  const cliente = {
    disponivel: true,
    async chamar() { throw new Error('gateway não deveria ser chamado para mídia'); },
    async encerrar() {},
  };
  // Gateway configurado (url presente) e SEM evolucao — o texto normal cairia
  // no gateway como reserva; mídia não tem essa reserva confirmada.
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente });

  await assert.rejects(
    () => canal.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo: 'imagem' }),
    /Evolution API configurada/,
  );
});

test('enviarMidia: Evolution configurada mas indisponível (evolucao.disponivel=false) também recusa', async () => {
  const evolucao = { disponivel: false, async enviarMidia() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { evolucao });

  await assert.rejects(() => canal.enviarMidia({ telefone: '5511999990000', mediaUrl: 'https://x/y', tipo: 'imagem' }));
});

test('enviarMidia: telefone inválido é recusado antes de tentar qualquer via', async () => {
  const evolucao = { disponivel: true, async enviarMidia() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { evolucao });

  await assert.rejects(() => canal.enviarMidia({ telefone: 'abc', mediaUrl: 'https://x/y', tipo: 'imagem' }));
});
