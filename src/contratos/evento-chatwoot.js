'use strict';

const crypto = require('node:crypto');
const { ErroDeContrato } = require('./erros');

// Contrato dos eventos que o Chatwoot envia por webhook.
// Mesma disciplina do contrato de eventos de canal: nada entra sem validação,
// e todo evento carrega chave de idempotência antes de virar ação no CRM.

const VERSAO_CONTRATO = '1';

// Só tratamos os eventos que mudam o que o CRM precisa saber.
const EVENTOS = Object.freeze([
  'message_created',
  'message_updated',
  'conversation_created',
  'conversation_updated',
  'conversation_status_changed',
  'assignee_changed',
  'contact_created',
  'contact_updated',
]);

function exigir(valor, campo) {
  if (valor === undefined || valor === null || valor === '') {
    throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  }
  return valor;
}

/**
 * Interpreta o instante vindo do Chatwoot, que manda ora epoch em segundos, ora string ISO.
 * Devolve `null` quando não veio nada utilizável — a diferença importa para a chave.
 */
function instanteDaOrigem(valor) {
  if (!valor) return null;
  const data = typeof valor === 'number' ? new Date(valor * 1000) : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * A chave identifica o fato, não a entrega.
 * Reentrega do mesmo webhook — o Chatwoot repete em falha de rede — cai na mesma chave.
 *
 * Por isso o instante só entra na chave quando veio da **origem**: usar o relógio da
 * recepção faria cada reentrega parecer um fato novo, e o paciente receberia resposta dobrada.
 */
function calcularChave({ evento, conversaId, recursoId, ocorridoEmDaOrigem = null }) {
  return crypto
    .createHash('sha256')
    .update(
      `${VERSAO_CONTRATO}|chatwoot|${evento}|${conversaId ?? '-'}|${recursoId ?? '-'}|${ocorridoEmDaOrigem ?? '-'}`,
      'utf8',
    )
    .digest('hex');
}

/**
 * Valida e normaliza o corpo de um webhook do Chatwoot.
 * @throws {ErroDeContrato} quando o corpo não é reconhecível.
 */
function validarEventoChatwoot(entrada) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) {
    throw new ErroDeContrato('evento deve ser um objeto');
  }

  const evento = String(exigir(entrada.event, 'event')).trim();
  if (!EVENTOS.includes(evento)) {
    throw new ErroDeContrato(`evento não tratado: ${evento}`, 'event');
  }

  const conversa = entrada.conversation || {};
  const contato = entrada.sender || entrada.contact || conversa.meta?.sender || {};
  const conversaId = conversa.id ?? entrada.conversation_id ?? null;

  // Em message_created o recurso é a mensagem; nos demais, a própria conversa.
  const ehMensagem = evento.startsWith('message_');
  const recursoId = ehMensagem ? (entrada.id ?? null) : conversaId;

  if (ehMensagem && recursoId === null) {
    throw new ErroDeContrato('mensagem sem identificador', 'id');
  }
  if (!ehMensagem && conversaId === null && !evento.startsWith('contact_')) {
    throw new ErroDeContrato('evento de conversa sem identificador', 'conversation.id');
  }

  const ocorridoEmDaOrigem = instanteDaOrigem(entrada.created_at || conversa.timestamp);
  // Sem instante da origem, registramos a recepção — mas ela não entra na chave.
  const ocorridoEm = ocorridoEmDaOrigem ?? new Date().toISOString();

  const normalizado = {
    versao: VERSAO_CONTRATO,
    fonte: 'chatwoot',
    evento,
    conta_id: entrada.account?.id ?? null,
    inbox_id: entrada.inbox?.id ?? conversa.inbox_id ?? null,
    conversa_id: conversaId,
    recurso_id: recursoId,
    ocorrido_em: ocorridoEm,

    conversa: {
      id: conversaId,
      estado: conversa.status ?? null,
      prioridade: conversa.priority ?? null,
      etiquetas: conversa.labels || [],
      responsavel: conversa.meta?.assignee
        ? { id: conversa.meta.assignee.id, nome: conversa.meta.assignee.name || null }
        : null,
      time: conversa.meta?.team ? { id: conversa.meta.team.id, nome: conversa.meta.team.name } : null,
      canal: entrada.inbox?.channel_type ?? conversa.channel ?? null,
    },

    contato: {
      id: contato.id ?? null,
      nome: contato.name || null,
      telefone: contato.phone_number || null,
      email: contato.email || null,
      identificador: contato.identifier || null,
    },

    mensagem: ehMensagem
      ? {
        id: entrada.id ?? null,
        texto: entrada.content || '',
        // 'incoming' vem do paciente; 'outgoing' foi enviada pela equipe ou pela automação.
        direcao: entrada.message_type || null,
        privada: Boolean(entrada.private),
        autor_tipo: entrada.sender?.type || null,
        autor_nome: entrada.sender?.name || null,
      }
      : null,
  };

  normalizado.chave_idempotencia = calcularChave({
    evento,
    conversaId,
    recursoId,
    ocorridoEmDaOrigem,
  });

  return Object.freeze(normalizado);
}

module.exports = { VERSAO_CONTRATO, EVENTOS, validarEventoChatwoot, calcularChave };
