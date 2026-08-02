'use strict';

// Vocabulário de conversas e leads do crmclinica, alinhado ao que a equipe já usa
// no Chatwoot. O Chatwoot continua sendo o inbox: aqui só traduzimos o que vem de lá
// para o vocabulário do CRM e decidimos quando a automação deve calar a boca.

// --- Filas exibidas para a equipe ---
const FILAS = Object.freeze({
  minhas: { rotulo: 'Minhas', assignee_type: 'me' },
  nao_atribuidas: { rotulo: 'Não atribuídas', assignee_type: 'unassigned' },
  todos: { rotulo: 'Todos', assignee_type: 'all' },
});
const FILA_PADRAO = 'nao_atribuidas';

// --- Estados de conversa (os mesmos do Chatwoot) ---
const ESTADOS = Object.freeze(['open', 'pending', 'resolved', 'snoozed']);
const ESTADOS_ABERTOS = Object.freeze(['open', 'pending']);

// --- Prioridades ---
const PRIORIDADES = Object.freeze(['urgent', 'high', 'medium', 'low']);
const PRIORIDADES_PT = Object.freeze({
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
});

// --- Temperatura do lead ---
// Etiquetas novas, criadas para o CRM. As etiquetas que a equipe já usa
// (avaliacao, positiva, negativa, atendimento_humano, em_protocolo, pagou_sinal…)
// são preservadas: nada aqui as remove.
const TEMPERATURAS = Object.freeze({
  quente: 'lead_quente',
  morno: 'lead_morno',
  frio: 'lead_frio',
});
const ETIQUETAS_TEMPERATURA = Object.freeze(Object.values(TEMPERATURAS));

// Etiqueta que a equipe usa para sinalizar que o atendimento é humano.
const ETIQUETA_ATENDIMENTO_HUMANO = 'atendimento_humano';

/**
 * Troca a etiqueta de temperatura preservando todas as demais.
 * Só as três etiquetas de temperatura são mexidas — nunca as da equipe.
 */
function aplicarTemperatura(etiquetasAtuais, temperatura) {
  if (!Object.hasOwn(TEMPERATURAS, temperatura)) {
    throw new Error(`temperatura inválida: ${temperatura}`);
  }
  const preservadas = (etiquetasAtuais || []).filter((etiqueta) => !ETIQUETAS_TEMPERATURA.includes(etiqueta));
  return [...preservadas, TEMPERATURAS[temperatura]];
}

/** Lê a temperatura atual a partir das etiquetas da conversa. */
function lerTemperatura(etiquetas = []) {
  for (const [nome, etiqueta] of Object.entries(TEMPERATURAS)) {
    if (etiquetas.includes(etiqueta)) return nome;
  }
  return null;
}

/**
 * Decide se a automação pode responder a esta conversa.
 *
 * A regra do produto é simples e conservadora: **quando um humano assume, a IA cala**.
 * Na dúvida, a automação fica em silêncio — atender duas vezes é pior que atender devagar.
 */
function decidirAutomacao(conversa = {}) {
  const etiquetas = conversa.etiquetas || [];

  if (conversa.responsavel) {
    return { responder: false, motivo: 'humano_responsavel' };
  }
  if (etiquetas.includes(ETIQUETA_ATENDIMENTO_HUMANO)) {
    return { responder: false, motivo: 'marcada_para_atendimento_humano' };
  }
  if (conversa.estado === 'resolved') {
    return { responder: false, motivo: 'conversa_resolvida' };
  }
  if (conversa.estado === 'snoozed') {
    return { responder: false, motivo: 'conversa_adiada' };
  }
  if (conversa.pausadaAte && new Date(conversa.pausadaAte) > new Date()) {
    return { responder: false, motivo: 'pausa_temporaria' };
  }
  if (!ESTADOS_ABERTOS.includes(conversa.estado)) {
    return { responder: false, motivo: 'estado_desconhecido' };
  }

  return { responder: true, motivo: 'sem_humano_responsavel' };
}

/**
 * Contexto mínimo autorizado a sair do CRM para o orquestrador.
 *
 * O histórico inteiro nunca é enviado: só as últimas mensagens, sem anexo,
 * sem nota interna e sem nada do prontuário.
 */
function montarContextoMinimo(conversa = {}, mensagens = [], limite = 10) {
  const recentes = mensagens
    .filter((mensagem) => !mensagem.privada)
    .slice(-limite)
    .map((mensagem) => ({
      autor: mensagem.autor,
      texto: mensagem.texto,
      em: mensagem.criadaEm,
    }));

  return {
    conversa_id: conversa.id,
    canal: conversa.canal || 'whatsapp',
    estado: conversa.estado,
    temperatura: lerTemperatura(conversa.etiquetas),
    contato: {
      // Identificação operacional apenas: nada clínico atravessa esta fronteira.
      nome: conversa.contato?.nome || null,
      telefone: conversa.contato?.telefone || null,
      identificador: conversa.contato?.identificador || null,
    },
    mensagens: recentes,
  };
}

module.exports = {
  FILAS,
  FILA_PADRAO,
  ESTADOS,
  ESTADOS_ABERTOS,
  PRIORIDADES,
  PRIORIDADES_PT,
  TEMPERATURAS,
  ETIQUETAS_TEMPERATURA,
  ETIQUETA_ATENDIMENTO_HUMANO,
  aplicarTemperatura,
  lerTemperatura,
  decidirAutomacao,
  montarContextoMinimo,
};
