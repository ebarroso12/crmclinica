'use strict';

const crypto = require('node:crypto');

// Proteção de dados sensíveis (CPF/RG) — P1-05.
//
// Duas necessidades opostas se resolvem com duas chaves diferentes:
//
//   guardar   — AES-256-GCM: confidencialidade + integridade. Quem lê a
//     tabela (ou vaza um backup) não lê documento de ninguém.
//   buscar    — HMAC-SHA-256 sobre os dígitos normalizados: a busca exata
//     ("este CPF já está cadastrado?") continua possível sem decifrar nada.
//
// As chaves são derivadas do segredo JWT por HKDF, com rótulos de domínio
// separados: a chave de cifra e a de busca não são a mesma, e nenhuma das
// duas é o segredo em si. Trocar o segredo troca tudo — rotação de chave é
// um projeto, não um acidente.
//
// Formato do cifrado: `v1.<iv>.<tag>.<corpo>` em base64url. O prefixo `v1`
// é a porta da rotação futura: um `v2` pode coexistir sem quebra.

const ROTULO_CIFRA = 'crmclinica/dados-sensiveis/cifra-v1';
const ROTULO_BUSCA = 'crmclinica/dados-sensiveis/busca-v1';

/** Deriva 32 bytes de chave do segredo da aplicação, com domínio próprio. */
function derivarChave(segredo, rotulo) {
  return Buffer.from(crypto.hkdfSync('sha256', String(segredo), rotulo, 'crmclinica', 32));
}

/** Cifra texto. Devolve `v1.<iv>.<tag>.<corpo>` (base64url). */
function cifrar(segredo, texto) {
  const chave = derivarChave(segredo, ROTULO_CIFRA);
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const corpo = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  return ['v1', iv.toString('base64url'), cifra.getAuthTag().toString('base64url'), corpo.toString('base64url')].join('.');
}

/**
 * Decifra. Qualquer adulteração (tag não confere) devolve `null`, nunca
 * exceção: dado sensível corrompido é ausência de dado, não motivo para
 * derrubar a requisição que só queria a ficha.
 */
function decifrar(segredo, cifrado) {
  if (typeof cifrado !== 'string' || !cifrado.startsWith('v1.')) return null;
  try {
    const [, iv, tag, corpo] = cifrado.split('.');
    const chave = derivarChave(segredo, ROTULO_CIFRA);
    const decifra = crypto.createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64url'));
    decifra.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decifra.update(Buffer.from(corpo, 'base64url')), decifra.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Documento é dígito: pontuação é apresentação, não conteúdo. */
function normalizarDocumento(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/** Hash de busca: HMAC sobre os dígitos. Determinístico, não reversível. */
function hashDeBusca(segredo, documentoNormalizado) {
  return crypto
    .createHmac('sha256', derivarChave(segredo, ROTULO_BUSCA))
    .update(documentoNormalizado)
    .digest('hex');
}

/** Validação de CPF: 11 dígitos, sem sequência repetida, dígitos verificadores. */
function cpfValido(digitos) {
  if (!/^\d{11}$/.test(digitos)) return false;
  if (/^(\d)\1{10}$/.test(digitos)) return false;

  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(digitos.slice(0, 9)) === Number(digitos[9])
    && digito(digitos.slice(0, 10)) === Number(digitos[10]);
}

/** Máscara de exibição: `***.***.**8-**` — reconhecível, não reutilizável. */
function mascararCpf(digitos) {
  const limpo = normalizarDocumento(digitos);
  if (limpo.length !== 11) return '***.***.***-**';
  return `***.***.**${limpo[8]}-**`;
}

module.exports = { cifrar, decifrar, hashDeBusca, normalizarDocumento, cpfValido, mascararCpf };
