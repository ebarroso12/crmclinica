'use strict';

const crypto = require('node:crypto');

// JWT HS256 implementado sobre o `crypto` do Node. São ~60 linhas e evitam
// arrastar uma dependência para dentro do caminho de autenticação.
//
// O access token é curto e auto-contido: quem o valida não consulta o banco.
// A revogação mora no refresh token, que é opaco e guardado — ver `sessoes.js`.

function base64url(dados) {
  return Buffer.from(dados).toString('base64url');
}

function assinar(cabecalhoEPayload, segredo) {
  return crypto.createHmac('sha256', segredo).update(cabecalhoEPayload).digest('base64url');
}

/**
 * Emite um token assinado.
 * @param {object} conteudo reivindicações do token
 * @param {string} segredo chave HMAC
 * @param {number} duracaoSegundos validade a partir de agora
 */
function emitir(conteudo, segredo, duracaoSegundos) {
  if (!segredo) throw new Error('segredo de assinatura ausente');

  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    ...conteudo,
    iat: agora,
    exp: agora + duracaoSegundos,
  }));

  return `${cabecalho}.${payload}.${assinar(`${cabecalho}.${payload}`, segredo)}`;
}

/**
 * Verifica assinatura e validade.
 * Devolve `{ valido, conteudo, motivo }` em vez de lançar: token inválido é
 * situação esperada num endpoint público, não excepcional.
 */
function verificar(token, segredo) {
  if (typeof token !== 'string' || !segredo) return { valido: false, motivo: 'ausente' };

  const partes = token.split('.');
  if (partes.length !== 3) return { valido: false, motivo: 'formato' };

  const [cabecalho, payload, assinaturaRecebida] = partes;

  // O algoritmo vem do nosso lado, nunca do cabeçalho do token: aceitar `alg`
  // do próprio token é o que abre a porta para `alg: none` e para confusão de chave.
  const esperada = assinar(`${cabecalho}.${payload}`, segredo);
  const recebida = Buffer.from(assinaturaRecebida, 'utf8');
  const referencia = Buffer.from(esperada, 'utf8');
  if (recebida.length !== referencia.length || !crypto.timingSafeEqual(recebida, referencia)) {
    return { valido: false, motivo: 'assinatura' };
  }

  let conteudo;
  try {
    conteudo = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { valido: false, motivo: 'payload' };
  }

  const agora = Math.floor(Date.now() / 1000);
  if (typeof conteudo.exp !== 'number' || conteudo.exp <= agora) {
    return { valido: false, motivo: 'expirado' };
  }

  return { valido: true, conteudo };
}

module.exports = { emitir, verificar };
