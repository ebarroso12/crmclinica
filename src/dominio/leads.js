'use strict';

const { TEMPERATURAS, lerTemperatura } = require('./conversas');

// Vocabulário de leads do crmclinica, alinhado ao modelo do PRD.
// O lead é do CRM; a conversa é do Chatwoot. Os dois se encontram pelo telefone
// do contato e pelo identificador da conversa — sem duplicar histórico de mensagem.

const ORIGENS = Object.freeze([
  'WHATSAPP', 'SITE', 'TELEFONE', 'INDICACAO', 'INSTAGRAM',
  'FACEBOOK', 'GOOGLE', 'CONVENIO', 'WALK_IN', 'OUTRO',
]);

const ESTADOS = Object.freeze([
  'NOVO', 'CONTATADO', 'AGENDADO', 'COMPARECEU', 'CONVERTIDO', 'PERDIDO', 'EM_ESPERA',
]);

const PRIORIDADES = Object.freeze(['BAIXA', 'NORMAL', 'ALTA', 'URGENTE']);

// Colunas do kanban, na ordem em que a equipe trabalha.
const COLUNAS = Object.freeze([
  { estado: 'NOVO', rotulo: 'Novos' },
  { estado: 'CONTATADO', rotulo: 'Qualificando' },
  { estado: 'AGENDADO', rotulo: 'Agendados' },
  { estado: 'CONVERTIDO', rotulo: 'Convertidos' },
  { estado: 'PERDIDO', rotulo: 'Perdidos' },
]);

// Cada canal do Chatwoot vira uma origem de lead conhecida pelo CRM.
const ORIGEM_POR_CANAL = Object.freeze({
  'Channel::Whatsapp': 'WHATSAPP',
  'Channel::Api': 'WHATSAPP',
  'Channel::FacebookPage': 'FACEBOOK',
  'Channel::Instagram': 'INSTAGRAM',
  'Channel::WebWidget': 'SITE',
  'Channel::Email': 'OUTRO',
  'Channel::TwilioSms': 'TELEFONE',
});

function origemDoCanal(tipoDeCanal) {
  return ORIGEM_POR_CANAL[tipoDeCanal] || 'OUTRO';
}

// Prioridade do Chatwoot → prioridade do lead no CRM.
const PRIORIDADE_POR_CHATWOOT = Object.freeze({
  urgent: 'URGENTE',
  high: 'ALTA',
  medium: 'NORMAL',
  low: 'BAIXA',
});

function prioridadeDoChatwoot(prioridade) {
  return PRIORIDADE_POR_CHATWOOT[prioridade] || 'NORMAL';
}

/**
 * Sugere a temperatura do lead a partir do que já se sabe da conversa.
 *
 * É uma sugestão, não um veredito: a equipe pode sobrescrever a qualquer momento
 * pela etiqueta no Chatwoot, e a etiqueta manual sempre vence.
 */
function sugerirTemperatura(conversa = {}) {
  const jaMarcada = lerTemperatura(conversa.etiquetas);
  if (jaMarcada) return { temperatura: jaMarcada, origem: 'etiqueta_da_equipe' };

  const etiquetas = conversa.etiquetas || [];
  if (etiquetas.includes('pagou_sinal') || etiquetas.includes('em_protocolo')) {
    return { temperatura: 'quente', origem: 'etiqueta_de_compromisso' };
  }
  if (conversa.prioridade === 'urgent' || conversa.prioridade === 'high') {
    return { temperatura: 'quente', origem: 'prioridade_alta' };
  }

  const horasSemResposta = calcularHorasDesde(conversa.ultimaAtividadeEm);
  if (horasSemResposta === null) return { temperatura: 'morno', origem: 'sem_historico' };
  if (horasSemResposta <= 24) return { temperatura: 'quente', origem: 'atividade_recente' };
  if (horasSemResposta <= 72) return { temperatura: 'morno', origem: 'atividade_na_semana' };
  return { temperatura: 'frio', origem: 'sem_atividade_recente' };
}

function calcularHorasDesde(instante, agora = Date.now()) {
  if (!instante) return null;
  const data = new Date(instante);
  if (Number.isNaN(data.getTime())) return null;
  return (agora - data.getTime()) / 3_600_000;
}

/**
 * Projeta uma conversa do Chatwoot como lead do CRM.
 * Não persiste nada: quem grava é a camada de armazenamento, quando o banco existir.
 */
function projetarLead(conversa = {}) {
  const { temperatura, origem: origemDaTemperatura } = sugerirTemperatura(conversa);

  return {
    conversa_id: conversa.id,
    contato_id: conversa.contato?.id ?? null,
    nome: conversa.contato?.nome || null,
    telefone: conversa.contato?.telefone || null,
    email: conversa.contato?.email || null,
    origem: origemDoCanal(conversa.tipoDeCanal),
    prioridade: prioridadeDoChatwoot(conversa.prioridade),
    estado: conversa.estado === 'resolved' ? 'CONTATADO' : 'NOVO',
    temperatura,
    temperatura_origem: origemDaTemperatura,
    etiquetas: conversa.etiquetas || [],
    responsavel: conversa.responsavel?.nome || null,
    ultima_atividade_em: conversa.ultimaAtividadeEm || null,
  };
}

/** Agrupa leads nas colunas do kanban, preservando a ordem das colunas. */
function agruparPorColuna(leads = []) {
  return COLUNAS.map(({ estado, rotulo }) => ({
    estado,
    rotulo,
    total: leads.filter((lead) => lead.estado === estado).length,
    leads: leads.filter((lead) => lead.estado === estado),
  }));
}

module.exports = {
  ORIGENS,
  ESTADOS,
  PRIORIDADES,
  COLUNAS,
  TEMPERATURAS,
  origemDoCanal,
  prioridadeDoChatwoot,
  sugerirTemperatura,
  projetarLead,
  agruparPorColuna,
};
