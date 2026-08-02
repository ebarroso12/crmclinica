'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarServicoDeAgenda } = require('../src/dominio/agenda-servico');
const { criarAdaptadorDeLembretes, ErroDeEntrega } = require('../src/integracoes/openclaw-lembretes');

// A fila de ponta a ponta, contra o repositório em memória — que imita a
// constraint de unicidade e a reivindicação exclusiva do PostgreSQL.

const HORA = 60 * 60 * 1000;
const CONSULTA = new Date('2026-08-03T17:00:00.000Z'); // 14:00 em São Paulo

/** Relógio controlado: nenhum teste daqui depende do relógio da máquina. */
function relogio(inicial) {
  let instante = new Date(inicial);
  return {
    agora: () => new Date(instante),
    avancarPara: (valor) => { instante = new Date(valor); },
    avancar: (ms) => { instante = new Date(instante.getTime() + ms); },
  };
}

/** Entrega de teste: registra o que passaria pelo OpenClaw, sem rede. */
function entregaDeTeste({ modo = 'dry_run', falhar = null } = {}) {
  const enviados = [];
  return {
    modo,
    enviados,
    descrever: () => ({ orquestrador: 'OpenClaw', modo, significado: 'teste' }),
    async enviar(envelope) {
      if (falhar) throw falhar();
      enviados.push(envelope);
      return modo === 'real'
        ? { entregue: true, modo: 'real', referencia: `ref:${enviados.length}` }
        : { entregue: false, modo: 'dry_run', referencia: `dry-run:${envelope.referencia}` };
    },
  };
}

async function montarCenario({ tempo, entrega = entregaDeTeste(), duracaoMin = 30 } = {}) {
  const repositorio = criarRepositorioEmMemoria({ agora: tempo.agora });

  const lembretes = criarServicoDeLembretes({
    repositorio,
    entrega,
    clinica: 'Clínica Dr. Edson Barroso',
    agora: tempo.agora,
  });
  const agenda = criarServicoDeAgenda({ repositorio, agora: tempo.agora, lembretes });

  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena', duracaoMin });
  // Janela larga em todos os dias: o assunto aqui é a fila de lembretes, e a
  // disponibilidade da agenda tem suíte própria.
  await repositorio.definirDisponibilidades(
    profissional.id,
    [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia_semana: dia, hora_inicio: '00:00', hora_fim: '23:30' })),
  );
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999998888', nome: 'Marina Souza' });

  return { repositorio, lembretes, agenda, profissional, contato, entrega };
}

async function marcar({ agenda, profissional, contato }, inicio = CONSULTA) {
  return agenda.gravar({
    profissionalId: profissional.id,
    contatoId: contato.id,
    inicio: new Date(inicio).toISOString(),
    fim: new Date(new Date(inicio).getTime() + 30 * 60_000).toISOString(),
  });
}

// ---------------------------------------------------------------- enfileiramento

test('marcar consulta enfileira os lembretes de 24h e 2h', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  const fila = await cenario.lembretes.listar({});
  assert.equal(fila.length, 2);
  assert.deepEqual(fila.map((item) => item.tipo).sort(), ['confirmacao_24h', 'confirmacao_2h']);
  assert.ok(fila.every((item) => item.estado === 'pendente'));
});

test('enfileirar duas vezes o mesmo agendamento não cria lembrete repetido', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  const agendamento = await marcar(cenario);

  // A idempotência é por (agendamento, tipo, janela): a segunda passada
  // encontra o que já existe em vez de criar.
  const segunda = await cenario.lembretes.enfileirarPara(agendamento);
  const terceira = await cenario.lembretes.enfileirarPara(agendamento);

  assert.equal(segunda.criados.length, 0);
  assert.equal(segunda.repetidos.length, 2);
  assert.equal(terceira.repetidos.length, 2);
  assert.equal((await cenario.lembretes.listar({})).length, 2);
});

test('a auditoria registra a criação de cada lembrete', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  const criados = cenario.repositorio._auditoria.filter((item) => item.acao === 'lembrete_criado');
  assert.equal(criados.length, 2);
  assert.ok(criados.every((item) => item.entidade === 'lembrete'));
});

test('consulta marcada em cima da hora registra o lembrete de 24h como ignorado', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 3 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  const fila = await cenario.lembretes.listar({});
  const vinteQuatro = fila.find((item) => item.tipo === 'confirmacao_24h');

  assert.equal(vinteQuatro.estado, 'ignorado');
  assert.equal(vinteQuatro.ignorado_motivo, 'janela_no_passado');
  // E o motivo fica registrado, não só o estado.
  assert.ok(cenario.repositorio._auditoria.some((item) => item.acao === 'lembrete_ignorado'));
});

// ---------------------------------------------------------------- processamento

test('na hora certa o lembrete sai e a fila registra o modo da entrega', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  // Antes da hora, nada é reivindicado.
  const cedo = await cenario.lembretes.processarLote({});
  assert.equal(cedo.reivindicados, 0);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  const lote = await cenario.lembretes.processarLote({});

  assert.equal(lote.reivindicados, 1);
  assert.equal(lote.enviados, 1);
  assert.equal(cenario.entrega.enviados.length, 1);
  assert.match(cenario.entrega.enviados[0].texto, /amanhã/);

  const [enviado] = await cenario.lembretes.listar({ estado: 'enviado' });
  assert.equal(enviado.tipo, 'confirmacao_24h');
  assert.equal(enviado.modo_entrega, 'dry_run');
});

test('em dry-run a auditoria diz "simulado", nunca "enviado"', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  await cenario.lembretes.processarLote({});

  const acoes = cenario.repositorio._auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('lembrete_simulado'));
  assert.ok(!acoes.includes('lembrete_enviado'), 'dry-run não pode registrar envio real');
});

test('em modo real a auditoria registra o envio', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo, entrega: entregaDeTeste({ modo: 'real' }) });
  await marcar(cenario);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  await cenario.lembretes.processarLote({});

  const acoes = cenario.repositorio._auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('lembrete_enviado'));
  const [enviado] = await cenario.lembretes.listar({ estado: 'enviado' });
  assert.equal(enviado.modo_entrega, 'real');
});

test('processar duas vezes não manda o mesmo lembrete duas vezes', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  await cenario.lembretes.processarLote({});
  await cenario.lembretes.processarLote({});
  await cenario.lembretes.processarLote({});

  assert.equal(cenario.entrega.enviados.length, 1);
});

test('os dois lembretes saem, cada um na sua hora', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 48 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  await cenario.lembretes.processarLote({});
  assert.equal(cenario.entrega.enviados.length, 1);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 2 * HORA));
  await cenario.lembretes.processarLote({});
  assert.equal(cenario.entrega.enviados.length, 2);
  assert.match(cenario.entrega.enviados[1].texto, /hoje/);
});

// ---------------------------------------------------------------- cancelamento

test('cancelar o agendamento tira os lembretes da fila', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  const agendamento = await marcar(cenario);

  await cenario.agenda.cancelar(agendamento.id, { motivo: 'paciente desmarcou' });

  const fila = await cenario.lembretes.listar({});
  assert.ok(fila.every((item) => item.estado === 'ignorado'));
  assert.ok(fila.every((item) => item.ignorado_motivo === 'agendamento_cancelado'));

  // E nada sai depois disso.
  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  const lote = await cenario.lembretes.processarLote({});
  assert.equal(lote.reivindicados, 0);
  assert.equal(cenario.entrega.enviados.length, 0);
});

for (const status of ['compareceu', 'faltou']) {
  test(`marcar como ${status} encerra a fila daquele agendamento`, async () => {
    const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
    const cenario = await montarCenario({ tempo });
    const agendamento = await marcar(cenario);

    await cenario.agenda.definirStatus(agendamento.id, status);

    const fila = await cenario.lembretes.listar({});
    assert.ok(fila.every((item) => item.estado === 'ignorado'), `${status} deveria encerrar a fila`);
  });
}

test('cancelado depois de enfileirado não vaza pelo processamento', async () => {
  // O caminho perigoso: o lembrete já foi reivindicado quando o cancelamento
  // chega. A decisão de envio relê o agendamento e barra assim mesmo.
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  const agendamento = await marcar(cenario);

  await cenario.repositorio.atualizarAgendamento(agendamento.id, { status: 'cancelado' });

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  const lote = await cenario.lembretes.processarLote({});

  assert.equal(lote.reivindicados, 1);
  assert.equal(lote.enviados, 0);
  assert.equal(lote.ignorados, 1);
  assert.equal(cenario.entrega.enviados.length, 0);
  assert.equal(lote.resultados[0].motivo, 'agendamento_cancelado');
});

// ---------------------------------------------------------------- remarcação

test('remarcar troca os lembretes: a janela nova entra, a antiga sai', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  const agendamento = await marcar(cenario);

  const novoInicio = new Date(CONSULTA.getTime() + 26 * HORA);
  await cenario.agenda.remarcar(agendamento.id, {
    inicio: novoInicio.toISOString(),
    fim: new Date(novoInicio.getTime() + 30 * 60_000).toISOString(),
  });

  const fila = await cenario.lembretes.listar({});
  const pendentes = fila.filter((item) => item.estado === 'pendente');
  const descartados = fila.filter((item) => item.ignorado_motivo === 'remarcado');

  assert.equal(pendentes.length, 2);
  assert.ok(pendentes.every((item) => item.janela === novoInicio.toISOString()));
  assert.equal(descartados.length, 2);
  assert.ok(descartados.every((item) => item.janela === CONSULTA.toISOString()));
});

test('remarcado: o lembrete velho reivindicado não é enviado', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  const agendamento = await marcar(cenario);

  // Mudança direta no repositório, sem passar pela agenda: simula a corrida em
  // que o horário mudou por outro caminho antes de o worker rodar.
  const novoInicio = new Date(CONSULTA.getTime() + 3 * HORA);
  await cenario.repositorio.atualizarAgendamento(agendamento.id, {
    inicio: novoInicio.toISOString(),
    fim: new Date(novoInicio.getTime() + 30 * 60_000).toISOString(),
  });

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  const lote = await cenario.lembretes.processarLote({});

  assert.equal(lote.enviados, 0);
  assert.equal(lote.resultados[0].motivo, 'remarcado');
});

// ---------------------------------------------------------------- opt-out

test('opt-out do contato tira da fila e barra os próximos', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  const { cancelados } = await cenario.lembretes.definirOptOut(cenario.contato.id, {
    optout: true, motivo: 'pediu no telefone',
  });

  assert.equal(cancelados.length, 2);
  const fila = await cenario.lembretes.listar({});
  assert.ok(fila.every((item) => item.ignorado_motivo === 'optout'));

  const acoes = cenario.repositorio._auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('lembretes_optout'));
  assert.ok(acoes.includes('lembrete_cancelado'));
});

test('opt-out barra o envio mesmo de lembrete já reivindicado', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  // Marca o opt-out direto no contato, sem cancelar a fila: é a corrida em que
  // o pedido chega entre a reivindicação e o envio.
  await cenario.repositorio.definirOptOutDeLembretes(cenario.contato.id, { optout: true });

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  const lote = await cenario.lembretes.processarLote({});

  assert.equal(lote.enviados, 0);
  assert.equal(lote.resultados[0].motivo, 'optout');
  assert.equal(cenario.entrega.enviados.length, 0);
});

test('opt-in devolve o contato à régua, mas não ressuscita o que foi cancelado', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  await cenario.lembretes.definirOptOut(cenario.contato.id, { optout: true });
  const { contato } = await cenario.lembretes.definirOptOut(cenario.contato.id, { optout: false });

  assert.equal(contato.lembretes_optout, false);
  assert.equal(contato.lembretes_optout_em, null);
  // Voltar a receber vale para o que vier; o que saiu da fila fica fora dela.
  const fila = await cenario.lembretes.listar({});
  assert.ok(fila.every((item) => item.estado === 'ignorado'));
});

// ---------------------------------------------------------------- retry

test('falha de entrega marca retry com backoff e tenta de novo depois', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  let falhas = 0;
  const entrega = entregaDeTeste();
  // Falha nas duas primeiras chamadas; na terceira, deixa passar.
  entrega.enviar = async function enviar(envelope) {
    if (falhas < 2) {
      falhas += 1;
      throw new ErroDeEntrega('orquestrador fora do ar', 'openclaw_indisponivel');
    }
    entrega.enviados.push(envelope);
    return { entregue: false, modo: 'dry_run', referencia: 'dry-run' };
  };

  const cenario = await montarCenario({ tempo, entrega });
  await marcar(cenario);

  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));

  const primeira = await cenario.lembretes.processarLote({});
  assert.equal(primeira.falhados, 0);
  assert.equal(primeira.reagendados, 1);

  // Filtrado por tipo: o lembrete de 2h também está pendente, esperando a hora dele.
  const [emEspera] = await cenario.lembretes.listar({ estado: 'pendente', tipo: 'confirmacao_24h' });
  assert.equal(emEspera.tentativas, 1);
  assert.match(emEspera.ultimo_erro, /openclaw_indisponivel/);

  // Antes do backoff vencer, a linha não é servida de novo.
  const cedo = await cenario.lembretes.processarLote({});
  assert.equal(cedo.reivindicados, 0);

  // Passado o primeiro minuto, tenta e falha de novo.
  tempo.avancar(2 * 60_000);
  const segunda = await cenario.lembretes.processarLote({});
  assert.equal(segunda.reagendados, 1);

  // E na terceira vez dá certo.
  tempo.avancar(5 * 60_000);
  const terceira = await cenario.lembretes.processarLote({});
  assert.equal(terceira.enviados, 1);
  assert.equal(entrega.enviados.length, 1);
});

test('esgotadas as tentativas o lembrete vai para falhou e para de tentar', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const entrega = entregaDeTeste();
  entrega.enviar = async () => { throw new ErroDeEntrega('sempre falha', 'openclaw_indisponivel'); };

  const cenario = await montarCenario({ tempo, entrega });
  await marcar(cenario);
  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));

  // Cinco tentativas, cada uma depois do backoff da anterior. Meia hora entre
  // elas: mais que o maior backoff em jogo (16 min) e bem dentro das 6 horas de
  // tolerância do lembrete de 24h — passar disso o tornaria "atrasado_demais",
  // e o teste mediria outra coisa.
  for (let volta = 0; volta < 5; volta += 1) {
    await cenario.lembretes.processarLote({});
    tempo.avancar(30 * 60_000);
  }

  const [falhado] = await cenario.lembretes.listar({ estado: 'falhou' });
  assert.ok(falhado, 'o lembrete deveria ter terminado em falhou');
  assert.equal(falhado.tentativas, 5);

  const acoes = cenario.repositorio._auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('lembrete_retry'));
  assert.ok(acoes.includes('lembrete_falhou'));
});

test('erro permanente não gasta cinco tentativas — falha na primeira', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const entrega = entregaDeTeste();
  entrega.enviar = async () => {
    throw new ErroDeEntrega('envelope inválido', 'envelope_invalido', { permanente: true });
  };

  const cenario = await montarCenario({ tempo, entrega });
  await marcar(cenario);
  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));

  const lote = await cenario.lembretes.processarLote({});
  assert.equal(lote.falhados, 1);

  const [falhado] = await cenario.lembretes.listar({ estado: 'falhou' });
  assert.equal(falhado.tentativas, 1);
});

test('reenfileirar devolve um lembrete falhado à fila', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const entrega = entregaDeTeste();
  entrega.enviar = async () => {
    throw new ErroDeEntrega('envelope inválido', 'envelope_invalido', { permanente: true });
  };

  const cenario = await montarCenario({ tempo, entrega });
  await marcar(cenario);
  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));
  await cenario.lembretes.processarLote({});

  const [falhado] = await cenario.lembretes.listar({ estado: 'falhou' });

  // Conserto feito, entrega volta a funcionar.
  entrega.enviar = async (envelope) => {
    entrega.enviados.push(envelope);
    return { entregue: false, modo: 'dry_run', referencia: 'dry-run' };
  };

  const voltou = await cenario.lembretes.reenfileirar(falhado.id, {});
  assert.equal(voltou.estado, 'pendente');
  assert.equal(voltou.tentativas, 0);

  const lote = await cenario.lembretes.processarLote({});
  assert.equal(lote.enviados, 1);
});

test('reenfileirar recusa lembrete que não está em falhou nem ignorado', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);

  const [pendente] = await cenario.lembretes.listar({ estado: 'pendente' });
  await assert.rejects(
    () => cenario.lembretes.reenfileirar(pendente.id, {}),
    (erro) => erro.codigo === 'estado_invalido',
  );
});

// ---------------------------------------------------------------- worker morto

test('lembrete preso em processando volta à fila depois do lease', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 25 * HORA));
  const cenario = await montarCenario({ tempo });
  await marcar(cenario);
  tempo.avancarPara(new Date(CONSULTA.getTime() - 24 * HORA));

  // Reivindica sem processar: é o que um worker que morre no meio deixa.
  const [reivindicado] = await cenario.repositorio.reivindicarLembretes({
    agora: tempo.agora().toISOString(), limite: 1, worker: 'worker-morto',
  });
  assert.equal(reivindicado.estado, 'processando');

  // Antes do lease vencer, ninguém encosta na linha.
  tempo.avancar(60_000);
  assert.equal((await cenario.lembretes.recuperarPresos()).length, 0);

  tempo.avancar(6 * 60_000);
  const recuperados = await cenario.lembretes.recuperarPresos();
  assert.equal(recuperados.length, 1);
  assert.equal(recuperados[0].estado, 'pendente');
  assert.equal(recuperados[0].tentativas, 1);

  // E agora ele é processado normalmente.
  const lote = await cenario.lembretes.processarLote({});
  assert.equal(lote.enviados, 1);
});

// ---------------------------------------------------------------- sincronização

test('sincronizar a agenda enfileira o que ficou para trás, sem duplicar', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  // Agenda montada sem a fila: é o estado de quem já tinha consultas marcadas
  // antes de os lembretes existirem.
  const repositorio = criarRepositorioEmMemoria({ agora: tempo.agora });
  const entrega = entregaDeTeste();
  const lembretes = criarServicoDeLembretes({ repositorio, entrega, agora: tempo.agora });
  const agenda = criarServicoDeAgenda({ repositorio, agora: tempo.agora });

  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999997777', nome: 'Pedro' });
  await agenda.gravar({
    profissionalId: profissional.id,
    contatoId: contato.id,
    inicio: CONSULTA.toISOString(),
    fim: new Date(CONSULTA.getTime() + 30 * 60_000).toISOString(),
  });

  assert.equal((await lembretes.listar({})).length, 0);

  const primeira = await lembretes.sincronizarAgenda({});
  assert.equal(primeira.criados, 2);

  const segunda = await lembretes.sincronizarAgenda({});
  assert.equal(segunda.criados, 0);
  assert.equal(segunda.repetidos, 2);
  assert.equal((await lembretes.listar({})).length, 2);
});

// ---------------------------------------------------------------- resumo

test('o resumo diz em que modo a entrega está e o que isso significa', async () => {
  const tempo = relogio(new Date(CONSULTA.getTime() - 72 * HORA));
  const cenario = await montarCenario({
    tempo,
    // Adaptador de verdade, para o resumo refletir o estado real do protocolo.
    entrega: criarAdaptadorDeLembretes({ modoEntrega: 'dry_run' }, { registrar: () => {} }),
  });
  await marcar(cenario);

  const resumo = await cenario.lembretes.resumo();
  assert.equal(resumo.entrega.modo, 'dry_run');
  assert.equal(resumo.entrega.protocolo_confirmado, false);
  assert.match(resumo.observacao, /dry-run/);
  assert.equal(resumo.fila.por_estado.pendente, 2);
});
