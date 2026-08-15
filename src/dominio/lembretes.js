'use strict';

// Regras dos lembretes de agendamento.
//
// Este arquivo é puro: recebe dados, devolve decisão. Não fala com banco, não
// fala com rede, não sabe que existe fila. É aqui que ficam as respostas para
// as perguntas que decidem tudo:
//
//   • quando este lembrete deve sair?
//   • ele ainda deve sair, ou o mundo mudou desde que foi enfileirado?
//   • depois de falhar, quando vale tentar de novo?
//   • o que exatamente a mensagem diz — e o que ela nunca diz?
//
// A última é a mais importante. O lembrete atravessa para fora do CRM: vai para
// o orquestrador e de lá para o WhatsApp do paciente. Nada clínico passa por
// aqui — nem tipo de procedimento, nem observação, nem motivo da consulta.
// Só o que a pessoa precisa para saber que tem horário e a que horas.

const FUSO = 'America/Sao_Paulo';

const TIPOS = Object.freeze(['confirmacao_24h', 'confirmacao_2h']);

// Migration 039/Gate 4: 'incerto' — o gateway não respondeu a tempo, a
// mensagem pode ter saído, ninguém sabe. Nunca retentado automaticamente
// (ver processarUm, lembretes-servico.js); mesmo conceito de 'incerto' em
// automacao-outbox.js.
const ESTADOS = Object.freeze(['pendente', 'processando', 'enviado', 'ignorado', 'falhou', 'incerto']);

/**
 * Antecedência de cada tipo e por quanto tempo o lembrete ainda vale depois da
 * hora prevista.
 *
 * A tolerância existe porque o worker pode ter ficado fora do ar. Voltando,
 * ele encontra lembretes atrasados — e mandar "seu horário é amanhã" quatro
 * horas depois ainda ajuda; mandar isso quando faltam vinte minutos, não.
 */
const REGRA_POR_TIPO = Object.freeze({
  confirmacao_24h: { antecedenciaMin: 24 * 60, toleranciaMin: 6 * 60 },
  confirmacao_2h: { antecedenciaMin: 2 * 60, toleranciaMin: 60 },
});

// Status do agendamento que encerram o assunto: nada mais é enviado sobre ele.
const STATUS_SEM_LEMBRETE = Object.freeze(['cancelado', 'compareceu', 'faltou']);

const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_TETO_MS = 60 * 60 * 1000;
const MAX_TENTATIVAS_PADRAO = 5;

// Tempo que uma linha pode ficar em 'processando' antes de ser considerada
// abandonada. Maior que qualquer envio plausível, menor que a janela do
// lembrete de 2h — do contrário a recuperação chegaria tarde demais.
const LEASE_MS = 5 * 60 * 1000;

/** Palavras que, sozinhas numa mensagem, valem como pedido de opt-out. */
const PALAVRAS_DE_OPTOUT = Object.freeze([
  'parar', 'pare', 'sair', 'cancelar lembretes', 'nao quero lembretes',
  'não quero lembretes', 'descadastrar', 'remover', 'stop', 'sem lembretes',
]);

class ErroDeLembrete extends Error {
  constructor(mensagem, codigo = 'lembrete_invalido', status = 400) {
    super(mensagem);
    this.name = 'ErroDeLembrete';
    this.codigo = codigo;
    this.status = status;
  }
}

function paraData(valor, campo = 'data') {
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) throw new ErroDeLembrete(`"${campo}" não é uma data válida`, 'data_invalida');
  return data;
}

/** Quando este tipo de lembrete deve sair, dado o início do agendamento. */
function instanteDeEnvio(inicioDoAgendamento, tipo) {
  const regra = REGRA_POR_TIPO[tipo];
  if (!regra) throw new ErroDeLembrete(`tipo de lembrete desconhecido: ${tipo}`, 'tipo_invalido');

  const inicio = paraData(inicioDoAgendamento, 'inicio');
  return new Date(inicio.getTime() - regra.antecedenciaMin * 60_000);
}

/**
 * Monta os lembretes de um agendamento.
 *
 * Um lembrete cuja hora de envio já passou **não é descartado em silêncio**:
 * ele nasce marcado para ser ignorado, com o motivo registrado. Marcar consulta
 * para daqui a três horas é normal, e a clínica precisa poder ver que o
 * lembrete de 24h não saiu porque não havia 24h — não porque algo quebrou.
 */
function planejarLembretes(agendamento, { agora = new Date() } = {}) {
  const inicio = paraData(agendamento?.inicio, 'inicio');
  const momento = paraData(agora, 'agora');

  return TIPOS.map((tipo) => {
    const enviarEm = instanteDeEnvio(inicio, tipo);
    const regra = REGRA_POR_TIPO[tipo];
    const limite = new Date(enviarEm.getTime() + regra.toleranciaMin * 60_000);

    // Passou da tolerância, ou o próprio agendamento já começou: não há lembrete
    // a dar. Entra na fila como 'ignorado' para deixar rastro do porquê.
    const tardeDemais = momento > limite || momento >= inicio;

    return {
      tipo,
      janela: inicio.toISOString(),
      agendarPara: enviarEm.toISOString(),
      estado: tardeDemais ? 'ignorado' : 'pendente',
      ignoradoMotivo: tardeDemais ? 'janela_no_passado' : null,
    };
  });
}

/**
 * Decide, no momento de enviar, se o lembrete ainda deve sair.
 *
 * Esta função é o coração da regra "não enviar lembrete de agendamento
 * cancelado, realizado ou faltoso". Ela roda **depois** de a linha ser
 * reivindicada, com os dados relidos do banco — porque entre o enfileiramento e
 * o envio pode ter passado um dia inteiro, e nesse dia o paciente pode ter
 * cancelado, pedido para não receber mais nada, ou remarcado.
 *
 * @returns {{ enviar: boolean, motivo: string | null }}
 */
function decidirEnvio({ lembrete, agendamento, contato, agora = new Date() }) {
  const momento = paraData(agora, 'agora');

  if (!agendamento) return { enviar: false, motivo: 'agendamento_ausente' };
  if (STATUS_SEM_LEMBRETE.includes(agendamento.status)) {
    return { enviar: false, motivo: `agendamento_${agendamento.status}` };
  }

  // Remarcado: o horário deste lembrete não é mais o horário da consulta. O
  // lembrete certo já foi enfileirado com a janela nova.
  const janelaDoLembrete = paraData(lembrete.janela, 'janela').getTime();
  const inicioAtual = paraData(agendamento.inicio, 'inicio').getTime();
  if (janelaDoLembrete !== inicioAtual) return { enviar: false, motivo: 'remarcado' };

  if (!contato) return { enviar: false, motivo: 'contato_ausente' };
  if (contato.lembretes_optout) return { enviar: false, motivo: 'optout' };
  if (!contato.telefone) return { enviar: false, motivo: 'sem_telefone' };

  if (momento.getTime() >= inicioAtual) return { enviar: false, motivo: 'agendamento_ja_comecou' };

  const regra = REGRA_POR_TIPO[lembrete.tipo];
  if (!regra) return { enviar: false, motivo: 'tipo_invalido' };

  const previsto = paraData(lembrete.agendar_para ?? lembrete.agendarPara, 'agendar_para');
  if (momento < previsto) return { enviar: false, motivo: 'ainda_nao_e_hora' };
  if (momento.getTime() > previsto.getTime() + regra.toleranciaMin * 60_000) {
    return { enviar: false, motivo: 'atrasado_demais' };
  }

  return { enviar: true, motivo: null };
}

/**
 * Quando tentar de novo depois de uma falha.
 *
 * Backoff exponencial com teto: 1min, 2, 4, 8, 16… até 1h. Uma falha costuma
 * ser rede ou o orquestrador fora do ar, e insistir de segundo em segundo só
 * transforma um problema em dois.
 */
function proximaTentativa(tentativas, { agora = new Date(), baseMs = BACKOFF_BASE_MS, tetoMs = BACKOFF_TETO_MS } = {}) {
  const expoente = Math.max(0, Number(tentativas) - 1);
  const atraso = Math.min(baseMs * 2 ** expoente, tetoMs);
  return new Date(paraData(agora, 'agora').getTime() + atraso);
}

/** Esgotou as tentativas? Então o estado final é 'falhou', não 'pendente'. */
function esgotou(tentativas, maxTentativas = MAX_TENTATIVAS_PADRAO) {
  return Number(tentativas) >= Number(maxTentativas);
}

/** Uma linha em 'processando' há tempo demais foi abandonada por um worker morto. */
function abandonado(lembrete, { agora = new Date(), leaseMs = LEASE_MS } = {}) {
  if (lembrete.estado !== 'processando' || !lembrete.processando_desde) return false;
  return paraData(agora, 'agora').getTime() - paraData(lembrete.processando_desde).getTime() > leaseMs;
}

// ---------------------------------------------------------------- texto

function primeiroNome(nome) {
  const bruto = String(nome ?? '').trim();
  if (!bruto) return null;
  return bruto.split(/\s+/)[0];
}

/** Data e hora sempre em America/Sao_Paulo, nunca no fuso do servidor. */
function formatarData(valor, opcoes) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, ...opcoes }).format(paraData(valor));
}

function horaLocal(valor) {
  return formatarData(valor, { hour: '2-digit', minute: '2-digit' });
}

function diaLocal(valor) {
  return formatarData(valor, { day: '2-digit', month: '2-digit' });
}

/** O dia do lembrete é hoje, amanhã ou uma data — do ponto de vista de Sao_Paulo. */
function referenciaDoDia(inicio, agora) {
  const chave = (valor) => formatarData(valor, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const doAgendamento = chave(inicio);

  if (doAgendamento === chave(agora)) return 'hoje';

  const amanha = new Date(paraData(agora).getTime() + 24 * 60 * 60 * 1000);
  if (doAgendamento === chave(amanha)) return 'amanhã';

  return `dia ${diaLocal(inicio)}`;
}

/**
 * O texto que o paciente lê.
 *
 * Deliberadamente magro. Não diz o que a pessoa vai fazer na clínica, com quem,
 * nem por quê: diz que há um horário, quando é, e como parar de receber isto.
 * Qualquer campo a mais aqui é dado clínico atravessando para o WhatsApp.
 */
function montarTexto({ tipo, contato, inicio, clinica, agora = new Date() }) {
  const nome = primeiroNome(contato?.nome);
  const saudacao = nome ? `Olá, ${nome}!` : 'Olá!';
  const quando = referenciaDoDia(inicio, agora);
  const hora = horaLocal(inicio);
  const onde = clinica ? ` na ${clinica}` : '';

  if (tipo === 'confirmacao_24h') {
    return `${saudacao} Você tem horário${onde} ${quando}, às ${hora}. `
      + 'Responda SIM para confirmar ou, se precisar remarcar, é só avisar por aqui. '
      + 'Para não receber mais lembretes, responda PARAR.';
  }

  return `${saudacao} Passando para lembrar do seu horário${onde} ${quando}, às ${hora}. `
    + 'Até logo! Para não receber mais lembretes, responda PARAR.';
}

/**
 * O envelope mínimo entregue ao orquestrador.
 *
 * O que **não** está aqui é a parte que importa: sem identificador de lead, sem
 * tipo de agendamento, sem observações, sem histórico da conversa, sem prompt.
 * O OpenClaw recebe um destinatário, um texto pronto e uma referência opaca
 * para correlacionar — nada que o obrigue a saber o que a clínica trata.
 */
function montarEnvelope({ lembrete, agendamento, contato, clinica, agora = new Date() }) {
  return {
    referencia: `lembrete:${lembrete.id}`,
    tipo: lembrete.tipo,
    canal: 'whatsapp',
    destinatario: contato.telefone,
    texto: montarTexto({
      tipo: lembrete.tipo,
      contato,
      inicio: agendamento.inicio,
      clinica,
      agora,
    }),
  };
}

/** Telefone em log e em resposta de API sai mascarado. */
function mascararTelefone(telefone) {
  const digitos = String(telefone ?? '').replace(/\D/g, '');
  if (digitos.length < 4) return '***';
  return `***${digitos.slice(-4)}`;
}

/**
 * A mensagem recebida é um pedido para parar de receber lembretes?
 *
 * Casa só com mensagem curta e direta. "Não quero parar de fazer o tratamento"
 * contém "parar" e não é opt-out — por isso a comparação é sobre a frase
 * inteira normalizada, não sobre conter a palavra.
 */
function ehPedidoDeOptOut(texto) {
  const bruto = String(texto ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,;]+$/g, '')
    .replace(/\s+/g, ' ');

  if (!bruto || bruto.length > 30) return false;
  return PALAVRAS_DE_OPTOUT.includes(bruto);
}

module.exports = {
  FUSO,
  TIPOS,
  ESTADOS,
  REGRA_POR_TIPO,
  STATUS_SEM_LEMBRETE,
  BACKOFF_BASE_MS,
  BACKOFF_TETO_MS,
  MAX_TENTATIVAS_PADRAO,
  LEASE_MS,
  PALAVRAS_DE_OPTOUT,
  ErroDeLembrete,
  instanteDeEnvio,
  planejarLembretes,
  decidirEnvio,
  proximaTentativa,
  esgotou,
  abandonado,
  primeiroNome,
  horaLocal,
  diaLocal,
  referenciaDoDia,
  montarTexto,
  montarEnvelope,
  mascararTelefone,
  ehPedidoDeOptOut,
};
