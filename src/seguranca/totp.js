'use strict';

const crypto = require('node:crypto');

// Segundo fator por token temporário (TOTP, RFC 6238) — o código de 6 dígitos que
// o Google Authenticator e afins mostram. Implementado sobre o `crypto` do Node:
// são ~80 linhas e evitam mais uma dependência no caminho de autenticação.

const DIGITOS = 6;
const PASSO_SEGUNDOS = 30;
// Aceita o código do passo anterior e do seguinte: relógio de celular atrasa,
// e recusar por 2 segundos de diferença só ensina a pessoa a odiar o 2FA.
const TOLERANCIA_PASSOS = 1;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function paraBase32(bytes) {
  let bits = 0;
  let valor = 0;
  let saida = '';

  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];

  return saida;
}

function deBase32(texto) {
  const limpo = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];

  for (const caractere of limpo) {
    const indice = ALFABETO_BASE32.indexOf(caractere);
    if (indice === -1) continue;
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Gera um segredo novo, em base32, pronto para o aplicativo autenticador. */
function gerarSegredo() {
  return paraBase32(crypto.randomBytes(20));
}

function calcularCodigo(segredoBase32, contador) {
  const chave = deBase32(segredoBase32);

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(contador));

  const digest = crypto.createHmac('sha1', chave).update(buffer).digest();
  const deslocamento = digest[digest.length - 1] & 0x0f;
  const binario = ((digest[deslocamento] & 0x7f) << 24)
    | ((digest[deslocamento + 1] & 0xff) << 16)
    | ((digest[deslocamento + 2] & 0xff) << 8)
    | (digest[deslocamento + 3] & 0xff);

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

/** Código válido para o instante informado. Útil para testes e para exibir. */
function gerarCodigo(segredoBase32, agora = Date.now()) {
  return calcularCodigo(segredoBase32, Math.floor(agora / 1000 / PASSO_SEGUNDOS));
}

/**
 * Confere o código digitado, aceitando a janela de tolerância.
 * Comparação em tempo constante — o código é curto, e comparar caractere a
 * caractere entregaria dígitos por diferença de tempo.
 */
function conferirCodigo(segredoBase32, codigoDigitado, agora = Date.now()) {
  const limpo = String(codigoDigitado || '').replace(/\D/g, '');
  if (limpo.length !== DIGITOS || !segredoBase32) return false;

  const passoAtual = Math.floor(agora / 1000 / PASSO_SEGUNDOS);
  const recebido = Buffer.from(limpo, 'utf8');

  for (let deslocamento = -TOLERANCIA_PASSOS; deslocamento <= TOLERANCIA_PASSOS; deslocamento += 1) {
    const esperado = Buffer.from(calcularCodigo(segredoBase32, passoAtual + deslocamento), 'utf8');
    if (esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido)) return true;
  }
  return false;
}

/** URI que o aplicativo autenticador lê (por QR ou digitação). */
function montarUri(segredoBase32, email, emissor = 'crmclinica') {
  const rotulo = encodeURIComponent(`${emissor}:${email}`);
  const parametros = new URLSearchParams({
    secret: segredoBase32,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_SEGUNDOS),
  });
  return `otpauth://totp/${rotulo}?${parametros}`;
}

// --- Cifra do segredo em repouso ---
//
// O segredo do TOTP precisa ser recuperável para gerar códigos, então não pode ser
// hash. Fica cifrado com AES-256-GCM, com chave derivada do segredo de assinatura
// da aplicação: quem lê a tabela sem ter a chave não consegue gerar código nenhum.

function derivarChave(segredoDaAplicacao) {
  return crypto.createHash('sha256').update(`totp:${segredoDaAplicacao}`).digest();
}

function cifrarSegredo(segredoBase32, segredoDaAplicacao) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', derivarChave(segredoDaAplicacao), iv);
  const conteudo = Buffer.concat([cifra.update(segredoBase32, 'utf8'), cifra.final()]);

  return `v1.${iv.toString('base64url')}.${cifra.getAuthTag().toString('base64url')}.${conteudo.toString('base64url')}`;
}

function decifrarSegredo(cifrado, segredoDaAplicacao) {
  if (typeof cifrado !== 'string') return null;

  const partes = cifrado.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;

  try {
    const decifra = crypto.createDecipheriv(
      'aes-256-gcm',
      derivarChave(segredoDaAplicacao),
      Buffer.from(partes[1], 'base64url'),
    );
    decifra.setAuthTag(Buffer.from(partes[2], 'base64url'));
    return Buffer.concat([
      decifra.update(Buffer.from(partes[3], 'base64url')),
      decifra.final(),
    ]).toString('utf8');
  } catch {
    // Chave trocada ou conteúdo adulterado: o segundo fator simplesmente não confere.
    return null;
  }
}

module.exports = {
  DIGITOS,
  PASSO_SEGUNDOS,
  gerarSegredo,
  gerarCodigo,
  conferirCodigo,
  montarUri,
  cifrarSegredo,
  decifrarSegredo,
};
