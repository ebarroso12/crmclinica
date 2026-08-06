'use strict';

// Redige segredos de qualquer detalhe de auditoria antes que ele seja gravado
// ou devolvido a alguém.
//
// A primeira linha de defesa é o trigger do banco (migration 017), que remove
// `senha_hash` e `totp_segredo_cifrado` do snapshot de `usuarios` na origem.
// Esta camada existe para o que o trigger não alcança: registros históricos
// anteriores à limpeza, um trigger futuro escrito errado, dados importados de
// fora, ou uma coluna nova de segredo que ninguém lembrou de listar no SQL.
//
// Por isso a decisão aqui é por NOME DE CHAVE, em qualquer profundidade, e
// nega por padrão: uma chave que pareça segredo é removida mesmo que nenhuma
// tabela atual a possua. Remoção de verdade — a chave sai do objeto, sem
// máscara, sem tamanho, sem sobra que permita reconstrução. O valor removido
// nunca é lido além do necessário para descartá-lo, e nunca é registrado.

// Chaves que são segredo onde quer que apareçam.
const CHAVES_PROIBIDAS = new Set([
  'senha_hash',
  'totp_segredo_cifrado',
  'hash_token',
  'token_recuperacao',
  'token_recuperacao_hash',
  'refresh_token',
  'refresh_token_hash',
  'session_token',
  'access_token',
  'api_key',
  'apikey',
  'secret',
  'credential',
  'private_key',
  'chave_privada',
]);

// O padrão pega o que a lista não previu. `precisa_trocar_senha` casa com
// "senha" mas é um booleano de fluxo, não um segredo — fica na exceção.
const PADRAO_DE_SEGREDO = /senha|password|passwd|token|secret|segredo|credencial|credential|api[_-]?key|private[_-]?key|chave[_-]?privada/i;
const EXCECOES = new Set(['precisa_trocar_senha']);

function chaveESensivel(chave) {
  const nome = String(chave).toLowerCase();
  if (EXCECOES.has(nome)) return false;
  return CHAVES_PROIBIDAS.has(nome) || PADRAO_DE_SEGREDO.test(nome);
}

/**
 * Devolve uma cópia do valor sem nenhuma chave sensível, em qualquer
 * profundidade. O original não é tocado.
 */
function redigirAuditoria(valor) {
  if (Array.isArray(valor)) {
    return valor.map(redigirAuditoria);
  }
  if (valor && typeof valor === 'object') {
    const limpo = {};
    for (const [chave, conteudo] of Object.entries(valor)) {
      if (chaveESensivel(chave)) continue;
      limpo[chave] = redigirAuditoria(conteudo);
    }
    return limpo;
  }
  return valor;
}

module.exports = { redigirAuditoria, chaveESensivel };
