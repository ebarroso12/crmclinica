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

module.exports = {
  ORIGENS,
  ESTAGIOS,
  COLUNAS,
  TEMPERATURAS,
  origemDoCanal,
  sugerirTemperatura,
  agruparPorColuna,
};
