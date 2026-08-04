'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decidirResposta, dentroDoHorario, validarAgenda, FUSO_PADRAO,
} = require('../src/dominio/serena');

// Horário programado, pausa e plantão.
//
// O que se testa aqui é sobretudo a ORDEM entre eles. Cada camada isolada é
// trivial; o que quebra em produção é a combinação — a pausa que o horário
// desfaz, o plantão que passa por cima do desligamento, a janela noturna que
// cala quem configurou para atender de madrugada.

/** Um instante real, dito no fuso da clínica, sem depender do fuso da máquina. */
function emSaoPaulo(texto) {
  // -03:00 é o horário de Brasília sem verão, que é o vigente.
  return new Date(`${texto}-03:00`);
}

const QUINTA_10H = emSaoPaulo('2026-08-06T10:00:00');
const QUINTA_20H = emSaoPaulo('2026-08-06T20:00:00');
const DOMINGO_10H = emSaoPaulo('2026-08-02T10:00:00');

const COMERCIAL = {
  ativa: true,
  fuso: FUSO_PADRAO,
  dias: {
    0: [], 6: [],
    1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']],
    4: [['08:00', '18:00']], 5: [['08:00', '18:00']],
  },
};

test('sem grade, ou com a grade desligada, a Serena responde', () => {
  // Ausência de configuração não pode virar silêncio: o horário é um limite que
  // alguém escolhe pôr, e quem nunca entrou na tela não escolheu calar nada.
  assert.equal(dentroDoHorario(null, QUINTA_20H), true);
  assert.equal(dentroDoHorario(undefined, QUINTA_20H), true);
  assert.equal(dentroDoHorario({ ...COMERCIAL, ativa: false }, QUINTA_20H), true);
});

test('a grade vale no fuso da clínica, não no do servidor', () => {
  // O servidor roda em UTC. Às 20h de São Paulo já é 23h em UTC — ler a hora do
  // processo faria a Serena calar às 15h e voltar a falar de madrugada.
  assert.equal(dentroDoHorario(COMERCIAL, QUINTA_10H), true);
  assert.equal(dentroDoHorario(COMERCIAL, QUINTA_20H), false);
});

test('dia sem janela nenhuma é dia fechado', () => {
  assert.equal(dentroDoHorario(COMERCIAL, DOMINGO_10H), false);
});

test('a borda de abertura entra; a de fechamento não', () => {
  assert.equal(dentroDoHorario(COMERCIAL, emSaoPaulo('2026-08-06T08:00:00')), true);
  assert.equal(dentroDoHorario(COMERCIAL, emSaoPaulo('2026-08-06T07:59:00')), false);
  // 18:00 é quando fecha, não o último minuto aberto — senão duas janelas
  // coladas (08–12, 12–18) fariam o meio-dia pertencer às duas.
  assert.equal(dentroDoHorario(COMERCIAL, emSaoPaulo('2026-08-06T18:00:00')), false);
  assert.equal(dentroDoHorario(COMERCIAL, emSaoPaulo('2026-08-06T17:59:00')), true);
});

test('duas janelas no mesmo dia deixam o intervalo de almoço fechado', () => {
  const comAlmoco = { ativa: true, fuso: FUSO_PADRAO, dias: { 4: [['08:00', '12:00'], ['13:00', '18:00']] } };
  assert.equal(dentroDoHorario(comAlmoco, emSaoPaulo('2026-08-06T11:00:00')), true);
  assert.equal(dentroDoHorario(comAlmoco, emSaoPaulo('2026-08-06T12:30:00')), false);
  assert.equal(dentroDoHorario(comAlmoco, emSaoPaulo('2026-08-06T14:00:00')), true);
});

test('janela que cruza a meia-noite vale nas duas metades', () => {
  // A leitura ingênua (`inicio <= agora <= fim`) calaria exatamente quem
  // configurou plantão noturno — 22:00 não é menor que 02:00.
  const noturno = { ativa: true, fuso: FUSO_PADRAO, dias: { 4: [['22:00', '02:00']] } };

  assert.equal(dentroDoHorario(noturno, emSaoPaulo('2026-08-06T23:00:00')), true, 'quinta 23h');
  assert.equal(dentroDoHorario(noturno, emSaoPaulo('2026-08-07T01:00:00')), true, 'sexta 1h ainda é a quinta');
  assert.equal(dentroDoHorario(noturno, emSaoPaulo('2026-08-07T03:00:00')), false, 'sexta 3h já fechou');
  assert.equal(dentroDoHorario(noturno, emSaoPaulo('2026-08-06T21:00:00')), false, 'quinta 21h ainda não abriu');
});

test('00:00–00:00 é como se escreve "o dia inteiro"', () => {
  const sempre = { ativa: true, fuso: FUSO_PADRAO, dias: { 4: [['00:00', '00:00']] } };
  assert.equal(dentroDoHorario(sempre, QUINTA_10H), true);
  assert.equal(dentroDoHorario(sempre, emSaoPaulo('2026-08-06T03:00:00')), true);
});

test('fuso inválido cai no padrão em vez de estourar na decisão de responder', () => {
  const torto = { ativa: true, fuso: 'Marte/Olympus', dias: { 4: [['08:00', '18:00']] } };
  assert.equal(dentroDoHorario(torto, QUINTA_10H), true);
});

// ------------------------------------------------------------------ precedência

test('o desligamento global vence o horário, a pausa e o plantão', () => {
  const config = {
    ativa: false,
    agenda: COMERCIAL,
    ligada_ate: new Date(QUINTA_20H.getTime() + 3600_000),
  };
  assert.deepEqual(decidirResposta({}, config, QUINTA_10H), {
    responder: false, motivo: 'serena_desligada', escopo: 'global',
  });
});

test('a pausa cala mesmo dentro do horário', () => {
  const config = { ativa: true, agenda: COMERCIAL, pausada_ate: new Date(QUINTA_10H.getTime() + 600_000) };
  assert.deepEqual(decidirResposta({}, config, QUINTA_10H), {
    responder: false, motivo: 'serena_pausada', escopo: 'global',
  });
});

test('pausa vencida não cala mais nada', () => {
  const config = { ativa: true, agenda: COMERCIAL, pausada_ate: new Date(QUINTA_10H.getTime() - 1000) };
  assert.equal(decidirResposta({}, config, QUINTA_10H).responder, true);
});

test('fora do horário, sem plantão, a Serena não responde', () => {
  assert.deepEqual(decidirResposta({}, { ativa: true, agenda: COMERCIAL }, QUINTA_20H), {
    responder: false, motivo: 'fora_do_horario', escopo: 'global',
  });
});

test('o plantão esporádico vence o horário — e só ele', () => {
  const emPlantao = {
    ativa: true, agenda: COMERCIAL, ligada_ate: new Date(QUINTA_20H.getTime() + 3600_000),
  };
  assert.equal(decidirResposta({}, emPlantao, QUINTA_20H).responder, true);

  // Vencido, o horário volta a mandar.
  const vencido = { ativa: true, agenda: COMERCIAL, ligada_ate: new Date(QUINTA_20H.getTime() - 1000) };
  assert.equal(decidirResposta({}, vencido, QUINTA_20H).motivo, 'fora_do_horario');
});

test('o plantão não passa por cima da pausa', () => {
  // Estado que o serviço nunca grava — pausar limpa o plantão. Mas se o banco
  // for editado à mão, a decisão humana mais restritiva é a que vale.
  const config = {
    ativa: true,
    agenda: COMERCIAL,
    ligada_ate: new Date(QUINTA_20H.getTime() + 3600_000),
    pausada_ate: new Date(QUINTA_20H.getTime() + 600_000),
  };
  assert.equal(decidirResposta({}, config, QUINTA_20H).motivo, 'serena_pausada');
});

test('a regra por conversa continua valendo dentro do horário', () => {
  const config = { ativa: true, agenda: COMERCIAL };
  assert.equal(decidirResposta({ assumida_por_humano: true }, config, QUINTA_10H).motivo, 'assumida_por_humano');
});

test('o global vem antes do da conversa: fora do horário nem se olha a conversa', () => {
  const config = { ativa: true, agenda: COMERCIAL };
  const decisao = decidirResposta({ assumida_por_humano: true }, config, QUINTA_20H);
  assert.equal(decisao.motivo, 'fora_do_horario');
  assert.equal(decisao.escopo, 'global');
});

// ------------------------------------------------------------------ validação

test('a grade válida volta normalizada, com os sete dias', () => {
  const limpa = validarAgenda({ ativa: true, dias: { 1: [['08:00', '18:00']] } });
  assert.equal(limpa.ativa, true);
  assert.equal(limpa.fuso, FUSO_PADRAO);
  assert.deepEqual(Object.keys(limpa.dias), ['0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(limpa.dias['1'], [['08:00', '18:00']]);
  assert.deepEqual(limpa.dias['3'], []);
});

test('horário malformado é recusado com o dia e a janela que o causaram', () => {
  assert.throws(() => validarAgenda({ dias: { 2: [['8h', '18:00']] } }), (erro) => {
    assert.equal(erro.codigo, 'agenda_invalida');
    assert.match(erro.message, /terça/);
    return true;
  });
  assert.throws(() => validarAgenda({ dias: { 1: [['25:00', '26:00']] } }), /inválido/);
  assert.throws(() => validarAgenda({ dias: { 1: [['08:00']] } }), /início, fim/);
  assert.throws(() => validarAgenda({ fuso: 'Marte/Olympus' }), /fuso/);
  assert.throws(() => validarAgenda([]), /objeto/);
});

test('grade ausente continua ausente — não vira grade vazia que cala tudo', () => {
  assert.equal(validarAgenda(null), null);
  assert.equal(validarAgenda(undefined), null);
});
