'use strict';

// Regras da agenda.
//
// Este arquivo calcula horários livres e valida pedidos. O que ele **não** faz é
// garantir a ausência de conflito: isso é responsabilidade da constraint no banco.
// Checar aqui e inserir depois deixa uma janela entre a leitura e a escrita, e
// duas marcações simultâneas passam pelas duas checagens antes de qualquer uma
// gravar. Aqui a checagem serve para dar uma resposta melhor que "erro"; a
// garantia vem do PostgreSQL.

const STATUS = Object.freeze(['agendado', 'confirmado', 'compareceu', 'faltou', 'cancelado']);
const TIPOS = Object.freeze(['consulta', 'retorno', 'avaliacao', 'procedimento', 'bloqueio']);

// Status que ocupam o horário. Cancelado libera; faltou não, porque a vaga já
// foi perdida e remarcar em cima confundiria o histórico.
const STATUS_QUE_OCUPAM = Object.freeze(['agendado', 'confirmado', 'compareceu', 'faltou']);

const DIAS = Object.freeze(['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']);
const FUSO_DA_CLINICA = 'America/Sao_Paulo';

/** Erro de conflito, com o horário que atrapalhou — a mensagem precisa ser útil. */
class ErroDeConflito extends Error {
  constructor(detalhe = null) {
    super('já existe um agendamento nesse horário para este profissional');
    this.name = 'ErroDeConflito';
    this.status = 409;
    this.codigo = 'conflito_de_agenda';
    this.conflito = detalhe;
  }
}

class ErroDeAgenda extends Error {
  constructor(mensagem, codigo = 'agenda_invalida') {
    super(mensagem);
    this.name = 'ErroDeAgenda';
    this.status = 400;
    this.codigo = codigo;
  }
}

function paraData(valor, campo) {
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) throw new ErroDeAgenda(`"${campo}" não é uma data válida`, 'data_invalida');
  return data;
}

/** Dois intervalos se sobrepõem? Fim aberto: 14–15 e 15–16 são vizinhos. */
function seSobrepoe(inicioA, fimA, inicioB, fimB) {
  return inicioA < fimB && inicioB < fimA;
}

/**
 * Valida o pedido antes de qualquer escrita.
 * Recusa passado, duração absurda e ordem invertida — erros que não valem a
 * viagem até o banco.
 */
function validarPeriodo(inicio, fim, { agora = new Date(), duracaoMaximaMin = 480 } = {}) {
  const de = paraData(inicio, 'inicio');
  const ate = paraData(fim, 'fim');

  if (ate <= de) throw new ErroDeAgenda('o fim precisa ser depois do início', 'periodo_invertido');

  const minutos = (ate - de) / 60_000;
  if (minutos < 5) throw new ErroDeAgenda('o agendamento precisa ter ao menos 5 minutos', 'duracao_curta');
  if (minutos > duracaoMaximaMin) {
    throw new ErroDeAgenda(`o agendamento não pode passar de ${duracaoMaximaMin} minutos`, 'duracao_longa');
  }
  // Marcar no passado quase sempre é erro de digitação de data.
  if (de < agora) throw new ErroDeAgenda('não é possível agendar no passado', 'no_passado');

  return { inicio: de, fim: ate, minutos };
}

/**
 * Componentes civis de um instante no fuso da clínica.
 *
 * Em produção a Vercel executa em UTC. `getHours()` e `getDay()` sobre uma data
 * ISO devolvem o horário do processo, não o horário em que a clínica atende.
 * Um horário local de 08:30 chega como 11:30Z e era comparado com a grade como
 * se a consulta fosse às 11:30. A oferta estava correta, mas a confirmação era
 * recusada como "fora da disponibilidade".
 */
function partesNoFuso(data, fuso = FUSO_DA_CLINICA) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(data);
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: Number(valor('year')),
    mes: Number(valor('month')),
    dia: Number(valor('day')),
    hora: Number(valor('hour')),
    minuto: Number(valor('minute')),
    diaSemana: dias[valor('weekday')],
  };
}

/** O horário cai dentro de alguma janela de atendimento do profissional? */
function dentroDaDisponibilidade(inicio, fim, disponibilidades = [], { fuso = FUSO_DA_CLINICA } = {}) {
  if (disponibilidades.length === 0) return false;

  const de = partesNoFuso(inicio, fuso);
  const ate = partesNoFuso(fim, fuso);
  const minutosDe = de.hora * 60 + de.minuto;
  const minutosAte = ate.hora * 60 + ate.minuto;

  // Atravessar a meia-noite local não é atendimento de clínica; é erro de data.
  if (de.ano !== ate.ano || de.mes !== ate.mes || de.dia !== ate.dia) return false;

  return disponibilidades.some((janela) => {
    if (Number(janela.dia_semana) !== de.diaSemana) return false;
    const janelaDe = paraMinutos(janela.hora_inicio);
    const janelaAte = paraMinutos(janela.hora_fim);
    return minutosDe >= janelaDe && minutosAte <= janelaAte;
  });
}

function paraMinutos(hora) {
  const [h, m] = String(hora).split(':').map(Number);
  return (h * 60) + (m || 0);
}

/** O horário bate em algum bloqueio (férias, feriado, almoço)? */
function bloqueado(inicio, fim, bloqueios = []) {
  return bloqueios.find((bloqueio) => seSobrepoe(
    inicio, fim, new Date(bloqueio.inicio), new Date(bloqueio.fim),
  )) ?? null;
}

/** Conflita com algum agendamento que ocupa o horário? */
function conflitante(inicio, fim, agendamentos = [], { ignorarId = null } = {}) {
  return agendamentos.find((agendamento) => {
    if (ignorarId && Number(agendamento.id) === Number(ignorarId)) return false;
    if (!STATUS_QUE_OCUPAM.includes(agendamento.status)) return false;
    return seSobrepoe(inicio, fim, new Date(agendamento.inicio), new Date(agendamento.fim));
  }) ?? null;
}

/**
 * O instante em que, no fuso da clínica, é tal minuto do dia.
 *
 * `setHours` opera no fuso do processo — que em produção é UTC. Aqui o cálculo
 * é feito ao contrário: descobre-se o deslocamento real daquele dia e aplica-se
 * sobre o minuto pedido.
 */
function comHoraLocal(dia, minutosNoDia, fuso = FUSO_DA_CLINICA) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(dia));

  const meioDia = new Date(`${partes}T12:00:00Z`);
  const deslocamentoMs = new Date(meioDia.toLocaleString('en-US', { timeZone: fuso }))
    - new Date(meioDia.toLocaleString('en-US', { timeZone: 'UTC' }));

  return new Date(
    new Date(`${partes}T00:00:00Z`).getTime() + (minutosNoDia * 60_000) - deslocamentoMs,
  );
}

/**
 * Monta os horários livres de um dia.
 *
 * Devolve encaixes de `duracaoMin` em `duracaoMin`, descontando bloqueios e
 * agendamentos. Serve para a automação oferecer horários que existem de verdade.
 */
function horariosLivres({
  dia, duracaoMin = 30, disponibilidades = [], bloqueios = [], agendamentos = [],
  agora = new Date(), passo = null, fuso = FUSO_DA_CLINICA,
}) {
  const data = paraData(dia, 'dia');
  const diaSemana = partesNoFuso(data, fuso).diaSemana;
  const intervalo = passo ?? duracaoMin;

  const janelas = disponibilidades.filter((janela) => Number(janela.dia_semana) === diaSemana);
  const livres = [];

  for (const janela of janelas) {
    const inicioJanela = comHoraLocal(data, paraMinutos(janela.hora_inicio), fuso);
    const fimJanela = comHoraLocal(data, paraMinutos(janela.hora_fim), fuso);

    for (let cursor = new Date(inicioJanela); cursor < fimJanela; cursor = new Date(cursor.getTime() + intervalo * 60_000)) {
      const fim = new Date(cursor.getTime() + duracaoMin * 60_000);
      if (fim > fimJanela) break;
      if (cursor < agora) continue;
      if (bloqueado(cursor, fim, bloqueios)) continue;
      if (conflitante(cursor, fim, agendamentos)) continue;

      livres.push({ inicio: cursor.toISOString(), fim: fim.toISOString() });
    }
  }

  return livres.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
}

/** Reconhece o erro de exclusão do PostgreSQL e o traduz. */
function ehConflitoDoBanco(erro) {
  return erro?.code === '23P01' || erro?.constraint === 'agendamentos_sem_conflito';
}

function descreverDia(data, fuso = FUSO_DA_CLINICA) {
  return DIAS[partesNoFuso(paraData(data, 'data'), fuso).diaSemana];
}

module.exports = {
  STATUS,
  TIPOS,
  STATUS_QUE_OCUPAM,
  DIAS,
  FUSO_DA_CLINICA,
  seSobrepoe,
  validarPeriodo,
  dentroDaDisponibilidade,
  bloqueado,
  conflitante,
  horariosLivres,
  ehConflitoDoBanco,
  descreverDia,
  partesNoFuso,
  ErroDeConflito,
  ErroDeAgenda,
};
