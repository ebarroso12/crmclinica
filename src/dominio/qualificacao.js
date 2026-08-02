'use strict';

// Qualificação de leads.
//
// O que a clínica precisa saber para atender bem: o que a pessoa procura, se é
// primeira consulta, como pretende pagar, com que urgência e em que horário.
// Nada além disso.
//
// **Qualificação é comercial, não clínica.** Sintoma, diagnóstico, medicação e
// histórico de saúde não entram aqui — nem como "campo livre". Se a conversa for
// para esse terreno, é caso de escalonar para a equipe, não de preencher ficha.

const CAMPOS = Object.freeze(['interesse', 'primeira_consulta', 'pagamento', 'urgencia', 'disponibilidade']);

const PAGAMENTOS = Object.freeze(['particular', 'convenio', 'indefinido']);
const URGENCIAS = Object.freeze(['imediata', 'semanas', 'pesquisando', 'indefinida']);
const DISPONIBILIDADES = Object.freeze(['manha', 'tarde', 'noite', 'qualquer', 'indefinida']);

// Uma pergunta por vez, na ordem em que fazem sentido numa conversa real.
// Perguntar as cinco de uma vez transforma acolhimento em formulário.
const PERGUNTAS = Object.freeze([
  {
    campo: 'interesse',
    pergunta: 'Sobre qual procedimento ou avaliação você gostaria de saber?',
    porque: 'sem isso não dá para orientar nem encaminhar',
  },
  {
    campo: 'primeira_consulta',
    pergunta: 'Essa seria sua primeira consulta conosco ou você já é paciente da clínica?',
    porque: 'muda o tipo de agendamento e o tempo reservado',
  },
  {
    campo: 'urgencia',
    pergunta: 'Você gostaria de agendar para os próximos dias ou ainda está pesquisando?',
    porque: 'define a prioridade na fila da equipe',
  },
  {
    campo: 'pagamento',
    pergunta: 'O atendimento seria particular ou por convênio?',
    porque: 'evita frustração no balcão e agiliza o orçamento',
  },
  {
    campo: 'disponibilidade',
    pergunta: 'Você prefere horários de manhã, à tarde ou tanto faz?',
    porque: 'reduz idas e vindas na hora de oferecer horário',
  },
]);

// Peso de cada sinal no score. A soma dos máximos dá 100.
const PESOS = Object.freeze({
  interesse: 20,
  primeira_consulta: 8,
  pagamento: 12,
  disponibilidade: 10,
  urgencia: { imediata: 30, semanas: 18, pesquisando: 6, indefinida: 0 },
  atividade: { ate24h: 20, ate72h: 12, ate7dias: 5, antigo: 0 },
});

function preenchido(valor) {
  return valor !== null && valor !== undefined && valor !== '' && valor !== 'indefinido' && valor !== 'indefinida';
}

/** Quais campos ainda faltam, na ordem de perguntar. */
function camposPendentes(lead = {}) {
  return PERGUNTAS.filter(({ campo }) => !preenchido(lead[campo])).map(({ campo }) => campo);
}

/**
 * A próxima pergunta a fazer, ou `null` quando a qualificação está completa.
 * Devolve também o porquê — é o que permite a equipe entender a sugestão em vez
 * de obedecê-la.
 */
function proximaPergunta(lead = {}) {
  return PERGUNTAS.find(({ campo }) => !preenchido(lead[campo])) ?? null;
}

function horasDesde(instante, agora = Date.now()) {
  if (!instante) return null;
  const data = new Date(instante);
  if (Number.isNaN(data.getTime())) return null;
  return (agora - data.getTime()) / 3_600_000;
}

/**
 * Calcula o score de 0 a 100 e explica cada ponto.
 *
 * O motivo importa tanto quanto o número: sem ele, a equipe não sabe se um lead
 * está com 70 porque tem urgência ou porque respondeu tudo, e não consegue
 * discordar do cálculo com argumento.
 */
function calcularScore(lead = {}, { agora = Date.now() } = {}) {
  const motivos = [];
  let total = 0;

  for (const campo of ['interesse', 'primeira_consulta', 'pagamento', 'disponibilidade']) {
    if (!preenchido(lead[campo])) continue;
    total += PESOS[campo];
    motivos.push({ sinal: campo, pontos: PESOS[campo] });
  }

  const pontosUrgencia = PESOS.urgencia[lead.urgencia] ?? 0;
  if (pontosUrgencia > 0) {
    total += pontosUrgencia;
    motivos.push({ sinal: `urgencia:${lead.urgencia}`, pontos: pontosUrgencia });
  }

  // Conversa recente vale ponto: interesse tem prazo de validade.
  const horas = horasDesde(lead.ultima_msg_em ?? lead.atualizado_em, agora);
  if (horas !== null) {
    const faixa = horas <= 24 ? 'ate24h' : horas <= 72 ? 'ate72h' : horas <= 168 ? 'ate7dias' : 'antigo';
    const pontos = PESOS.atividade[faixa];
    if (pontos > 0) {
      total += pontos;
      motivos.push({ sinal: `atividade:${faixa}`, pontos });
    }
  }

  return { score: Math.min(100, total), motivos };
}

/** Temperatura derivada do score. Faixas largas: precisão falsa não ajuda ninguém. */
function temperaturaDoScore(score) {
  if (score >= 60) return 'quente';
  if (score >= 30) return 'morno';
  return 'frio';
}

/**
 * Decide a temperatura do lead.
 *
 * A marcação manual da equipe **sempre vence**: quem falou com a pessoa sabe
 * coisas que nenhum score captura, e ver a própria classificação ser desfeita
 * por um cálculo ensina a equipe a não usar a ferramenta.
 */
function decidirTemperatura(lead = {}, score = 0) {
  if (lead.temperatura_manual && lead.temperatura) {
    return { temperatura: lead.temperatura, origem: 'equipe' };
  }
  return { temperatura: temperaturaDoScore(score), origem: 'score' };
}

/**
 * Normaliza e valida o que veio da qualificação.
 * Campo com valor fora do vocabulário é descartado, não gravado torto.
 */
function normalizarQualificacao(entrada = {}) {
  const limpo = {};

  if (typeof entrada.interesse === 'string' && entrada.interesse.trim()) {
    limpo.interesse = entrada.interesse.trim().slice(0, 200);
  }
  if (typeof entrada.especialidade === 'string' && entrada.especialidade.trim()) {
    limpo.especialidade = entrada.especialidade.trim().slice(0, 120);
  }
  if (typeof entrada.primeira_consulta === 'boolean') {
    limpo.primeira_consulta = entrada.primeira_consulta;
  }
  if (PAGAMENTOS.includes(entrada.pagamento)) limpo.pagamento = entrada.pagamento;
  if (typeof entrada.convenio_nome === 'string' && entrada.convenio_nome.trim()) {
    limpo.convenio_nome = entrada.convenio_nome.trim().slice(0, 120);
  }
  if (URGENCIAS.includes(entrada.urgencia)) limpo.urgencia = entrada.urgencia;
  if (DISPONIBILIDADES.includes(entrada.disponibilidade)) limpo.disponibilidade = entrada.disponibilidade;

  return limpo;
}

/** Normaliza origem e UTM, que chegam de formulário e de link de campanha. */
function normalizarOrigem(entrada = {}) {
  const limpo = {};
  const campos = ['origem_detalhe', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  for (const campo of campos) {
    const valor = entrada[campo];
    if (typeof valor === 'string' && valor.trim()) limpo[campo] = valor.trim().slice(0, 200);
  }
  return limpo;
}

/**
 * Sugere a próxima ação para a equipe ler na lista.
 * É uma frase curta, não um comando: quem decide é quem atende.
 */
function proximaAcao(lead = {}) {
  if (lead.estagio === 'convertido') return 'Acompanhar retorno';
  if (lead.estagio === 'perdido') return lead.perdido_motivo ? `Perdido: ${lead.perdido_motivo}` : 'Lead perdido';
  if (lead.estagio === 'agendado') return 'Confirmar presença';

  const pergunta = proximaPergunta(lead);
  if (pergunta) return `Perguntar: ${pergunta.pergunta}`;

  return 'Qualificação completa — oferecer horário';
}

module.exports = {
  CAMPOS,
  PAGAMENTOS,
  URGENCIAS,
  DISPONIBILIDADES,
  PERGUNTAS,
  PESOS,
  camposPendentes,
  proximaPergunta,
  calcularScore,
  temperaturaDoScore,
  decidirTemperatura,
  normalizarQualificacao,
  normalizarOrigem,
  proximaAcao,
};
