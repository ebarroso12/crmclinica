'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { domingoDePascoa, feriadosDoAno, feriadoEm, proximosFeriados } = require('../src/dominio/feriados');
const { dentroDoHorario } = require('../src/dominio/serena');

// Feriados: os dias em que a clínica não abre e a Serena atende integral.
//
// Regra do Dr. Edson (12/09/2026): dia útil das 7:45 às 18:30 é da equipe;
// fim de semana E FERIADO são da Serena, o dia todo.
//
// O teste que mais importa é o último bloco: a grade entende dia da SEMANA, e
// sem esta mudança um feriado na terça seria lido como "terça" — calando a
// Serena justamente no dia em que não há ninguém na clínica.

const AGENDA = {
  ativa: true,
  fuso: 'America/Sao_Paulo',
  dias: {
    0: [['00:00', '23:59']],
    1: [['00:00', '07:45'], ['18:30', '23:59']],
    2: [['00:00', '07:45'], ['18:30', '23:59']],
    3: [['00:00', '07:45'], ['18:30', '23:59']],
    4: [['00:00', '07:45'], ['18:30', '23:59']],
    5: [['00:00', '07:45'], ['18:30', '23:59']],
    6: [['00:00', '23:59']],
  },
};

/** Um instante em São Paulo (UTC-3), escrito como o relógio da clínica mostra. */
const emSaoPaulo = (texto) => new Date(`${texto}-03:00`);

// ---------------------------------------------------------------- Páscoa

test('a Páscoa é calculada, não tabelada — os móveis mudam todo ano', () => {
  // Datas conferíveis em qualquer calendário.
  const esperado = {
    2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05',
    2027: '2027-03-28', 2030: '2030-04-21',
  };
  for (const [ano, data] of Object.entries(esperado)) {
    assert.equal(domingoDePascoa(Number(ano)).toISOString().slice(0, 10), data, `Páscoa de ${ano}`);
  }
});

test('Sexta-feira Santa cai dois dias antes da Páscoa', () => {
  const de2026 = feriadosDoAno(2026);
  assert.ok(de2026['2026-04-03'], 'Sexta-feira Santa de 2026');
  assert.equal(de2026['2026-04-03'].nome, 'Sexta-feira Santa');
});

// ---------------------------------------------------------------- a lista

test('os feriados nacionais que param estão na lista', () => {
  const de2026 = feriadosDoAno(2026);
  const esperados = {
    '2026-01-01': 'Confraternização Universal',
    '2026-04-21': 'Tiradentes',
    '2026-05-01': 'Dia do Trabalho',
    '2026-09-07': 'Independência do Brasil',
    '2026-10-12': 'Nossa Senhora Aparecida',
    '2026-11-02': 'Finados',
    '2026-11-15': 'Proclamação da República',
    '2026-11-20': 'Consciência Negra',
    '2026-12-25': 'Natal',
  };
  for (const [data, nome] of Object.entries(esperados)) {
    assert.ok(de2026[data], `falta ${nome} (${data})`);
    assert.equal(de2026[data].nome, nome);
  }
});

test('os dois feriados de Franca-SP estão na lista', () => {
  // Lei Municipal 6.730/2006 — conferida na fonte, não de memória.
  const de2026 = feriadosDoAno(2026);
  assert.equal(de2026['2026-11-28']?.nome, 'Aniversário de Franca');
  assert.equal(de2026['2026-11-28']?.tipo, 'municipal');
  assert.ok(de2026['2026-12-08']?.nome.includes('Conceição'));
  assert.equal(de2026['2026-12-08']?.tipo, 'municipal');
});

test('Carnaval e Corpus Christi ficam DE FORA por padrão', () => {
  // Não são feriado por lei federal, e cada clínica decide se abre — presumir
  // que fecha calaria a equipe num dia em que ela talvez esteja atendendo.
  const padrao = feriadosDoAno(2026);
  assert.ok(!padrao['2026-02-17'], 'terça de carnaval não entra sozinha');

  const comFacultativos = feriadosDoAno(2026, { incluirFacultativos: true });
  assert.ok(comFacultativos['2026-02-17'], 'mas entram quando o admin liga');
  assert.equal(comFacultativos['2026-02-17'].tipo, 'facultativo');
  assert.ok(comFacultativos['2026-06-04'], 'Corpus Christi de 2026');
});

test('ano fora de faixa devolve lista vazia em vez de estourar', () => {
  for (const ano of [null, undefined, 'abc', 1500, 3000]) {
    assert.deepEqual(feriadosDoAno(ano), {});
  }
});

// ---------------------------------------------------------------- fuso

test('o feriado começa e termina pelo relógio da clínica, não pelo UTC', () => {
  // Às 21h de 24/12 em São Paulo já é dia 25 em UTC: sem o fuso certo, a
  // Serena entraria em modo feriado três horas antes.
  assert.equal(feriadoEm(emSaoPaulo('2026-12-24T21:00'))?.nome, undefined,
    'ainda é véspera em São Paulo');
  assert.equal(feriadoEm(emSaoPaulo('2026-12-25T00:30'))?.nome, 'Natal');
  assert.equal(feriadoEm(emSaoPaulo('2026-12-25T23:30'))?.nome, 'Natal');
  assert.equal(feriadoEm(emSaoPaulo('2026-12-26T00:30')), null, 'acabou o Natal');
});

test('data inválida devolve null, sem quebrar a decisão de responder', () => {
  assert.equal(feriadoEm(new Date('nao-e-data')), null);
  assert.equal(feriadoEm('qualquer coisa'), null);
});

// ---------------------------------------------------------------- ajustes do admin

test('o admin pode marcar um dia à mão (emenda, recesso)', () => {
  const extras = { '2026-10-13': 'Emenda do feriado' };
  assert.equal(feriadoEm(emSaoPaulo('2026-10-13T10:00'), { extras })?.nome, 'Emenda do feriado');
  assert.equal(feriadoEm(emSaoPaulo('2026-10-14T10:00'), { extras }), null);
});

test('o admin pode dizer que a clínica ABRE num feriado', () => {
  const removidos = ['2026-11-20'];
  assert.equal(feriadoEm(emSaoPaulo('2026-11-20T10:00')).nome, 'Consciência Negra');
  assert.equal(feriadoEm(emSaoPaulo('2026-11-20T10:00'), { removidos }), null,
    'quem abre no feriado manda na lista');
});

test('os próximos feriados atravessam a virada do ano', () => {
  // Em dezembro, "os próximos" estão em janeiro — uma lista só do ano corrente
  // apareceria vazia justamente quando alguém quer planejar.
  const lista = proximosFeriados(emSaoPaulo('2026-12-26T10:00'), { quantidade: 3 });
  assert.ok(lista.length === 3, 'precisa achar três');
  assert.equal(lista[0].data, '2027-01-01');
  assert.ok(lista.every((f, i) => i === 0 || f.data >= lista[i - 1].data), 'em ordem');
});

// ---------------------------------------------------------------- o efeito real

test('FERIADO EM DIA ÚTIL: a Serena atende no horário comercial', () => {
  // 12/10/2026 (Nossa Senhora Aparecida) cai numa SEGUNDA. Às 10h a grade diz
  // "segunda, fora da janela" — sem o tratamento de feriado, ela ficaria muda
  // no dia em que a clínica está fechada.
  const feriadoDeSegunda = emSaoPaulo('2026-10-12T10:00');
  assert.equal(feriadoEm(feriadoDeSegunda)?.nome, 'Nossa Senhora Aparecida');
  assert.equal(dentroDoHorario(AGENDA, feriadoDeSegunda), true, 'feriado = dia todo dela');

  // A mesma hora numa segunda comum continua sendo da equipe.
  assert.equal(dentroDoHorario(AGENDA, emSaoPaulo('2026-10-05T10:00')), false);
});

test('dia útil comum segue a regra de 7:45 às 18:30', () => {
  const casos = [
    ['2026-10-05T07:30', true, 'antes das 7:45 é dela'],
    ['2026-10-05T07:50', false, 'depois das 7:45 é da equipe'],
    ['2026-10-05T12:00', false, 'meio do expediente'],
    ['2026-10-05T18:20', false, 'ainda no expediente'],
    ['2026-10-05T18:40', true, 'depois das 18:30 volta a ser dela'],
    ['2026-10-05T23:00', true, 'noite'],
  ];
  for (const [instante, esperado, motivo] of casos) {
    assert.equal(dentroDoHorario(AGENDA, emSaoPaulo(instante)), esperado, `${instante}: ${motivo}`);
  }
});

test('fim de semana continua integral', () => {
  assert.equal(dentroDoHorario(AGENDA, emSaoPaulo('2026-10-10T10:00')), true, 'sábado');
  assert.equal(dentroDoHorario(AGENDA, emSaoPaulo('2026-10-11T10:00')), true, 'domingo');
});

test('quem desliga os feriados volta ao comportamento de antes', () => {
  const semFeriado = { ...AGENDA, feriados: { ativo: false } };
  assert.equal(dentroDoHorario(semFeriado, emSaoPaulo('2026-10-12T10:00')), false,
    'com feriados desligados, o feriado vira segunda comum');
});

test('agenda antiga, sem a chave de feriados, já nasce com eles ligados', () => {
  // Quem configurou a grade antes desta mudança não pediu para trabalhar em
  // feriado — o padrão tem de ser o que a clínica faz na vida real.
  assert.equal(AGENDA.feriados, undefined);
  assert.equal(dentroDoHorario(AGENDA, emSaoPaulo('2026-12-25T10:00')), true, 'Natal');
});
