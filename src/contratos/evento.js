'use strict';

const crypto = require('node:crypto');
const { ErroDeContrato, ErroDeEstrategia } = require('./erros');

// Contrato único de entrada do crmclinica.
// Todo evento externo — canal, formulário ou tarefa do OpenClaw — atravessa este arquivo
// antes de virar conversa, lead ou tarefa. Nada entra no CRM sem passar por aqui.

const VERSAO_CONTRATO = '1';

const CANAIS = Object.freeze(['whatsapp', 'instagram', 'site', 'formulario', 'interno']);
const TIPOS = Object.freeze(['mensagem.recebida', 'lead.criado', 'agendamento.solicitado', 'tarefa.concluida']);

// Estratégia de IA: quem é o dono da resposta automática deste evento.
//
//   openclaw_gerencia — a conversa já pertence ao agente do OpenClaw, que
//     responde direto no canal. O CRM importa, persiste e qualifica; despachar
//     de novo faria o agente processar a mesma mensagem duas vezes, e o
//     paciente receber duas respostas.
//
//   crm_despacha — o evento veio de um canal em que ninguém responde sozinho
//     (site, formulário). Aí o CRM é quem aciona a IA.
//
// O contrato valida a forma; quem decide o valor é o ADAPTADOR confiável que
// recebeu o evento (a rota autenticada, o sincronizador do WhatsApp) — nunca o
// payload por conta própria. A função `exigirEstrategiaDoAdaptador` é essa
// decisão, e ela falha fechado: WhatsApp sem dono declarado não entra.
const ESTRATEGIAS_IA = Object.freeze(['openclaw_gerencia', 'crm_despacha']);

const LIMITES = Object.freeze({
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

  // Só a forma: o valor declarado no payload é uma REIVINDICAÇÃO, não uma
  // decisão. Quem confirma (ou recusa) é o adaptador, via
  // `exigirEstrategiaDoAdaptador` — inferir aqui daria ao remetente do JSON o
  // poder de escolher quem responde pela conversa.
  let estrategiaIa = null;
  if (entrada.estrategia_ia !== undefined && entrada.estrategia_ia !== null && entrada.estrategia_ia !== '') {
    estrategiaIa = exigirEnum(entrada.estrategia_ia, 'estrategia_ia', ESTRATEGIAS_IA);
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

/**
 * A decisão de propriedade do fluxo de IA, tomada pelo adaptador que recebeu o
 * evento — o único que sabe por qual porta autenticada ele entrou.
 *
 * Devolve o evento com `estrategia_ia` definitiva (novo objeto, congelado).
 * Recusa com `ErroDeEstrategia` (HTTP 422) tudo que for ambíguo ou incompatível.
 *
 * Regras por adaptador:
 *
 *   `sincronia_whatsapp` — o importador oficial do histórico do WhatsApp.
 *     A conversa JÁ está com o agente por definição: tudo vira
 *     `openclaw_gerencia`, e qualquer outra reivindicação é recusada.
 *
 *   `sincronia_whatsapp_crm` — importador da Arquitetura B. O agente direto do
 *     canal está globalmente calado e o CRM é o único dono da resposta; tudo
 *     vira `crm_despacha`. Este adaptador só é escolhido por configuração do
 *     processo, nunca pelo payload do canal.
 *
 *   `openclaw_webhook` — a rota autenticada por HMAC (`POST /api/eventos`).
 *     • WhatsApp sem estratégia: recusado (`estrategia_ia_ambigua`). A mensagem
 *       pode já ter sido respondida pelo agente no canal; adivinhar aqui é
 *       apostar a resposta duplicada do paciente.
 *     • WhatsApp com `crm_despacha`: recusado (`estrategia_ia_incompativel`).
 *       Quem entra autenticado como OpenClaw não pode pedir que o CRM redispare
 *       a IA sobre uma conversa que o próprio OpenClaw carrega.
 *     • Canal sem agente conectado (site, formulário…): `crm_despacha` — e
 *       `openclaw_gerencia` é recusado, porque não existe adaptador autorizado
 *       dizendo que o agente gerencia esses canais.
 */
function exigirEstrategiaDoAdaptador(evento, adaptador) {
  const declarada = evento.estrategia_ia ?? null;

  if (adaptador === 'sincronia_whatsapp') {
    if (evento.canal !== 'whatsapp') {
      throw new ErroDeEstrategia(
        'o sincronizador do WhatsApp só importa eventos do canal whatsapp',
        'estrategia_ia_incompativel',
      );
    }
    if (declarada && declarada !== 'openclaw_gerencia') {
      throw new ErroDeEstrategia(
        'mensagem importada do WhatsApp já pertence ao agente do canal',
        'estrategia_ia_incompativel',
      );
    }
    return Object.freeze({ ...evento, estrategia_ia: 'openclaw_gerencia' });
  }

  if (adaptador === 'sincronia_whatsapp_crm') {
    if (evento.canal !== 'whatsapp') {
      throw new ErroDeEstrategia(
        'o sincronizador do WhatsApp só importa eventos do canal whatsapp',
        'estrategia_ia_incompativel',
      );
    }
    if (declarada && declarada !== 'crm_despacha') {
      throw new ErroDeEstrategia(
        'na Arquitetura B a resposta pertence exclusivamente ao CRM',
        'estrategia_ia_incompativel',
      );
    }
    return Object.freeze({ ...evento, estrategia_ia: 'crm_despacha' });
  }

  if (adaptador === 'openclaw_webhook') {
    if (evento.canal === 'whatsapp') {
      if (!declarada) {
        throw new ErroDeEstrategia(
          'evento de WhatsApp precisa declarar quem responde por ele',
          'estrategia_ia_ambigua',
        );
      }
      if (declarada !== 'openclaw_gerencia') {
        throw new ErroDeEstrategia(
          'evento autenticado do OpenClaw não pode pedir redespacho pelo CRM',
          'estrategia_ia_incompativel',
        );
      }
      return evento;
    }

    if (declarada === 'openclaw_gerencia') {
      throw new ErroDeEstrategia(
        `nenhum adaptador autorizado gerencia o canal ${evento.canal} pelo agente`,
        'estrategia_ia_incompativel',
      );
    }
    // Sem declaração, a porta decide: nesses canais é o CRM que aciona a IA.
    return declarada ? evento : Object.freeze({ ...evento, estrategia_ia: 'crm_despacha' });
  }

  throw new ErroDeEstrategia(`adaptador desconhecido: ${adaptador}`, 'adaptador_desconhecido');
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
  exigirEstrategiaDoAdaptador,
  calcularChaveIdempotencia,
};
