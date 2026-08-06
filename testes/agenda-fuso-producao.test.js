'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dentroDaDisponibilidade,
  horariosLivres,
} = require('../src/dominio/agenda');

const GRADE_DE_SEGUNDA = [
  { dia_semana: 1, hora_inicio: '08:30', hora_fim: '11:30' },
  { dia_semana: 1, hora_inicio: '13:00', hora_fim: '18:00' },
];

test('08:30 de São Paulo é validado corretamente quando o processo roda em UTC', () => {
  // Segunda-feira, 10/08/2026, 08:30–10:00 em São Paulo.
  // Na Vercel esse mesmo período chega como 11:30–13:00Z.
  const inicio = new Date('2026-08-10T11:30:00.000Z');
  const fim = new Date('2026-08-10T13:00:00.000Z');

  assert.equal(dentroDaDisponibilidade(inicio, fim, GRADE_DE_SEGUNDA), true);
});

test('intervalo que atravessa a pausa local continua sendo recusado', () => {
  // 11:30–13:00 em São Paulo atravessa a pausa entre manhã e tarde.
  const inicio = new Date('2026-08-10T14:30:00.000Z');
  const fim = new Date('2026-08-10T16:00:00.000Z');

  assert.equal(dentroDaDisponibilidade(inicio, fim, GRADE_DE_SEGUNDA), false);
});

test('um horário oferecido pela agenda passa pela mesma validação usada para gravar', () => {
  const livres = horariosLivres({
    dia: new Date('2026-08-10T15:00:00.000Z'),
    duracaoMin: 90,
    disponibilidades: GRADE_DE_SEGUNDA,
    agora: new Date('2026-08-06T12:00:00.000Z'),
  });

  assert.ok(livres.length > 0);
  for (const horario of livres) {
    assert.equal(
      dentroDaDisponibilidade(new Date(horario.inicio), new Date(horario.fim), GRADE_DE_SEGUNDA),
      true,
      `horário oferecido deveria ser gravável: ${horario.inicio}`,
    );
  }
});
