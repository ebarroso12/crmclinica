'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planejarLembretes, instanteDeEnvio, decidirEnvio, proximaTentativa, esgotou,
  abandonado, montarTexto, montarEnvelope, mascararTelefone, ehPedidoDeOptOut,
  referenciaDoDia, horaLocal, primeiroNome, ErroDeLembrete,
} = require('../src/dominio/lembretes');

// Regras dos lembretes, sem banco e sem rede.
//
// Os testes de fuso são os mais importantes daqui. O servidor roda em UTC e a
// clínica atende em São Paulo: um lembrete que diz "às 14:00" para uma consulta
// das 11:00 é o tipo de erro que ninguém percebe em desenvolvimento e todo mundo
// percebe quando o paciente aparece três horas atrasado.

const HORA = 60 * 60 * 1000;

// 3 de agosto de 2026, 14:00 em São Paulo = 17:00 UTC (BRT = UTC-3).
const CONSULTA = new Date('2026-08-03T17:00:00.000Z');

test('o lembrete de 24h sai 24 horas antes e o de 2h, duas horas antes', () => {
  assert.equal(instanteDeEnvio(CONSULTA, 'confirmacao_24h').toISOString(), '2026-08-02T17:00:00.000Z');
  assert.equal(instanteDeEnvio(CONSULTA, 'confirmacao_2h').toISOString(), '2026-08-03T15:00:00.000Z');
});

test('tipo desconhecido não vira lembrete silencioso', () => {
  assert.throws(() => instanteDeEnvio(CONSULTA, 'confirmacao_5min'), ErroDeLembrete);
});

test('planejar devolve os dois lembretes, ambos pendentes, quando há tempo', () => {
  const planos = planejarLembretes({ inicio: CONSULTA.toISOString() }, {
    agora: new Date(CONSULTA.getTime() - 72 * HORA),
  });

  assert.equal(planos.length, 2);
  assert.deepEqual(planos.map((plano) => plano.tipo), ['confirmacao_24h', 'confirmacao_2h']);
  assert.ok(planos.every((plano) => plano.estado === 'pendente'));
  // A janela é o instante da consulta: é o que amarra a idempotência.
  assert.ok(planos.every((plano) => plano.janela === CONSULTA.toISOString()));
});

test('marcar em cima da hora não inventa um lembrete de 24h — ele nasce ignorado', () => {
  // Consulta daqui a três horas: não houve 24h para avisar.
  const planos = planejarLembretes({ inicio: CONSULTA.toISOString() }, {
    agora: new Date(CONSULTA.getTime() - 3 * HORA),
  });

  const vinteQuatro = planos.find((plano) => plano.tipo === 'confirmacao_24h');
  const duas = planos.find((plano) => plano.tipo === 'confirmacao_2h');

  assert.equal(vinteQuatro.estado, 'ignorado');
  assert.equal(vinteQuatro.ignorado_motivo ?? vinteQuatro.ignoradoMotivo, 'janela_no_passado');
  // O de 2h ainda tem futuro: sai daqui a uma hora.
  assert.equal(duas.estado, 'pendente');
});

test('agendamento que já começou não gera lembrete nenhum', () => {
  const planos = planejarLembretes({ inicio: CONSULTA.toISOString() }, {
    agora: new Date(CONSULTA.getTime() + HORA),
  });
  assert.ok(planos.every((plano) => plano.estado === 'ignorado'));
});

// ---------------------------------------------------------------- decisão de envio

function cenario(sobrescritas = {}) {
  return {
    lembrete: {
      id: 1,
      tipo: 'confirmacao_24h',
      janela: CONSULTA.toISOString(),
      agendar_para: new Date(CONSULTA.getTime() - 24 * HORA).toISOString(),
      tentativas: 0,
      ...sobrescritas.lembrete,
    },
    agendamento: {
      id: 9, status: 'agendado', inicio: CONSULTA.toISOString(), ...sobrescritas.agendamento,
    },
    contato: {
      id: 3, nome: 'Marina Souza', telefone: '5516999998888', lembretes_optout: false, ...sobrescritas.contato,
    },
    agora: sobrescritas.agora ?? new Date(CONSULTA.getTime() - 24 * HORA),
  };
}

test('na hora certa, com tudo em ordem, o lembrete sai', () => {
  assert.deepEqual(decidirEnvio(cenario()), { enviar: true, motivo: null });
});

for (const status of ['cancelado', 'compareceu', 'faltou']) {
  test(`agendamento ${status} não recebe lembrete`, () => {
    const decisao = decidirEnvio(cenario({ agendamento: { status } }));
    assert.equal(decisao.enviar, false);
    assert.equal(decisao.motivo, `agendamento_${status}`);
  });
}

test('opt-out do contato impede o envio mesmo com tudo o mais em ordem', () => {
  const decisao = decidirEnvio(cenario({ contato: { lembretes_optout: true } }));
  assert.equal(decisao.enviar, false);
  assert.equal(decisao.motivo, 'optout');
});

test('remarcado: o lembrete da janela antiga não vale para o horário novo', () => {
  const decisao = decidirEnvio(cenario({
    agendamento: { inicio: new Date(CONSULTA.getTime() + 2 * HORA).toISOString() },
  }));
  assert.equal(decisao.enviar, false);
  assert.equal(decisao.motivo, 'remarcado');
});

test('antes da hora, a linha volta à fila em vez de ser ignorada', () => {
  const decisao = decidirEnvio(cenario({ agora: new Date(CONSULTA.getTime() - 30 * HORA) }));
  assert.equal(decisao.enviar, false);
  assert.equal(decisao.motivo, 'ainda_nao_e_hora');
});

test('atraso dentro da tolerância ainda envia; além dela, não', () => {
  // O de 24h tolera 6h de atraso.
  const dentro = decidirEnvio(cenario({ agora: new Date(CONSULTA.getTime() - 20 * HORA) }));
  assert.equal(dentro.enviar, true);

  const fora = decidirEnvio(cenario({ agora: new Date(CONSULTA.getTime() - 17 * HORA) }));
  assert.equal(fora.enviar, false);
  assert.equal(fora.motivo, 'atrasado_demais');
});

test('contato sem telefone não vira tentativa de envio', () => {
  const decisao = decidirEnvio(cenario({ contato: { telefone: null } }));
  assert.equal(decisao.enviar, false);
  assert.equal(decisao.motivo, 'sem_telefone');
});

test('agendamento apagado no meio do caminho não derruba a decisão', () => {
  const base = cenario();
  const decisao = decidirEnvio({ ...base, agendamento: null });
  assert.equal(decisao.enviar, false);
  assert.equal(decisao.motivo, 'agendamento_ausente');
});

// ---------------------------------------------------------------- retry

test('o backoff dobra a cada tentativa e para no teto de uma hora', () => {
  const base = new Date('2026-08-01T12:00:00.000Z');
  const minutos = (tentativa) => (proximaTentativa(tentativa, { agora: base }) - base) / 60_000;

  assert.equal(minutos(1), 1);
  assert.equal(minutos(2), 2);
  assert.equal(minutos(3), 4);
  assert.equal(minutos(4), 8);
  // Teto: sem ele, a décima tentativa cairia daqui a oito horas.
  assert.equal(minutos(20), 60);
});

test('esgotar tentativas é o que separa "tenta de novo" de "falhou"', () => {
  assert.equal(esgotou(4, 5), false);
  assert.equal(esgotou(5, 5), true);
  assert.equal(esgotou(6, 5), true);
});

test('linha presa em processando há tempo demais é considerada abandonada', () => {
  const agora = new Date('2026-08-01T12:00:00.000Z');
  const preso = {
    estado: 'processando',
    processando_desde: new Date(agora.getTime() - 10 * 60_000).toISOString(),
  };
  const recente = {
    estado: 'processando',
    processando_desde: new Date(agora.getTime() - 60_000).toISOString(),
  };

  assert.equal(abandonado(preso, { agora }), true);
  assert.equal(abandonado(recente, { agora }), false);
  assert.equal(abandonado({ estado: 'pendente' }, { agora }), false);
});

// ---------------------------------------------------------------- texto e fuso

test('a hora sai no fuso da clínica, não no do servidor', () => {
  // 17:00 UTC é 14:00 em São Paulo. Se este teste falhar mostrando "17:00",
  // o sistema está falando no fuso do servidor.
  assert.equal(horaLocal(CONSULTA), '14:00');
});

test('o texto diz hoje, amanhã ou a data — do ponto de vista de São Paulo', () => {
  assert.equal(referenciaDoDia(CONSULTA, new Date(CONSULTA.getTime() - 2 * HORA)), 'hoje');
  assert.equal(referenciaDoDia(CONSULTA, new Date(CONSULTA.getTime() - 24 * HORA)), 'amanhã');
  assert.equal(referenciaDoDia(CONSULTA, new Date(CONSULTA.getTime() - 96 * HORA)), 'dia 03/08');
});

test('a virada do dia é a de São Paulo, não a de UTC', () => {
  // 3/8 às 02:00 UTC ainda é 2/8 às 23:00 em São Paulo.
  const consultaDeMadrugada = new Date('2026-08-03T02:00:00.000Z');
  const agora = new Date('2026-08-02T20:00:00.000Z'); // 2/8, 17:00 em São Paulo

  // Mesmo dia local: "hoje", ainda que a data UTC já seja outra.
  assert.equal(referenciaDoDia(consultaDeMadrugada, agora), 'hoje');
});

test('o texto do lembrete de 24h pede confirmação e ensina a sair', () => {
  const texto = montarTexto({
    tipo: 'confirmacao_24h',
    contato: { nome: 'Marina Souza' },
    inicio: CONSULTA,
    clinica: 'Clínica Dr. Edson Barroso',
    agora: new Date(CONSULTA.getTime() - 24 * HORA),
  });

  assert.match(texto, /Marina/);
  assert.match(texto, /amanhã/);
  assert.match(texto, /14:00/);
  assert.match(texto, /SIM/);
  assert.match(texto, /PARAR/);
  // Só o primeiro nome: o sobrenome não acrescenta nada e é dado a mais no canal.
  assert.doesNotMatch(texto, /Souza/);
});

test('o texto não carrega nada clínico', () => {
  const texto = montarTexto({
    tipo: 'confirmacao_2h',
    contato: { nome: 'Marina' },
    inicio: CONSULTA,
    clinica: 'Clínica Dr. Edson Barroso',
    agora: new Date(CONSULTA.getTime() - 2 * HORA),
  });

  for (const proibido of ['procedimento', 'retorno', 'avaliacao', 'exame', 'diagnóstico']) {
    assert.doesNotMatch(texto.toLowerCase(), new RegExp(proibido));
  }
});

test('contato sem nome ainda recebe um texto que faz sentido', () => {
  const texto = montarTexto({
    tipo: 'confirmacao_24h', contato: {}, inicio: CONSULTA, clinica: 'Clínica X',
    agora: new Date(CONSULTA.getTime() - 24 * HORA),
  });
  assert.match(texto, /^Olá!/);
});

test('primeiroNome ignora espaço extra e devolve null para vazio', () => {
  assert.equal(primeiroNome('  Ana  Paula '), 'Ana');
  assert.equal(primeiroNome(''), null);
  assert.equal(primeiroNome(null), null);
});

// ---------------------------------------------------------------- envelope

test('o envelope leva o mínimo: destinatário, texto e uma referência opaca', () => {
  const envelope = montarEnvelope({
    lembrete: { id: 7, tipo: 'confirmacao_24h' },
    agendamento: { inicio: CONSULTA.toISOString(), tipo: 'procedimento', observacoes: 'sigiloso' },
    contato: { nome: 'Marina', telefone: '5516999998888' },
    clinica: 'Clínica Dr. Edson Barroso',
    agora: new Date(CONSULTA.getTime() - 24 * HORA),
  });

  assert.deepEqual(Object.keys(envelope).sort(), ['canal', 'destinatario', 'referencia', 'texto', 'tipo']);
  assert.equal(envelope.referencia, 'lembrete:7');
  assert.equal(envelope.canal, 'whatsapp');
  // O que o agendamento sabe sobre a consulta não atravessa.
  assert.doesNotMatch(JSON.stringify(envelope), /sigiloso|procedimento/);
});

test('telefone em log e em API sai mascarado', () => {
  assert.equal(mascararTelefone('5516999998888'), '***8888');
  assert.equal(mascararTelefone('12'), '***');
  assert.equal(mascararTelefone(null), '***');
});

// ---------------------------------------------------------------- opt-out por mensagem

test('mensagem curta e direta vale como pedido de opt-out', () => {
  for (const texto of ['PARAR', 'parar', ' Pare. ', 'sair', 'STOP', 'descadastrar']) {
    assert.equal(ehPedidoDeOptOut(texto), true, `"${texto}" deveria valer como opt-out`);
  }
});

test('frase que só contém a palavra não vale como opt-out', () => {
  // O erro que este teste existe para impedir: desligar os lembretes de quem
  // escreveu uma frase comprida onde a palavra aparece por acaso.
  for (const texto of [
    'não quero parar o tratamento',
    'posso parar de tomar o remédio?',
    'vou sair do trabalho às 17h, dá pra marcar depois?',
    '',
    null,
  ]) {
    assert.equal(ehPedidoDeOptOut(texto), false, `"${texto}" não deveria valer como opt-out`);
  }
});
