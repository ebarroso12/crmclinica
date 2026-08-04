'use strict';

const crypto = require('node:crypto');
const { emitir, verificar } = require('../seguranca/jwt');

const PAPEIS_DE_TURNO = Object.freeze(['usuario', 'serena']);
const LIMITE_TRANSCRICAO = 8000;

class ErroDaVoz extends Error {
  constructor(mensagem, codigo = 'serena_voz_invalida', status = 400) {
    super(mensagem);
    this.name = 'ErroDaVoz';
    this.codigo = codigo;
    this.status = status;
  }
}

function emitirTokenDeVoz({ sessaoId, usuarioId, segredo, duracaoSegundos }) {
  return emitir({
    typ: 'serena_voz',
    aud: 'serena-voz-gateway',
    sid: String(sessaoId),
    sub: String(usuarioId),
    jti: crypto.randomUUID(),
  }, segredo, duracaoSegundos);
}

function verificarTokenDeVoz(token, segredo) {
  const resultado = verificar(token, segredo);
  if (!resultado.valido) return resultado;
  const conteudo = resultado.conteudo;
  if (conteudo.typ !== 'serena_voz' || conteudo.aud !== 'serena-voz-gateway'
      || typeof conteudo.sid !== 'string' || !/^\w[\w-]{7,80}$/.test(conteudo.sid)) {
    return { valido: false, motivo: 'escopo' };
  }
  return resultado;
}

function assinaturaDeEvento(corpoBruto, instante, segredo) {
  return crypto.createHmac('sha256', segredo)
    .update(`${instante}.${Buffer.isBuffer(corpoBruto) ? corpoBruto.toString('utf8') : corpoBruto}`)
    .digest('hex');
}

function assinaturaDeEventoValida({ corpoBruto, instante, recebida, segredo, agora = Date.now() }) {
  if (!segredo || typeof recebida !== 'string' || typeof instante !== 'string') return false;
  const timestamp = Number(instante);
  if (!Number.isInteger(timestamp) || Math.abs(agora - timestamp * 1000) > 5 * 60 * 1000) return false;

  const limpa = recebida.startsWith('sha256=') ? recebida.slice(7) : recebida;
  const esperada = assinaturaDeEvento(corpoBruto, instante, segredo);
  const a = Buffer.from(limpa, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validarEventoDeTranscricao(evento = {}) {
  const id = String(evento.event_id ?? '').trim();
  const sessaoId = String(evento.session_id ?? '').trim();
  const papel = String(evento.role ?? '').trim();
  const transcricao = String(evento.transcript ?? '').trim();

  if (!/^[\w:-]{8,160}$/.test(id)) throw new ErroDaVoz('event_id inválido', 'evento_invalido');
  if (!/^\w[\w-]{7,80}$/.test(sessaoId)) throw new ErroDaVoz('session_id inválido', 'sessao_invalida');
  if (!PAPEIS_DE_TURNO.includes(papel)) throw new ErroDaVoz('role inválido', 'papel_invalido');
  if (!transcricao || transcricao.length > LIMITE_TRANSCRICAO) {
    throw new ErroDaVoz(`transcrição deve ter entre 1 e ${LIMITE_TRANSCRICAO} caracteres`, 'transcricao_invalida');
  }

  const ocorridoEm = evento.occurred_at ? new Date(evento.occurred_at) : new Date();
  if (Number.isNaN(ocorridoEm.getTime())) throw new ErroDaVoz('occurred_at inválido', 'data_invalida');

  return {
    chaveIdempotencia: id,
    sessaoId,
    papel,
    transcricao,
    ocorridoEm,
  };
}

module.exports = {
  ErroDaVoz,
  LIMITE_TRANSCRICAO,
  emitirTokenDeVoz,
  verificarTokenDeVoz,
  assinaturaDeEvento,
  assinaturaDeEventoValida,
  validarEventoDeTranscricao,
};
