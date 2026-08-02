'use strict';

// Vocabulário do inbox do crmclinica. O inbox é o próprio produto: estes são os
// estados e regras do atendimento, não a tradução de um sistema externo.

// --- Filas exibidas para a equipe ---
const FILAS = Object.freeze({
  minhas: { rotulo: 'Minhas', descricao: 'Conversas atribuídas a você' },
  nao_atribuidas: { rotulo: 'Não atribuídas', descricao: 'Ninguém assumiu ainda' },
  todos: { rotulo: 'Todos', descricao: 'Tudo que está no inbox' },
});
const FILA_PADRAO = 'nao_atribuidas';

// --- Estados de conversa ---
const ESTADOS = Object.freeze(['aberta', 'pendente', 'resolvida']);
const ESTADOS_ABERTOS = Object.freeze(['aberta', 'pendente']);

// --- Prioridades ---
const PRIORIDADES = Object.freeze(['baixa', 'media', 'alta', 'urgente']);
const PRIORIDADES_PT = Object.freeze({
  urgente: 'Urgente',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
});

// --- Temperatura do lead ---
const TEMPERATURAS = Object.freeze(['quente', 'morno', 'frio']);
const ETIQUETA_POR_TEMPERATURA = Object.freeze({
  quente: 'lead_quente',
  morno: 'lead_morno',
  frio: 'lead_frio',
});
const ETIQUETAS_TEMPERATURA = Object.freeze(Object.values(ETIQUETA_POR_TEMPERATURA));

/**
 * Troca a etiqueta de temperatura preservando todas as demais.
 * As etiquetas operacionais da equipe — `pagou_sinal`, `em_protocolo`, `avaliacao`… —
 * nunca são tocadas por esta função.
 */
function aplicarTemperatura(etiquetasAtuais, temperatura) {
  if (!TEMPERATURAS.includes(temperatura)) {
    throw new Error(`temperatura inválida: ${temperatura}`);
  }
  const preservadas = (etiquetasAtuais || []).filter((etiqueta) => !ETIQUETAS_TEMPERATURA.includes(etiqueta));
  return [...preservadas, ETIQUETA_POR_TEMPERATURA[temperatura]];
}

/** Lê a temperatura a partir das etiquetas da conversa. */
function lerTemperatura(etiquetas = []) {
  for (const [nome, etiqueta] of Object.entries(ETIQUETA_POR_TEMPERATURA)) {
    if (etiquetas.includes(etiqueta)) return nome;
  }
  return null;
}

/**
 * Decide se a automação pode responder a esta conversa.
 *
 * A regra do produto é conservadora: **quando um humano assume, a IA cala**.
 * Na dúvida, silêncio — atender duas vezes é pior que atender devagar.
 */
function decidirAutomacao(conversa = {}) {
  if (conversa.assumida_por_humano) {
    return { responder: false, motivo: 'assumida_por_humano' };
  }
  if (conversa.atribuido_a) {
    return { responder: false, motivo: 'humano_responsavel' };
  }
  if (conversa.status === 'resolvida') {
    return { responder: false, motivo: 'conversa_resolvida' };
  }
  if (conversa.ia_pausada_ate && new Date(conversa.ia_pausada_ate) > new Date()) {
    return { responder: false, motivo: 'pausa_temporaria' };
  }
  if (!ESTADOS_ABERTOS.includes(conversa.status)) {
    return { responder: false, motivo: 'estado_desconhecido' };
  }

  return { responder: true, motivo: 'sem_humano_responsavel' };
}

/**
 * Contexto mínimo autorizado a sair do CRM para o orquestrador.
 *
 * O histórico inteiro nunca é enviado: só as últimas mensagens, sem nota interna,
 * sem anexo e sem nada do prontuário.
 */
function montarContextoMinimo(conversa = {}, mensagens = [], limite = 10) {
  const recentes = mensagens
    .filter((mensagem) => !mensagem.privada && mensagem.tipo !== 'sistema')
    .slice(-limite)
    .map((mensagem) => ({
      autor: mensagem.autor_tipo === 'contato' ? 'contato' : 'clinica',
      texto: mensagem.conteudo,
      em: mensagem.criado_em,
    }));

  return {
    conversa_id: conversa.id,
    canal: conversa.canal || 'whatsapp',
    estado: conversa.status,
    temperatura: conversa.temperatura ?? lerTemperatura(conversa.etiquetas),
    contato: {
      // Identificação operacional apenas: nada clínico atravessa esta fronteira.
      nome: conversa.contato?.nome ?? null,
      telefone: conversa.contato?.telefone ?? null,
      identificador: conversa.contato?.identificador ?? null,
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
  ETIQUETA_POR_TEMPERATURA,
  ETIQUETAS_TEMPERATURA,
  aplicarTemperatura,
  lerTemperatura,
  decidirAutomacao,
  montarContextoMinimo,
};
