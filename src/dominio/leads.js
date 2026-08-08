'use strict';

const { TEMPERATURAS, lerTemperatura } = require('./conversas');

// Leads do crmclinica. O lead vive no mesmo banco da conversa e guarda o
// vínculo `conversa_id` — é ele que faz o card do kanban abrir a conversa certa.

const ORIGENS = Object.freeze([
  'WHATSAPP', 'SITE', 'TELEFONE', 'INDICACAO', 'INSTAGRAM',
  'FACEBOOK', 'GOOGLE', 'CONVENIO', 'WALK_IN', 'OUTRO',
]);

const ESTAGIOS = Object.freeze(['novo', 'qualificando', 'agendado', 'convertido', 'perdido']);

// Colunas do kanban, na ordem em que a equipe trabalha.
const COLUNAS = Object.freeze([
  { estagio: 'novo', rotulo: 'Novos' },
  { estagio: 'qualificando', rotulo: 'Qualificando' },
  { estagio: 'agendado', rotulo: 'Agendados' },
  { estagio: 'convertido', rotulo: 'Convertidos' },
  { estagio: 'perdido', rotulo: 'Perdidos' },
]);

const ORIGEM_POR_CANAL = Object.freeze({
  whatsapp: 'WHATSAPP',
  instagram: 'INSTAGRAM',
  site: 'SITE',
  formulario: 'SITE',
  interno: 'OUTRO',
});

function origemDoCanal(canal) {
  return ORIGEM_POR_CANAL[canal] || 'OUTRO';
}

function horasDesde(instante, agora = Date.now()) {
  if (!instante) return null;
  const data = new Date(instante);
  if (Number.isNaN(data.getTime())) return null;
  return (agora - data.getTime()) / 3_600_000;
}

/**
 * Sugere a temperatura do lead a partir do que já se sabe da conversa.
 *
 * É sugestão, não veredito: a etiqueta posta por uma pessoa sempre vence, e a
 * automação nunca a sobrescreve.
 */
function sugerirTemperatura(conversa = {}) {
  const jaMarcada = lerTemperatura(conversa.etiquetas);
  if (jaMarcada) return { temperatura: jaMarcada, origem: 'etiqueta_da_equipe' };

  const etiquetas = conversa.etiquetas || [];
  if (etiquetas.includes('pagou_sinal') || etiquetas.includes('em_protocolo')) {
    return { temperatura: 'quente', origem: 'etiqueta_de_compromisso' };
  }
  if (conversa.prioridade === 'urgente' || conversa.prioridade === 'alta') {
    return { temperatura: 'quente', origem: 'prioridade_alta' };
  }

  const horas = horasDesde(conversa.ultima_msg_em);
  if (horas === null) return { temperatura: 'morno', origem: 'sem_historico' };
  if (horas <= 24) return { temperatura: 'quente', origem: 'atividade_recente' };
  if (horas <= 72) return { temperatura: 'morno', origem: 'atividade_na_semana' };
  return { temperatura: 'frio', origem: 'sem_atividade_recente' };
}

/** Agrupa leads nas colunas do kanban, preservando a ordem das colunas. */
function agruparPorColuna(leads = []) {
  return COLUNAS.map(({ estagio, rotulo }) => {
    const daColuna = leads.filter((lead) => lead.estagio === estagio);
    return { estagio, rotulo, total: daColuna.length, leads: daColuna };
  });
}

// Faixas de aging do kanban. Largas de propósito: o que importa é "fresco,
// esfriando ou abandonado", não a contagem exata.
const FAIXAS_DE_AGING = Object.freeze([
  { ate: 3, nivel: 'recente' },
  { ate: 7, nivel: 'atencao' },
  { ate: 14, nivel: 'esfriando' },
  { ate: Infinity, nivel: 'abandonado' },
]);

/**
 * Dias corridos no estágio atual e a faixa de alerta correspondente.
 * Sem `estagio_desde` (lead anterior à migration), devolve nulo em vez de
 * inventar zero — zero diria "chegou agora", que é mentira.
 */
function agingDoLead(lead = {}, agora = Date.now()) {
  if (!lead.estagio_desde) return { dias_no_estagio: null, aging: null };

  const desde = new Date(lead.estagio_desde);
  if (Number.isNaN(desde.getTime())) return { dias_no_estagio: null, aging: null };

  const dias = Math.max(0, Math.floor((agora - desde.getTime()) / 86_400_000));
  const faixa = FAIXAS_DE_AGING.find(({ ate }) => dias <= ate);
  return { dias_no_estagio: dias, aging: faixa.nivel };
}

module.exports = {
  ORIGENS,
  ESTAGIOS,
  COLUNAS,
  TEMPERATURAS,
  FAIXAS_DE_AGING,
  origemDoCanal,
  sugerirTemperatura,
  agruparPorColuna,
  agingDoLead,
};
