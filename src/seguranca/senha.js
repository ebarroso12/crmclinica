'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

// Hash de senha com scrypt, que vem no próprio Node — sem dependência de terceiros
// para algo tão sensível. scrypt é resistente a GPU por exigir memória, o que é
// justamente o que falta em SHA-2 e PBKDF2.

const scrypt = promisify(crypto.scrypt);

// Custo padrão do scrypt. N=16384 mantém o login abaixo de ~100 ms
// numa máquina modesta e ainda torna força bruta cara.
const PARAMETROS = Object.freeze({ N: 16384, r: 8, p: 1, tamanhoChave: 64, tamanhoSal: 16 });

/**
 * Gera o hash de uma senha.
 * Formato: `scrypt$N$r$p$sal$hash`, tudo em hexadecimal — os parâmetros viajam
 * junto para que aumentar o custo no futuro não invalide as senhas antigas.
 */
async function gerarHash(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw new Error('a senha precisa ter ao menos 8 caracteres');
  }

  const { N, r, p, tamanhoChave, tamanhoSal } = PARAMETROS;
  const sal = crypto.randomBytes(tamanhoSal);
  const derivada = await scrypt(senha, sal, tamanhoChave, { N, r, p });

  return `scrypt$${N}$${r}$${p}$${sal.toString('hex')}$${derivada.toString('hex')}`;
}

/**
 * Confere a senha contra o hash guardado.
 * Comparação em tempo constante; qualquer formato inesperado devolve `false`
 * em vez de lançar — falha de verificação não deve virar erro de servidor.
 */
async function conferir(senha, hashGuardado) {
  if (typeof senha !== 'string' || typeof hashGuardado !== 'string') return false;

  const partes = hashGuardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, N, r, p, salHex, esperadoHex] = partes;
  try {
    const sal = Buffer.from(salHex, 'hex');
    const esperado = Buffer.from(esperadoHex, 'hex');
    const derivada = await scrypt(senha, sal, esperado.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(esperado, derivada);
  } catch {
    return false;
  }
}

module.exports = { gerarHash, conferir, PARAMETROS };
