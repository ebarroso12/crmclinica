'use strict';

// Adaptador do webhook nativo da Evolution API (não confundir com a ponte do
// OpenClaw, em integracoes/openclaw-plugin-crmclinica/ponte.js).
//
// A Evolution manda o payload dela do jeito dela — evento MESSAGES_UPSERT com
// `data.key`/`data.message`, sem a menor ideia do contrato interno do CRM.
// Este arquivo faz só essa tradução: pega o que a Evolution manda e devolve a
// mesma forma que `normalizarEvento` (na ponte do OpenClaw) produz, para que o
// resto do caminho — `validarEvento`, `exigirEstrategiaDoAdaptador`, a conversa
// — seja idêntico para as duas origens.
//
// Eventos que não são mensagem (CONNECTION_UPDATE, QRCODE_UPDATED), mensagens
// enviadas pelo próprio número da clínica (fromMe) e mensagens de grupo são
// ignorados aqui — devolvem `null`, e quem chama responde 200 sem processar
// nada. Ignorar não é falha: é a Evolution mandando um evento que não é
// "paciente escreveu", e tratar isso como erro encheria o log de barulho.

const LIMITE_TEXTO = 8_000;

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function ehEventoDeMensagem(payload) {
  const evento = texto(payload?.event).toLowerCase();
  return evento === 'messages.upsert' || evento === 'messages_upsert';
}

function normalizarTelefone(remoteJid) {
  const bruto = texto(remoteJid);
  if (!bruto || /@g\.us/i.test(bruto)) return null; // grupo, não é conversa de paciente
  const antesDoJid = bruto.split('@')[0];
  const digitos = antesDoJid.replace(/\D/g, '');
  return /^\d{10,15}$/.test(digitos) ? digitos : null;
}

function instanteIso(valor) {
  if (valor === undefined || valor === null || valor === '') return new Date().toISOString();
  let candidato = valor;
  if (typeof candidato === 'string' && /^\d+$/.test(candidato)) candidato = Number(candidato);
  if (typeof candidato === 'number' && candidato > 0 && candidato < 10_000_000_000) candidato *= 1000;
  const data = new Date(candidato);
  return Number.isNaN(data.getTime()) ? new Date().toISOString() : data.toISOString();
}

/** Extrai o texto da mensagem — só os formatos de texto simples por ora. */
function textoDaMensagem(mensagem) {
  if (!mensagem || typeof mensagem !== 'object') return '';
  return texto(mensagem.conversation)
    || texto(mensagem.extendedTextMessage?.text)
    || texto(mensagem.ephemeralMessage?.message?.conversation)
    || texto(mensagem.ephemeralMessage?.message?.extendedTextMessage?.text);
}

/**
 * Traduz um payload de webhook da Evolution API para o contrato interno do
 * CRM. Devolve `null` quando o evento não é uma mensagem de paciente a
 * processar (não é MESSAGES_UPSERT, é eco do próprio envio, é grupo, ou não
 * tem texto reconhecível — mídia sem legenda, por exemplo, fica de fora nesta
 * primeira versão).
 */
function normalizarEventoEvolution(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (!ehEventoDeMensagem(payload)) return null;

  const dado = payload.data;
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return null;
  if (dado.key?.fromMe === true) return null; // a própria Serena/equipe mandou — eco, não entrada

  const remetente = normalizarTelefone(dado.key?.remoteJid);
  if (!remetente) return null;

  const conteudo = textoDaMensagem(dado.message);
  if (!conteudo) return null;

  const idNativo = texto(dado.key?.id);
  const ocorridoEm = instanteIso(dado.messageTimestamp);

  return {
    tipo: 'mensagem.recebida',
    canal: 'whatsapp',
    id_externo: `evolution:${idNativo || `${remetente}|${ocorridoEm}`}`.slice(0, 200),
    remetente,
    nome: texto(dado.pushName).slice(0, 160) || null,
    texto: conteudo.slice(0, LIMITE_TEXTO),
    origem: 'evolution_webhook',
    ocorrido_em: ocorridoEm,
  };
}

module.exports = { normalizarEventoEvolution };
