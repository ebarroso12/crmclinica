'use strict';

// Normaliza texto para comparacao tolerante a acento/caixa: remove
// diacriticos (a->a, c-cedilha->c via decomposicao NFD + remocao de marcas
// combinantes), passa pra minuscula e tira espaco nas pontas. Nunca lanca
// para entrada nao-string/null/undefined - devolve string vazia.
function normalizarParaComparacao(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// true se a versao normalizada de textoComentario CONTEM (substring) a
// versao normalizada de palavraGatilho. Se qualquer um dos dois, depois de
// normalizado, for vazio, devolve false (string vazia nunca casa com tudo).
function comentarioContemGatilho(textoComentario, palavraGatilho) {
  const comentarioNormalizado = normalizarParaComparacao(textoComentario);
  const gatilhoNormalizado = normalizarParaComparacao(palavraGatilho);

  if (!comentarioNormalizado || !gatilhoNormalizado) {
    return false;
  }

  return comentarioNormalizado.includes(gatilhoNormalizado);
}

module.exports = { normalizarParaComparacao, comentarioContemGatilho };
