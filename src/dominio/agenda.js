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

/** O horário cai dentro de alguma janela de atendimento do profissional? */
function dentroDaDisponibilidade(inicio, fim, disponibilidades = []) {
  if (disponibilidades.length === 0) return false;

  const dia = inicio.getDay();
  const minutosDe = inicio.getHours() * 60 + inicio.getMinutes();
  const minutosAte = fim.getHours() * 60 + fim.getMinutes();

  // Atravessar a meia-noite não é atendimento de clínica; é erro de data.
  if (inicio.toDateString() !== fim.toDateString()) return false;

  return disponibilidades.some((janela) => {
    if (janela.dia_semana !== dia) return false;
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
 * Monta os horários livres de um dia.
 *
 * Devolve encaixes de `duracaoMin` em `duracaoMin`, descontando bloqueios e
 * agendamentos. Serve para a automação oferecer horários que existem de verdade
 * em vez de perguntar "que dia você prefere?" e descobrir depois que não dá.
 */
function horariosLivres({
  dia, duracaoMin = 30, disponibilidades = [], bloqueios = [], agendamentos = [],
  agora = new Date(), passo = null,
}) {
  const data = paraData(dia, 'dia');
  const diaSemana = data.getDay();
  const intervalo = passo ?? duracaoMin;

  const janelas = disponibilidades.filter((janela) => janela.dia_semana === diaSemana);
  const livres = [];

  for (const janela of janelas) {
    const inicioJanela = new Date(data);
    inicioJanela.setHours(0, 0, 0, 0);
    inicioJanela.setMinutes(paraMinutos(janela.hora_inicio));

    const fimJanela = new Date(data);
    fimJanela.setHours(0, 0, 0, 0);
    fimJanela.setMinutes(paraMinutos(janela.hora_fim));

    for (let cursor = new Date(inicioJanela); cursor < fimJanela; cursor = new Date(cursor.getTime() + intervalo * 60_000)) {
      const fim = new Date(cursor.getTime() + duracaoMin * 60_000);
      if (fim > fimJanela) break;
      // Horário que já passou não é oferta, é constrangimento.
      if (cursor < agora) continue;
      if (bloqueado(cursor, fim, bloqueios)) continue;
      if (conflitante(cursor, fim, agendamentos)) continue;

      livres.push({ inicio: cursor.toISOString(), fim: fim.toISOString() });
    }
  }

  return livres.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
}

/**
 * Reconhece o erro de exclusão do PostgreSQL e o traduz.
 *
 * `23P01` é `exclusion_violation` — a constraint fez seu trabalho. Sem esta
 * tradução, a recepção veria um erro de banco em vez de "horário ocupado".
 */
function ehConflitoDoBanco(erro) {
  return erro?.code === '23P01' || erro?.constraint === 'agendamentos_sem_conflito';
}

function descreverDia(data) {
  return DIAS[paraData(data, 'data').getDay()];
}

module.exports = {
  STATUS,
  TIPOS,
  STATUS_QUE_OCUPAM,
  DIAS,
  seSobrepoe,
  validarPeriodo,
  dentroDaDisponibilidade,
  bloqueado,
  conflitante,
  horariosLivres,
  ehConflitoDoBanco,
  descreverDia,
  ErroDeConflito,
  ErroDeAgenda,
};
