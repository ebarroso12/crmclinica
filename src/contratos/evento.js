'use strict';

const crypto = require('node:crypto');
const { ErroDeContrato } = require('./erros');

// Contrato único de entrada do crmclinica.
// Todo evento externo — canal, formulário ou tarefa do OpenClaw — atravessa este arquivo
// antes de virar conversa, lead ou tarefa. Nada entra no CRM sem passar por aqui.

const VERSAO_CONTRATO = '1';

const CANAIS = Object.freeze(['whatsapp', 'instagram', 'site', 'formulario', 'interno']);

// Estratégia de IA: quem aciona a resposta automática para este evento.
//
//   openclaw_gerencia — o OpenClaw já controla a conversa (Arquitetura A).
//     A Serena responde diretamente no canal. O CRM importa, persiste e
//     qualifica, mas não despacha ao orquestrador para gerar resposta.
//     Usado por sincronia-conversas.js (polling do histórico do WhatsApp).
//
//   crm_despacha — o CRM é responsável por acionar a IA (Arquitetura B).
//     O evento veio de um canal que não tem agente conectado (site, formulário,
//     Instagram sem bot) ou de um webhook externo. O CRM chama o orquestrador.
//
// Quando ausente (null), o comportamento é determinado pelo canal:
//   canal='whatsapp' com origem='whatsapp' → openclaw_gerencia (retrocompatível)
//   demais canais → crm_despacha (retrocompatível)
const ESTRATEGIAS_IA = Object.freeze(['openclaw_gerencia', 'crm_despacha']);
const TIPOS = Object.freeze(['mensagem.recebida', 'lead.criado', 'agendamento.solicitado', 'tarefa.concluida']);

const LIMITES = Object.freeze({
  estrategiaIa: 20,
  idExterno: 200,
  remetente: 120,
  nome: 160,
  texto: 8000,
  origem: 80,
});

function exigirTexto(valor, campo, limite) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

function textoOpcional(valor, campo, limite) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string') throw new ErroDeContrato(`campo "${campo}" deve ser texto`, campo);
  const bruto = valor.trim();
  if (!bruto) return null;
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

function exigirEnum(valor, campo, permitidos) {
  const bruto = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!permitidos.includes(bruto)) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um de: ${permitidos.join(', ')}`, campo);
  }
  return bruto;
}

function normalizarInstante(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return new Date().toISOString();
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) throw new ErroDeContrato(`campo "${campo}" não é uma data válida`, campo);
  return data.toISOString();
}

// A chave de idempotência é derivada apenas de identidade, nunca de conteúdo:
// reenviar o mesmo evento com o texto corrigido continua sendo o mesmo evento.
function calcularChaveIdempotencia({ canal, tipo, idExterno }) {
  return crypto
    .createHash('sha256')
    .update(`${VERSAO_CONTRATO}|${canal}|${tipo}|${idExterno}`, 'utf8')
    .digest('hex');
}

/**
 * Valida e normaliza um evento externo.
 * Devolve sempre a mesma forma, com a chave de idempotência já calculada.
 * @throws {ErroDeContrato} quando a entrada não satisfaz o contrato.
 */
function validarEvento(entrada) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) {
    throw new ErroDeContrato('evento deve ser um objeto');
  }

  const tipo = exigirEnum(entrada.tipo ?? 'mensagem.recebida', 'tipo', TIPOS);
  const canal = exigirEnum(entrada.canal, 'canal', CANAIS);
  const idExterno = exigirTexto(entrada.id_externo, 'id_externo', LIMITES.idExterno);
  const remetente = exigirTexto(entrada.remetente, 'remetente', LIMITES.remetente);
  const ocorridoEm = normalizarInstante(entrada.ocorrido_em, 'ocorrido_em');

  // Só evento de mensagem exige texto; os demais tipos podem chegar sem corpo.
  const texto = tipo === 'mensagem.recebida'
    ? exigirTexto(entrada.texto, 'texto', LIMITES.texto)
    : textoOpcional(entrada.texto, 'texto', LIMITES.texto);

  // Estratégia de IA: campo explícito tem precedência.
  // Sem campo explícito, inferir pelo canal e pela origem (retrocompatível).
  let estrategiaIa = null;
  if (entrada.estrategia_ia) {
    const bruto = String(entrada.estrategia_ia).trim().toLowerCase();
    if (!ESTRATEGIAS_IA.includes(bruto)) {
      throw new ErroDeContrato(
        `campo "estrategia_ia" deve ser um de: ${ESTRATEGIAS_IA.join(', ')}`,
        'estrategia_ia',
      );
    }
    estrategiaIa = bruto;
  } else {
    // Retrocompatibilidade: sincronia-conversas.js passa origem='whatsapp',
    // que indica que o OpenClaw já gerencia a conversa.
    const origemBruta = typeof entrada.origem === 'string' ? entrada.origem.trim().toLowerCase() : null;
    if (origemBruta === 'whatsapp') {
      estrategiaIa = 'openclaw_gerencia';
    } else if (entrada.canal && entrada.canal !== 'whatsapp') {
      estrategiaIa = 'crm_despacha';
    }
    // canal='whatsapp' sem origem='whatsapp' → null (ambíguo, não inferir)
  }

  const evento = {
    versao: VERSAO_CONTRATO,
    tipo,
    canal,
    id_externo: idExterno,
    remetente,
    nome: textoOpcional(entrada.nome, 'nome', LIMITES.nome),
    texto,
    origem: textoOpcional(entrada.origem, 'origem', LIMITES.origem),
    estrategia_ia: estrategiaIa,
    ocorrido_em: ocorridoEm,
  };

  evento.chave_idempotencia = calcularChaveIdempotencia({ canal, tipo, idExterno });
  return Object.freeze(evento);
}

// Compatibilidade com o contrato inicial, que só conhecia mensagens.
function validarEventoMensagem(entrada) {
  return validarEvento({ ...entrada, tipo: 'mensagem.recebida' });
}

module.exports = {
  VERSAO_CONTRATO,
  CANAIS,
  TIPOS,
  ESTRATEGIAS_IA,
  LIMITES,
  validarEvento,
  validarEventoMensagem,
  calcularChaveIdempotencia,
};
