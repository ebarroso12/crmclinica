'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  seSobrepoe, validarPeriodo, dentroDaDisponibilidade, bloqueado,
  conflitante, horariosLivres, ehConflitoDoBanco, ErroDeAgenda,
} = require('../src/dominio/agenda');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeAgenda } = require('../src/dominio/agenda-servico');
const { ErroDeConflito } = require('../src/dominio/agenda');

// Quinta-feira, para os testes caírem sempre no mesmo dia da semana.
const QUINTA = '2026-08-06T00:00:00.000-03:00';

function em(hora, dia = '2026-08-06') {
  return new Date(`${dia}T${hora}:00.000-03:00`);
}

/** Monta agenda com um profissional que atende quinta, das 8h às 18h. */
async function montar({ agora = em('07:00') } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const agenda = criarServicoDeAgenda({ repositorio, agora: () => agora });

  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Edson', duracaoMin: 30 });
  await repositorio.definirDisponibilidades(profissional.id, [
    { dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' },
  ]);

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id });

  return { repositorio, agenda, profissional, contato, conversa, lead };
}

// ---------------------------------------------------------------- sobreposição

test('intervalos vizinhos não são conflito', () => {
  // 14–15 e 15–16 se encostam, não se sobrepõem: é o dia todo da clínica.
  assert.equal(seSobrepoe(em('14:00'), em('15:00'), em('15:00'), em('16:00')), false);
  assert.equal(seSobrepoe(em('15:00'), em('16:00'), em('14:00'), em('15:00')), false);
});

test('sobreposição parcial e total são conflito', () => {
  assert.equal(seSobrepoe(em('14:00'), em('15:00'), em('14:30'), em('15:30')), true);
  assert.equal(seSobrepoe(em('14:00'), em('16:00'), em('14:30'), em('15:00')), true);
  assert.equal(seSobrepoe(em('14:30'), em('15:00'), em('14:00'), em('16:00')), true);
});

// ---------------------------------------------------------------- validação

test('período invertido, curto demais ou longo demais é recusado', () => {
  const agora = em('07:00');

  assert.throws(() => validarPeriodo(em('15:00'), em('14:00'), { agora }), /depois do início/);
  assert.throws(() => validarPeriodo(em('14:00'), em('14:02'), { agora }), /5 minutos/);
  assert.throws(() => validarPeriodo(em('08:00'), em('20:00'), { agora }), /480 minutos/);
});

test('agendar no passado é recusado', () => {
  // Quase sempre é erro de digitação de data.
  assert.throws(
    () => validarPeriodo(em('06:00'), em('06:30'), { agora: em('07:00') }),
    /passado/,
  );
});

test('período válido devolve as datas e a duração', () => {
  const periodo = validarPeriodo(em('14:00'), em('15:00'), { agora: em('07:00') });
  assert.equal(periodo.minutos, 60);
  assert.ok(periodo.inicio instanceof Date);
});

test('data inválida é recusada com mensagem clara', () => {
  assert.throws(() => validarPeriodo('ontem', em('15:00'), { agora: em('07:00') }), ErroDeAgenda);
});

// ---------------------------------------------------------------- disponibilidade

test('o horário precisa estar dentro da janela do profissional', () => {
  const janelas = [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' }];

  assert.equal(dentroDaDisponibilidade(em('14:00'), em('15:00'), janelas), true);
  assert.equal(dentroDaDisponibilidade(em('07:00'), em('08:00'), janelas), false, 'antes de abrir');
  assert.equal(dentroDaDisponibilidade(em('17:30'), em('18:30'), janelas), false, 'passa do fim');
});

test('dia da semana errado não tem atendimento', () => {
  const janelas = [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' }];
  // 2026-08-07 é sexta.
  assert.equal(dentroDaDisponibilidade(em('14:00', '2026-08-07'), em('15:00', '2026-08-07'), janelas), false);
});

test('sem janela cadastrada, nada está disponível', () => {
  assert.equal(dentroDaDisponibilidade(em('14:00'), em('15:00'), []), false);
});

test('atravessar a meia-noite não é atendimento de clínica', () => {
  const janelas = [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '23:59' }];
  assert.equal(dentroDaDisponibilidade(em('23:00'), em('01:00', '2026-08-07'), janelas), false);
});

// ---------------------------------------------------------------- bloqueios

test('bloqueio impede o horário e diz o motivo', () => {
  const bloqueios = [{ inicio: em('12:00'), fim: em('13:00'), motivo: 'almoço' }];

  assert.equal(bloqueado(em('12:30'), em('13:00'), bloqueios)?.motivo, 'almoço');
  assert.equal(bloqueado(em('14:00'), em('15:00'), bloqueios), null);
  assert.equal(bloqueado(em('13:00'), em('14:00'), bloqueios), null, 'encostar não é bloquear');
});

// ---------------------------------------------------------------- conflito

test('agendamento cancelado libera o horário', () => {
  const existentes = [
    { id: 1, status: 'cancelado', inicio: em('14:00'), fim: em('15:00') },
  ];
  assert.equal(conflitante(em('14:00'), em('15:00'), existentes), null);
});

test('faltou continua ocupando: a vaga já foi perdida', () => {
  const existentes = [{ id: 1, status: 'faltou', inicio: em('14:00'), fim: em('15:00') }];
  assert.ok(conflitante(em('14:00'), em('15:00'), existentes));
});

test('remarcar o próprio agendamento não é conflito consigo mesmo', () => {
  const existentes = [{ id: 7, status: 'agendado', inicio: em('14:00'), fim: em('15:00') }];

  assert.ok(conflitante(em('14:30'), em('15:30'), existentes));
  assert.equal(conflitante(em('14:30'), em('15:30'), existentes, { ignorarId: 7 }), null);
});

test('o erro de exclusão do PostgreSQL é reconhecido', () => {
  assert.equal(ehConflitoDoBanco({ code: '23P01' }), true);
  assert.equal(ehConflitoDoBanco({ constraint: 'agendamentos_sem_conflito' }), true);
  assert.equal(ehConflitoDoBanco({ code: '23505' }), false);
  assert.equal(ehConflitoDoBanco(null), false);
});

// ---------------------------------------------------------------- horários livres

test('os horários livres respeitam janela, bloqueio e ocupação', () => {
  const livres = horariosLivres({
    dia: em('00:00'),
    duracaoMin: 60,
    disponibilidades: [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '12:00' }],
    bloqueios: [{ inicio: em('10:00'), fim: em('11:00'), motivo: 'reunião' }],
    agendamentos: [{ id: 1, status: 'agendado', inicio: em('08:00'), fim: em('09:00') }],
    agora: em('07:00'),
  });

  const inicios = livres.map((h) => new Date(h.inicio).getHours());
  assert.deepEqual(inicios, [9, 11], '8h ocupado, 10h bloqueado; sobram 9h e 11h');
});

test('horário que já passou não é oferecido', () => {
  const livres = horariosLivres({
    dia: em('00:00'),
    duracaoMin: 60,
    disponibilidades: [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '12:00' }],
    agora: em('10:30'),
  });

  const inicios = livres.map((h) => new Date(h.inicio).getHours());
  assert.deepEqual(inicios, [11], 'oferecer horário passado é constrangimento');
});

test('sem disponibilidade no dia, não há horários', () => {
  const livres = horariosLivres({
    dia: em('00:00', '2026-08-07'),
    disponibilidades: [{ dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' }],
    agora: em('07:00'),
  });
  assert.deepEqual(livres, []);
});

// ---------------------------------------------------------------- propor e confirmar

test('propor não grava nada', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id,
    inicio: em('14:00'), fim: em('15:00'),
  });

  assert.ok(proposta.token);
  assert.match(proposta.confirmar, /Confirmar consulta com Dr. Edson/);

  // Nada na agenda até a confirmação: é o que evita marcar o que ninguém pediu.
  assert.equal((await repositorio.listarAgendamentos({})).length, 0);
});

test('confirmar grava o que foi proposto, e só uma vez', async () => {
  const { agenda, repositorio, profissional, contato, conversa, lead } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id,
    conversaId: conversa.id, leadId: lead.id,
    inicio: em('14:00'), fim: em('15:00'),
  });

  const agendamento = await agenda.confirmar(proposta.token);
  assert.equal(agendamento.status, 'agendado');
  assert.equal(agendamento.conversa_id, conversa.id, 'o vínculo com a conversa é preservado');
  assert.equal(agendamento.lead_id, lead.id);

  // O token vale uma vez: reusar não duplica a consulta.
  await assert.rejects(() => agenda.confirmar(proposta.token), /expirada|não encontrada/);
  assert.equal((await repositorio.listarAgendamentos({})).length, 1);
});

test('confirmar deixa auditoria e move o lead na jornada', async () => {
  const { agenda, repositorio, profissional, contato, conversa, lead } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id,
    conversaId: conversa.id, leadId: lead.id, inicio: em('14:00'), fim: em('15:00'),
  });
  await agenda.confirmar(proposta.token, { usuarioId: 1 });

  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'agendamento_criado'));

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'agendamento' });
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].para, 'agendado');
});

test('token inventado ou expirado é recusado', async () => {
  const { agenda } = await montar();
  await assert.rejects(() => agenda.confirmar('inventado'), /proposta/);
});

test('propor fora da disponibilidade é recusado antes de gravar', async () => {
  const { agenda, profissional, contato } = await montar();

  await assert.rejects(
    () => agenda.propor({
      profissionalId: profissional.id, contatoId: contato.id,
      inicio: em('19:00'), fim: em('20:00'),
    }),
    (erro) => erro.codigo === 'fora_da_disponibilidade',
  );
});

test('propor em horário bloqueado é recusado com o motivo', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  await repositorio.criarBloqueio({
    profissionalId: profissional.id,
    inicio: em('12:00').toISOString(), fim: em('13:00').toISOString(), motivo: 'almoço',
  });

  await assert.rejects(
    () => agenda.propor({
      profissionalId: profissional.id, contatoId: contato.id,
      inicio: em('12:00'), fim: em('12:30'),
    }),
    /almoço/,
  );
});

test('bloqueio da clínica inteira vale para todos os profissionais', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  // Sem profissional: feriado.
  await repositorio.criarBloqueio({
    inicio: em('00:00').toISOString(), fim: em('23:59').toISOString(), motivo: 'feriado',
  });

  await assert.rejects(
    () => agenda.propor({
      profissionalId: profissional.id, contatoId: contato.id,
      inicio: em('14:00'), fim: em('15:00'),
    }),
    /feriado/,
  );
});

// ---------------------------------------------------------------- conflito e concorrência

test('marcar em horário ocupado responde conflito', async () => {
  const { agenda, profissional, contato } = await montar();

  const primeira = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  await agenda.confirmar(primeira.token);

  await assert.rejects(
    () => agenda.propor({
      profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:30'), fim: em('15:30'),
    }),
    (erro) => erro instanceof ErroDeConflito && erro.status === 409,
  );
});

test('CONCORRÊNCIA: duas confirmações do mesmo horário — só uma grava', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  // Duas propostas para o mesmo horário: possível, porque propor não reserva.
  // A recepção pelo painel e o paciente pelo WhatsApp podem receber a mesma oferta.
  const [propostaA, propostaB] = await Promise.all([
    agenda.propor({ profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00') }),
    agenda.propor({ profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00') }),
  ]);
  assert.notEqual(propostaA.token, propostaB.token);

  // Confirmadas ao mesmo tempo: a checagem em memória passa nas duas, e é a
  // constraint que decide. Uma grava, a outra recebe 409.
  const resultados = await Promise.allSettled([
    agenda.confirmar(propostaA.token),
    agenda.confirmar(propostaB.token),
  ]);

  const gravadas = resultados.filter((r) => r.status === 'fulfilled');
  const recusadas = resultados.filter((r) => r.status === 'rejected');

  assert.equal(gravadas.length, 1, 'exatamente uma pode gravar');
  assert.equal(recusadas.length, 1);
  assert.equal(recusadas[0].reason.status, 409);
  assert.equal(recusadas[0].reason.codigo, 'conflito_de_agenda');

  // A constraint diz que houve conflito, não com o quê. O serviço vai buscar:
  // sem isso a recepção recebe "ocupado" e tem de procurar na tela o motivo.
  assert.ok(recusadas[0].reason.conflito, 'o 409 precisa dizer qual horário atrapalhou');
  assert.equal(new Date(recusadas[0].reason.conflito.inicio).toISOString(), new Date(em('14:00')).toISOString());

  assert.equal((await repositorio.listarAgendamentos({})).length, 1, 'o banco não pode ter duas');
});

test('a frase de confirmação é legível em voz alta, sem segundos', async () => {
  const { agenda, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id,
    inicio: em('14:00'), fim: em('15:00'),
  });

  // Quem atende lê esta frase para o paciente antes de gravar. "09:00:00" é
  // ruído que atrapalha a leitura.
  assert.match(proposta.confirmar, /\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\?$/);
  assert.doesNotMatch(proposta.confirmar, /\d{2}:\d{2}:\d{2}/);
  assert.ok(proposta.confirmar.includes(profissional.nome));
});

test('CONCORRÊNCIA: cinco gravações simultâneas — só uma sobrevive', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const tentativas = Array.from({ length: 5 }, () => agenda.gravar({
    profissionalId: profissional.id, contatoId: contato.id,
    inicio: em('14:00').toISOString(), fim: em('15:00').toISOString(),
  }));

  const resultados = await Promise.allSettled(tentativas);
  const gravadas = resultados.filter((r) => r.status === 'fulfilled');

  assert.equal(gravadas.length, 1);
  assert.equal((await repositorio.listarAgendamentos({})).length, 1);

  for (const recusada of resultados.filter((r) => r.status === 'rejected')) {
    assert.equal(recusada.reason.status, 409);
  }
});

test('profissionais diferentes no mesmo horário convivem', async () => {
  const { agenda, repositorio, contato } = await montar();

  const outro = await repositorio.criarProfissional({ nome: 'Dra. Ana', duracaoMin: 30 });
  await repositorio.definirDisponibilidades(outro.id, [
    { dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' },
  ]);
  const primeiro = (await repositorio.listarProfissionais())[0];

  const [a, b] = await Promise.all([
    agenda.propor({ profissionalId: primeiro.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00') }),
    agenda.propor({ profissionalId: outro.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00') }),
  ]);
  await agenda.confirmar(a.token);
  await agenda.confirmar(b.token);

  // A restrição é por profissional: a clínica atende dois pacientes ao mesmo tempo.
  assert.equal((await repositorio.listarAgendamentos({})).length, 2);
});

test('horários encostados não conflitam', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const primeira = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  await agenda.confirmar(primeira.token);

  const segunda = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('15:00'), fim: em('16:00'),
  });
  await agenda.confirmar(segunda.token);

  assert.equal((await repositorio.listarAgendamentos({})).length, 2);
});

// ---------------------------------------------------------------- remarcar e cancelar

test('remarcar move o horário e desfaz a confirmação', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);
  await agenda.definirStatus(agendamento.id, 'confirmado');

  const remarcado = await agenda.remarcar(agendamento.id, {
    inicio: em('16:00').toISOString(), fim: em('17:00').toISOString(),
  });

  assert.equal(new Date(remarcado.inicio).getHours(), 16);
  // A pessoa confirmou o horário antigo; o novo precisa de confirmação nova.
  assert.equal(remarcado.status, 'agendado');
  assert.equal(remarcado.confirmado_em, null);
  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'agendamento_remarcado'));
});

test('remarcar para horário ocupado é recusado', async () => {
  const { agenda, profissional, contato } = await montar();

  const a = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const primeiro = await agenda.confirmar(a.token);

  const b = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('16:00'), fim: em('17:00'),
  });
  await agenda.confirmar(b.token);

  await assert.rejects(
    () => agenda.remarcar(primeiro.id, { inicio: em('16:30').toISOString(), fim: em('17:30').toISOString() }),
    (erro) => erro.status === 409,
  );
});

test('cancelar libera o horário para outra pessoa', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);

  await agenda.cancelar(agendamento.id, { motivo: 'paciente desmarcou' });

  const cancelado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(cancelado.status, 'cancelado');
  assert.equal(cancelado.cancelado_motivo, 'paciente desmarcou');

  // O horário volta a ser oferecido.
  const nova = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  await assert.doesNotReject(() => agenda.confirmar(nova.token));
});

test('cancelar duas vezes não quebra', async () => {
  const { agenda, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);

  await agenda.cancelar(agendamento.id);
  const segundo = await agenda.cancelar(agendamento.id);
  assert.equal(segundo.status, 'cancelado');
});

test('agendamento cancelado não é remarcado', async () => {
  const { agenda, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);
  await agenda.cancelar(agendamento.id);

  await assert.rejects(
    () => agenda.remarcar(agendamento.id, { inicio: em('16:00').toISOString(), fim: em('17:00').toISOString() }),
    (erro) => erro.codigo === 'ja_cancelado',
  );
});

// ---------------------------------------------------------------- status

test('comparecer registra na jornada do lead', async () => {
  const { agenda, repositorio, profissional, contato, conversa, lead } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id,
    conversaId: conversa.id, leadId: lead.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);

  await agenda.definirStatus(agendamento.id, 'compareceu', { usuarioId: 1 });

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'comparecimento' });
  assert.equal(eventos.length, 1);
});

test('confirmar registra o instante da confirmação', async () => {
  const { agenda, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token);

  const confirmado = await agenda.definirStatus(agendamento.id, 'confirmado');
  assert.equal(confirmado.status, 'confirmado');
  assert.ok(confirmado.confirmado_em, 'a régua de lembretes precisa saber quando confirmou');
});

test('profissional inativo não recebe agendamento', async () => {
  const { agenda, repositorio, contato } = await montar();

  const inativo = await repositorio.criarProfissional({ nome: 'Ausente' });
  await repositorio.definirDisponibilidades(inativo.id, [
    { dia_semana: 4, hora_inicio: '08:00', hora_fim: '18:00' },
  ]);
  inativo.ativo = false;

  await assert.rejects(
    () => agenda.propor({
      profissionalId: inativo.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
    }),
    (erro) => erro.codigo === 'profissional_inativo',
  );
});

test('toda alteração na agenda deixa rastro, com quem fez', async () => {
  const { agenda, repositorio, profissional, contato } = await montar();

  const proposta = await agenda.propor({
    profissionalId: profissional.id, contatoId: contato.id, inicio: em('14:00'), fim: em('15:00'),
  });
  const agendamento = await agenda.confirmar(proposta.token, { usuarioId: 7 });

  await agenda.definirStatus(agendamento.id, 'confirmado', { usuarioId: 7 });
  await agenda.remarcar(agendamento.id, {
    inicio: em('16:00').toISOString(), fim: em('17:00').toISOString(), usuarioId: 7,
  });
  await agenda.definirStatus(agendamento.id, 'compareceu', { usuarioId: 7 });
  await agenda.cancelar(agendamento.id, { motivo: 'paciente desmarcou', usuarioId: 7 });

  const doAgendamento = repositorio._auditoria.filter(
    (registro) => registro.entidade === 'agendamento' && Number(registro.entidadeId) === agendamento.id,
  );

  // Cada uma dessas ações muda o que a clínica promete a um paciente. Sem
  // registro, "quem cancelou minha consulta?" não tem resposta.
  const acoes = doAgendamento.map((registro) => registro.acao);
  for (const esperada of [
    'agendamento_criado',
    'agendamento_confirmado',
    'agendamento_remarcado',
    'agendamento_compareceu',
    'agendamento_cancelado',
  ]) {
    assert.ok(acoes.includes(esperada), `faltou registrar ${esperada}`);
  }

  assert.ok(
    doAgendamento.every((registro) => registro.usuarioId === 7),
    'o registro precisa dizer quem fez, não só o que mudou',
  );

  // Cancelar sem dizer por quê deixa a recepção sem contexto no dia seguinte.
  const cancelamento = doAgendamento.find((registro) => registro.acao === 'agendamento_cancelado');
  assert.equal(cancelamento.detalhe.motivo, 'paciente desmarcou');
});
