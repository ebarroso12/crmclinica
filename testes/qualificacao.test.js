'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERGUNTAS, camposPendentes, proximaPergunta, calcularScore,
  temperaturaDoScore, decidirTemperatura, normalizarQualificacao,
  normalizarOrigem, proximaAcao,
} = require('../src/dominio/qualificacao');

// ---------------------------------------------------------------- perguntas graduais

test('as perguntas cobrem os cinco campos, na ordem de uma conversa real', () => {
  assert.deepEqual(
    PERGUNTAS.map((p) => p.campo),
    ['interesse', 'primeira_consulta', 'urgencia', 'pagamento', 'disponibilidade'],
  );

  // Cada pergunta explica por que existe: sem isso a equipe não sabe se pode pular.
  for (const pergunta of PERGUNTAS) {
    assert.ok(pergunta.pergunta.endsWith('?'), `"${pergunta.campo}" deveria ser uma pergunta`);
    assert.ok(pergunta.porque.length > 10);
  }
});

test('a próxima pergunta é uma por vez, na ordem', () => {
  const lead = {};
  assert.equal(proximaPergunta(lead).campo, 'interesse');

  lead.interesse = 'avaliação';
  assert.equal(proximaPergunta(lead).campo, 'primeira_consulta');

  lead.primeira_consulta = true;
  assert.equal(proximaPergunta(lead).campo, 'urgencia');

  lead.urgencia = 'imediata';
  assert.equal(proximaPergunta(lead).campo, 'pagamento');

  lead.pagamento = 'particular';
  assert.equal(proximaPergunta(lead).campo, 'disponibilidade');

  lead.disponibilidade = 'manha';
  assert.equal(proximaPergunta(lead), null, 'qualificação completa não pergunta mais');
});

test('"indefinido" conta como não perguntado', () => {
  // Quem respondeu "não sei" ainda pode responder depois; tratar como preenchido
  // congelaria a qualificação num não-dado.
  assert.equal(proximaPergunta({ interesse: 'x', primeira_consulta: true, urgencia: 'indefinida' }).campo, 'urgencia');
  assert.ok(camposPendentes({ pagamento: 'indefinido' }).includes('pagamento'));
});

test('camposPendentes lista o que falta', () => {
  assert.equal(camposPendentes({}).length, 5);
  assert.deepEqual(
    camposPendentes({ interesse: 'botox', urgencia: 'imediata' }),
    ['primeira_consulta', 'pagamento', 'disponibilidade'],
  );
  assert.deepEqual(camposPendentes({
    interesse: 'x', primeira_consulta: false, urgencia: 'semanas',
    pagamento: 'convenio', disponibilidade: 'tarde',
  }), []);
});

// ---------------------------------------------------------------- score

test('lead vazio tem score zero', () => {
  const { score, motivos } = calcularScore({});
  assert.equal(score, 0);
  assert.deepEqual(motivos, []);
});

test('cada campo respondido soma, e o motivo é explicado', () => {
  const { score, motivos } = calcularScore({ interesse: 'preenchimento' });

  assert.equal(score, 20);
  assert.deepEqual(motivos, [{ sinal: 'interesse', pontos: 20 }]);
});

test('urgência imediata pesa mais que pesquisando', () => {
  const agora = Date.now();
  const imediata = calcularScore({ urgencia: 'imediata' }, { agora }).score;
  const semanas = calcularScore({ urgencia: 'semanas' }, { agora }).score;
  const pesquisando = calcularScore({ urgencia: 'pesquisando' }, { agora }).score;

  assert.ok(imediata > semanas && semanas > pesquisando);
  assert.equal(calcularScore({ urgencia: 'indefinida' }, { agora }).score, 0);
});

test('conversa recente vale ponto; antiga não', () => {
  const agora = Date.now();
  const recente = calcularScore({ ultima_msg_em: new Date(agora - 3_600_000).toISOString() }, { agora });
  const antiga = calcularScore({ ultima_msg_em: new Date(agora - 30 * 86_400_000).toISOString() }, { agora });

  assert.ok(recente.score > 0);
  assert.equal(antiga.score, 0, 'interesse tem prazo de validade');
  assert.ok(recente.motivos.some((motivo) => motivo.sinal === 'atividade:ate24h'));
});

test('lead completo e urgente chega perto do topo, sem passar de 100', () => {
  const agora = Date.now();
  const { score } = calcularScore({
    interesse: 'avaliação', primeira_consulta: true, pagamento: 'particular',
    disponibilidade: 'manha', urgencia: 'imediata',
    ultima_msg_em: new Date(agora - 600_000).toISOString(),
  }, { agora });

  assert.equal(score, 100);
});

test('o score nunca passa de 100', () => {
  const { score } = calcularScore({
    interesse: 'x', primeira_consulta: true, pagamento: 'particular',
    disponibilidade: 'qualquer', urgencia: 'imediata', ultima_msg_em: new Date().toISOString(),
  });
  assert.ok(score <= 100);
});

// ---------------------------------------------------------------- temperatura

test('as faixas de temperatura seguem o score', () => {
  assert.equal(temperaturaDoScore(0), 'frio');
  assert.equal(temperaturaDoScore(29), 'frio');
  assert.equal(temperaturaDoScore(30), 'morno');
  assert.equal(temperaturaDoScore(59), 'morno');
  assert.equal(temperaturaDoScore(60), 'quente');
  assert.equal(temperaturaDoScore(100), 'quente');
});

test('a marcação manual da equipe sempre vence o cálculo', () => {
  const lead = { temperatura: 'frio', temperatura_manual: true };
  const decisao = decidirTemperatura(lead, 95);

  assert.equal(decisao.temperatura, 'frio', 'quem falou com a pessoa sabe o que o score não capta');
  assert.equal(decisao.origem, 'equipe');
});

test('sem marcação manual, o score decide', () => {
  const decisao = decidirTemperatura({ temperatura: 'frio', temperatura_manual: false }, 70);

  assert.equal(decisao.temperatura, 'quente');
  assert.equal(decisao.origem, 'score');
});

// ---------------------------------------------------------------- normalização

test('a qualificação recusa valor fora do vocabulário', () => {
  const limpo = normalizarQualificacao({
    interesse: '  Preenchimento facial  ',
    pagamento: 'bitcoin',
    urgencia: 'agora-mesmo',
    disponibilidade: 'madrugada',
    primeira_consulta: 'talvez',
  });

  assert.equal(limpo.interesse, 'Preenchimento facial', 'texto livre é apenas aparado');
  assert.equal(limpo.pagamento, undefined, 'valor torto não é gravado');
  assert.equal(limpo.urgencia, undefined);
  assert.equal(limpo.disponibilidade, undefined);
  assert.equal(limpo.primeira_consulta, undefined, 'booleano precisa ser booleano');
});

test('a qualificação aceita os valores válidos', () => {
  const limpo = normalizarQualificacao({
    interesse: 'botox', especialidade: 'dermatologia', primeira_consulta: false,
    pagamento: 'convenio', convenio_nome: 'Unimed', urgencia: 'semanas', disponibilidade: 'tarde',
  });

  assert.deepEqual(limpo, {
    interesse: 'botox', especialidade: 'dermatologia', primeira_consulta: false,
    pagamento: 'convenio', convenio_nome: 'Unimed', urgencia: 'semanas', disponibilidade: 'tarde',
  });
});

test('campo de texto é limitado — não vira depósito de conversa', () => {
  const limpo = normalizarQualificacao({ interesse: 'a'.repeat(500) });
  assert.equal(limpo.interesse.length, 200);
});

test('origem e UTM são normalizadas', () => {
  const limpo = normalizarOrigem({
    utm_source: ' instagram ', utm_campaign: 'verao2026',
    origem_detalhe: 'anúncio do feed', campo_inventado: 'ignorado',
  });

  assert.deepEqual(limpo, {
    utm_source: 'instagram', utm_campaign: 'verao2026', origem_detalhe: 'anúncio do feed',
  });
});

// ---------------------------------------------------------------- próxima ação

test('a próxima ação diz o que fazer agora, em uma frase', () => {
  assert.match(proximaAcao({}), /^Perguntar: /);
  assert.match(proximaAcao({ estagio: 'agendado' }), /Confirmar presença/);
  assert.match(proximaAcao({ estagio: 'convertido' }), /retorno/i);
  assert.match(proximaAcao({ estagio: 'perdido', perdido_motivo: 'foi para outra clínica' }), /outra clínica/);

  const completo = {
    interesse: 'x', primeira_consulta: true, urgencia: 'imediata',
    pagamento: 'particular', disponibilidade: 'manha',
  };
  assert.match(proximaAcao(completo), /oferecer horário/i);
});
