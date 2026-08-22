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

function normalizarTelefone(remoteJid, remoteJidAlt) {
  const bruto = texto(remoteJid);
  if (!bruto || /@g\.us/i.test(bruto)) return null; // grupo, não é conversa de paciente
  // `@lid` é a identidade opaca do WhatsApp (Linked ID), que vem substituindo
  // o JID de telefone nas mensagens. Os dígitos de um `@lid` NÃO são um
  // número: tratá-los como telefone criava contato fantasma no CRM, e a
  // resposta da Serena saía para um endereço que não existe. O telefone real
  // chega no JID alternativo (`remoteJidAlt`). Sem ele, melhor recusar a
  // mensagem aqui — quem chama registra a perda — do que inventar um número.
  const candidato = /@lid$/i.test(bruto) ? texto(remoteJidAlt) : bruto;
  if (!candidato || /@g\.us/i.test(candidato) || /@lid$/i.test(candidato)) return null;
  const antesDoJid = candidato.split('@')[0];
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

  const remetente = normalizarTelefone(dado.key?.remoteJid, dado.key?.remoteJidAlt);
  if (!remetente) return null;

  const conteudo = textoDaMensagem(dado.message);
  if (!conteudo) return null;

  const idNativo = texto(dado.key?.id);
  const ocorridoEm = instanteIso(dado.messageTimestamp);

  return {
    tipo: 'mensagem.recebida',
    canal: 'whatsapp',
    // PREFIXO NEUTRO, NÃO O NOME DA PORTA (correção da duplicação confirmada
    // em produção). A mesma mensagem do paciente pode chegar pelas DUAS portas
    // de ingresso — o webhook da Evolution e a ponte do OpenClaw — e as duas
    // recebem o MESMO `id` nativo do WhatsApp. Enquanto cada porta carimbava o
    // próprio nome (`evolution:` aqui, `openclaw:` na ponte), a chave de
    // idempotência (derivada do `id_externo` inteiro, ver
    // src/contratos/evento.js) era diferente para o mesmo evento: duas linhas
    // de entrada, dois trabalhos na outbox e, com a automação ligada, DUAS
    // respostas ao mesmo paciente.
    //
    // Com `whatsapp:<id nativo>` nas duas portas, o índice único de
    // `mensagens` reconhece a segunda cópia e a descarta, não importa por onde
    // ela entrou.
    //
    // `<remetente>` no meio da chave (auditoria desta sessão, gate de
    // unicidade): o `key.id` do protocolo do WhatsApp tem entropia alta e é
    // gerado pelo dispositivo de quem manda, mas não existe garantia
    // DOCUMENTAL de unicidade global entre contas/instâncias — só a convenção
    // observada. Este sistema é single-tenant hoje (uma clínica, um número,
    // uma instância Evolution — nenhuma tabela tem coluna de tenant/instância;
    // ver db/001_inbox.sql), então não há hoje um caminho de código em que
    // duas contas dividem esta mesma tabela `mensagens`. Escopar por
    // `remetente` é a defesa disponível e SIMÉTRICA entre as duas portas
    // (a ponte do OpenClaw não recebe nome de instância Evolution para casar
    // com este) — impede colisão entre CONVERSAS mesmo no caso extremo de
    // dois `key.id` iguais de pacientes diferentes. Não resolve, por si só,
    // multi-tenant/múltiplas instâncias: isso exigiria uma coluna de escopo
    // própria (tenant_id/instancia_id) nas tabelas, migration à parte.
    //
    // O fallback (sem `id` nativo) continua carregando a origem: sem
    // identificador do canal não há como as duas portas concordarem, e fingir
    // que concordam faria mensagens DIFERENTES colidirem — perder mensagem de
    // paciente é pior que gravar duas.
    id_externo: (idNativo
      ? `whatsapp:${remetente}:${idNativo}`
      : `evolution:${remetente}|${ocorridoEm}`).slice(0, 200),
    remetente,
    nome: texto(dado.pushName).slice(0, 160) || null,
    texto: conteudo.slice(0, LIMITE_TEXTO),
    origem: 'evolution_webhook',
    ocorrido_em: ocorridoEm,
  };
}

/**
 * Migration 042 / pedido do Dr. Edson (2026-08-17): traduz o eco `fromMe:true`
 * — a equipe respondeu direto no WhatsApp Web/app, mesmo número da clínica,
 * outro dispositivo (o WhatsApp sincroniza entre os dois). Até esta mudança,
 * `normalizarEventoEvolution` descartava TODO `fromMe:true` como "eco do
 * próprio envio do CRM" — verdade só quando o envio saiu PELO CRM. Quando saiu
 * por fora, essa era exatamente a mensagem que a tela nunca mostrava.
 *
 * Devolve `null` nos mesmos casos que a função de entrada (não é
 * MESSAGES_UPSERT, é grupo, sem texto reconhecível) — só que aqui filtrando
 * o INVERSO: só processa quando `fromMe === true`.
 *
 * O `id_provedor` usa o MESMO formato (`whatsapp:<telefone>:<id nativo>`) que
 * `marcarIdProvedorDaMensagem` grava depois de um envio bem-sucedido pelo
 * CRM — é essa igualdade de string que faz `registrarMensagem` reconhecer o
 * eco de uma mensagem que o próprio CRM mandou e não duplicá-la (índice único
 * de `id_provedor`, migration 042). Sem correspondência: mensagem nova,
 * enviada por fora, registrada como tal.
 */
function normalizarEcoDeEnvioEvolution(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (!ehEventoDeMensagem(payload)) return null;

  const dado = payload.data;
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return null;
  if (dado.key?.fromMe !== true) return null; // não é o caso que esta função trata

  const paraQuem = normalizarTelefone(dado.key?.remoteJid, dado.key?.remoteJidAlt);
  if (!paraQuem) return null; // grupo, @lid sem JID alternativo, ou remoteJid sem forma reconhecível

  const conteudo = textoDaMensagem(dado.message);
  if (!conteudo) return null; // mídia sem legenda, ou outro tipo não suportado ainda

  const idNativo = texto(dado.key?.id);
  if (!idNativo) return null; // sem ID nativo não há como formar a chave de dedupe

  return {
    telefone: paraQuem,
    texto: conteudo.slice(0, LIMITE_TEXTO),
    id_provedor: `whatsapp:${paraQuem}:${idNativo}`.slice(0, 200),
  };
}

module.exports = { normalizarEventoEvolution, normalizarEcoDeEnvioEvolution };
