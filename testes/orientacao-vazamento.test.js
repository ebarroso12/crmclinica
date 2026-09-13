'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { separarPedidoDeOrientacao, criarOrientacoes } = require('../src/dominio/orientacao');

// Quatro furos achados em revisão independente do commit de orientação
// (13/09/2026). Os dois primeiros terminam com o paciente lendo
// `[[ORIENTAR: …]]` no WhatsApp; os dois últimos, com a clínica sem saber que
// alguém está esperando.

test('dois marcadores na mesma resposta: nenhum vai para o paciente', () => {
  const { texto, duvida } = separarPedidoDeOrientacao(
    'Oi! [[ORIENTAR: qual o valor do combo]] Posso te ajudar. [[ORIENTAR: e a data limite]]',
  );

  // `replace` sem a flag `g` trocava só o primeiro — o segundo seguia inteiro
  // na mensagem enviada.
  assert.ok(!texto.includes('ORIENTAR'), `vazou o marcador: ${texto}`);
  assert.equal(texto, 'Oi! Posso te ajudar.');
  // As duas dúvidas chegam à clínica; perder a segunda seria responder pela
  // metade.
  assert.match(duvida, /valor do combo/);
  assert.match(duvida, /data limite/);
});

test('a dúvida pode citar a pergunta com colchete', () => {
  // O caso real: a assistente repete o que o lead escreveu, e o lead escreveu
  // o nome da promoção entre colchetes. Com `[^\]]*` o marcador não casava —
  // o paciente via o marcador E ninguém era chamado.
  const { texto, duvida } = separarPedidoDeOrientacao(
    'Vou confirmar com a equipe. [[ORIENTAR: qual o valor do [promo setembro] do post]]',
  );

  assert.equal(texto, 'Vou confirmar com a equipe.');
  assert.equal(duvida, 'qual o valor do [promo setembro] do post');
});

test('marcador colado no texto não junta as palavras', () => {
  const { texto } = separarPedidoDeOrientacao('o valor[[ORIENTAR: quanto custa]]eu confirmo');
  assert.equal(texto, 'o valor eu confirmo');
});

test('pedir engolindo falha de banco deixa rastro na auditoria', async () => {
  // A assistente JÁ prometeu ao lead que ia confirmar. Se o registro falha e
  // ninguém audita, o caso fica indistinguível de "correu tudo bem".
  const auditado = [];
  const orientacoes = criarOrientacoes({
    repositorio: {
      async criarOrientacao() { throw Object.assign(new Error('conexão perdida'), { code: '08006' }); },
      async registrarAuditoria(registro) { auditado.push(registro); },
    },
  });

  const resultado = await orientacoes.pedir({ conversaId: 941, duvida: 'preço do post' });

  assert.equal(resultado.pedida, false);
  assert.equal(auditado.length, 1);
  assert.equal(auditado[0].acao, 'orientacao_nao_registrada');
  assert.equal(auditado[0].entidadeId, 941);
  assert.equal(auditado[0].detalhe.codigo, '08006');
  // A dúvida pode carregar relato do paciente: não entra no rastro.
  assert.ok(!JSON.stringify(auditado[0]).includes('preço do post'));
});

test('pendência repetida continua sendo silêncio, não auditoria de erro', async () => {
  const auditado = [];
  const orientacoes = criarOrientacoes({
    repositorio: {
      async criarOrientacao() { throw Object.assign(new Error('duplicada'), { code: '23505' }); },
      async registrarAuditoria(registro) { auditado.push(registro); },
    },
  });

  const resultado = await orientacoes.pedir({ conversaId: 941, duvida: 'x' });

  assert.equal(resultado.motivo, 'ja_existe_pendente');
  assert.deepEqual(auditado, [], 'o índice único fazendo o trabalho dele não é falha');
});

test('dois atendentes respondendo juntos: o paciente recebe UMA mensagem', async () => {
  // A compilação leva segundos. Nesse intervalo o outro atendente que abriu a
  // mesma conversa também clica em "Enviar orientação".
  let marcacoes = 0;
  const enviadas = [];
  const orientacoes = criarOrientacoes({
    repositorio: {
      async obterOrientacao() {
        return { id: 7, conversa_id: 941, duvida: 'preço do post', estado: 'pendente' };
      },
      async responderOrientacao() {
        marcacoes += 1;
        return marcacoes === 1; // só o primeiro UPDATE encontra a linha pendente
      },
    },
    ia: { async gerar() { return 'O valor é R$ 300.'; } },
  });

  const responder = () => orientacoes.responder({
    orientacaoId: 7,
    orientacao: 'pode dar 300, e 10% se insistir',
    usuarioId: 3,
    enviar: async (t) => { enviadas.push(t); },
  });

  const resultados = await Promise.allSettled([responder(), responder()]);

  assert.equal(enviadas.length, 1, 'duas mensagens sobre a mesma dúvida é o defeito');
  const recusada = resultados.find((r) => r.status === 'rejected');
  assert.equal(recusada.reason.status, 409);
});
