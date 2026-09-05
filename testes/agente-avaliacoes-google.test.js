'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  criarAgenteDeAvaliacoes, validarResposta, textoDeReserva, LIMITE_RESPOSTA,
} = require('../src/dominio/resposta-avaliacao');
const { criarClienteAvaliacoesGoogle } = require('../src/integracoes/google-avaliacoes');

const CANAL = 'WhatsApp (16) 99312-0938';

// ------------------------------------------------------------- a barreira

test('a resposta não pode confirmar que quem avaliou é paciente', () => {
  // O sigilo não se suspende porque a outra pessoa falou primeiro. Vale até
  // para elogio: "obrigado pela consulta" confirma o vínculo do mesmo jeito.
  for (const texto of [
    'Obrigado pela consulta! Foi um prazer te atender.',
    'Obrigado! Fico feliz que seu tratamento esteja indo bem.',
    'Agradeço muito, você foi atendido com todo cuidado.',
    'Obrigado, nosso paciente merece o melhor.',
  ]) {
    const problemas = validarResposta(texto);
    assert.ok(problemas.length > 0, `deveria recusar: ${texto}`);
    assert.match(problemas.join(' '), /paciente|sigilo/i);
  }
});

test('a resposta não cita conteúdo clínico — nem para corrigir o que foi dito', () => {
  for (const texto of [
    'Obrigado. Só esclarecendo que o diagnóstico não foi esse.',
    'Agradeço. A medicação prescrita seguiu o protocolo.',
    'Obrigado pelo retorno sobre a psicoterapia.',
  ]) {
    assert.ok(validarResposta(texto).length > 0, `deveria recusar: ${texto}`);
  }
});

test('a resposta não promete resultado nem se autopromove', () => {
  assert.ok(validarResposta('Obrigado! Garantimos sua melhora.').length > 0);
  assert.ok(validarResposta('Obrigado por escolher o melhor medico da cidade.').length > 0);
});

test('a resposta nunca discute nem acusa em público', () => {
  for (const texto of [
    'Obrigado, mas isso é mentira.',
    'Agradeço o retorno, porém é uma difamação e vamos processar.',
    'Obrigado. Não foi bem assim que aconteceu.',
  ]) {
    assert.ok(validarResposta(texto).length > 0, `deveria recusar: ${texto}`);
  }
});

test('data e horário são detalhe de atendimento e não entram', () => {
  assert.ok(validarResposta('Obrigado pelo retorno de 12/08.').length > 0);
  assert.ok(validarResposta('Obrigado! Atendemos às 14:30 normalmente.').length > 0);
});

test('a resposta precisa agradecer e caber no limite', () => {
  assert.deepEqual(validarResposta(''), ['a resposta está vazia']);
  assert.ok(validarResposta('Estamos à disposição.').some((p) => /agradec/i.test(p)));
  assert.ok(validarResposta(`Obrigado. ${'a'.repeat(LIMITE_RESPOSTA)}`).some((p) => /caracteres/.test(p)));
});

test('os textos de reserva passam na própria barreira, em toda faixa de nota', () => {
  // Uma reserva que a barreira recusa é defeito de código, não de conteúdo —
  // e deixaria a clínica sem resposta nenhuma justamente quando a IA falhou.
  for (const estrelas of [1, 2, 3, 4, 5]) {
    const texto = textoDeReserva({ estrelas, canalPrivado: CANAL });
    assert.deepEqual(validarResposta(texto), [], `${estrelas} estrelas: ${texto}`);
  }
});

// -------------------------------------------------------------- a decisão

test('avaliação de 5 estrelas pode sair sozinha quando a clínica ligou isso', async () => {
  const agente = criarAgenteDeAvaliacoes({ canalPrivado: CANAL, autoPublicar: true });
  const decisao = await agente.responder({ id: 'r1', estrelas: 5, comentario: 'Excelente!' });

  assert.equal(decisao.publicar, true);
  assert.equal(decisao.motivo, 'avaliacao_positiva_automatica');
  assert.deepEqual(validarResposta(decisao.texto), []);
});

test('nota baixa NUNCA sai sozinha, mesmo com a publicação automática ligada', async () => {
  // Uma reclamação pública é onde um médico se machuca, e a resposta certa
  // depende de contexto que só uma pessoa tem.
  const agente = criarAgenteDeAvaliacoes({ canalPrivado: CANAL, autoPublicar: true });

  for (const estrelas of [1, 2, 3]) {
    const decisao = await agente.responder({ id: `r${estrelas}`, estrelas, comentario: 'Demorou muito' });
    assert.equal(decisao.publicar, false, `${estrelas} estrelas não pode ser automática`);
    assert.equal(decisao.motivo, 'nota_baixa_exige_pessoa');
    assert.ok(decisao.texto, 'mesmo sem publicar, o rascunho é escrito');
  }
});

test('com a publicação automática desligada, tudo vira rascunho', async () => {
  const agente = criarAgenteDeAvaliacoes({ canalPrivado: CANAL, autoPublicar: false });
  const decisao = await agente.responder({ id: 'r1', estrelas: 5 });

  assert.equal(decisao.publicar, false);
  assert.equal(decisao.motivo, 'publicacao_automatica_desligada');
});

test('texto da IA que fere a barreira é descartado — a reserva sai no lugar', async () => {
  const gerador = { gerar: async () => 'Obrigado pela consulta de ontem, seu tratamento vai muito bem!' };
  const agente = criarAgenteDeAvaliacoes({ gerador, canalPrivado: CANAL, autoPublicar: true });

  const decisao = await agente.responder({ id: 'r1', estrelas: 5 });

  assert.equal(decisao.origem, 'reserva');
  assert.deepEqual(validarResposta(decisao.texto), []);
  assert.equal(decisao.publicar, true, 'a clínica não fica sem resposta porque a IA errou');
});

test('texto da IA dentro da barreira é o que sai', async () => {
  const gerador = { gerar: async () => 'Que mensagem carinhosa, muito obrigado por reservar um tempo para escrever.' };
  const agente = criarAgenteDeAvaliacoes({ gerador, canalPrivado: CANAL, autoPublicar: true });

  const decisao = await agente.responder({ id: 'r1', estrelas: 5 });

  assert.equal(decisao.origem, 'ia');
  assert.match(decisao.texto, /^Que mensagem carinhosa/);
});

test('IA fora do ar não deixa a avaliação sem resposta', async () => {
  const gerador = { gerar: async () => { throw new Error('gateway fora do ar'); } };
  const agente = criarAgenteDeAvaliacoes({ gerador, canalPrivado: CANAL, autoPublicar: true });

  const decisao = await agente.responder({ id: 'r1', estrelas: 5 });

  assert.equal(decisao.origem, 'reserva');
  assert.equal(decisao.publicar, true);
});

// ------------------------------------------------------ o cliente do Google

function fetchFalso(responder) {
  const chamadas = [];
  const impl = async (url, opcoes) => { chamadas.push({ url, opcoes }); return responder(url, opcoes); };
  impl.chamadas = chamadas;
  return impl;
}

const CONFIG = { contaId: '1234', localId: '5678', obterToken: async () => 'token-sintetico' };

test('sem conta, local ou credencial o cliente fica indisponível e recusa', async () => {
  const cliente = criarClienteAvaliacoesGoogle({ contaId: '', localId: '', obterToken: null });
  assert.equal(cliente.disponivel, false);
  await assert.rejects(() => cliente.listar());
  await assert.rejects(() => cliente.responder({ avaliacaoId: 'r1', texto: 'Obrigado.' }));
});

test('listar chama a v4 e traduz estrela, autor e "já respondida"', async () => {
  const fetchImpl = fetchFalso(async () => new Response(JSON.stringify({
    reviews: [
      {
        reviewId: 'r1', starRating: 'FIVE', comment: 'Excelente',
        reviewer: { displayName: 'Ana' }, createTime: '2026-09-01T10:00:00Z',
      },
      {
        reviewId: 'r2', starRating: 'TWO', comment: 'Demorou',
        reviewer: { displayName: 'Bruno' }, reviewReply: { comment: 'ja respondemos' },
      },
      { semId: true },
    ],
  }), { status: 200 }));

  const cliente = criarClienteAvaliacoesGoogle(CONFIG, { fetchImpl });
  const avaliacoes = await cliente.listar({ limite: 20 });

  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.match(url, /^https:\/\/mybusiness\.googleapis\.com\/v4\/accounts\/1234\/locations\/5678\/reviews\?/);
  assert.equal(opcoes.method, 'GET');
  assert.equal(opcoes.headers.authorization, 'Bearer token-sintetico');

  assert.equal(avaliacoes.length, 2, 'avaliação sem reviewId é descartada');
  assert.deepEqual(avaliacoes[0], {
    id: 'r1', estrelas: 5, comentario: 'Excelente', autor: 'Ana',
    criado_em: '2026-09-01T10:00:00Z', respondida: false,
  });
  assert.equal(avaliacoes[1].estrelas, 2);
  assert.equal(avaliacoes[1].respondida, true);
});

test('responder faz PUT em /reply com o campo `comment`', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ comment: 'Obrigado.', updateTime: '2026-09-05T12:00:00Z' }), { status: 200 },
  ));
  const cliente = criarClienteAvaliacoesGoogle(CONFIG, { fetchImpl });

  const resultado = await cliente.responder({ avaliacaoId: 'r1', texto: 'Obrigado pelo carinho.' });

  const [{ url, opcoes }] = fetchImpl.chamadas;
  assert.equal(url, 'https://mybusiness.googleapis.com/v4/accounts/1234/locations/5678/reviews/r1/reply');
  assert.equal(opcoes.method, 'PUT');
  assert.deepEqual(JSON.parse(opcoes.body), { comment: 'Obrigado pelo carinho.' });
  assert.equal(resultado.publicada, true);
});

test('403 explica o portão de acesso da v4 em vez de mandar caçar escopo OAuth', async () => {
  const fetchImpl = fetchFalso(async () => new Response(
    JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }), { status: 403 },
  ));
  const cliente = criarClienteAvaliacoesGoogle(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.listar(), /Google My Business API v4 foi aprovado/);
});

test('resposta vazia não é publicada, e avaliação sem id é recusada', async () => {
  const fetchImpl = fetchFalso(async () => new Response('{}', { status: 200 }));
  const cliente = criarClienteAvaliacoesGoogle(CONFIG, { fetchImpl });

  await assert.rejects(() => cliente.responder({ avaliacaoId: 'r1', texto: '   ' }));
  await assert.rejects(() => cliente.responder({ avaliacaoId: '', texto: 'Obrigado.' }));
  assert.equal(fetchImpl.chamadas.length, 0, 'nada vai para a rede antes de passar na validação');
});
