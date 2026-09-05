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

// A regra que atende o que sobrou: casa com QUALQUER comentario. Existe
// porque "responder os posts corretamente" nao e so responder quem digitou a
// palavra certa — um comentario sem resposta e um paciente sem resposta. Ela
// e sempre a ULTIMA consultada (ver instagram-gatilhos.js): nunca rouba um
// comentario que tem gatilho proprio.
const GATILHO_TODOS = '*todos*';

function ehGatilhoDeTodos(palavraGatilho) {
  return normalizarParaComparacao(palavraGatilho) === GATILHO_TODOS;
}

/**
 * Os termos de uma palavra-gatilho, ja normalizados.
 *
 * Uma regra guarda VARIOS termos separados por virgula (ou ponto-e-virgula, ou
 * barra vertical): "agendar, agendamento, marcar". Sem isso, cobrir as
 * variacoes de uma mesma intencao exigia uma regra por palavra, cada uma com
 * sua copia da mensagem publica e da DM — e manter tres textos iguais em
 * lugares diferentes e como eles ficam diferentes.
 *
 * Termo com menos de 2 caracteres e descartado: "a" casaria com quase todo
 * comentario, e uma virgula sobrando na tela nao pode virar resposta em massa.
 */
function termosDoGatilho(palavraGatilho) {
  return String(palavraGatilho ?? '')
    .split(/[,;|]/)
    .map((termo) => normalizarParaComparacao(termo))
    .filter((termo) => termo.length >= 2);
}

// true se o comentario normalizado CONTEM (substring) qualquer um dos termos
// normalizados da palavra-gatilho. Comentario vazio ou gatilho sem nenhum
// termo aproveitavel devolve false (string vazia nunca casa com tudo).
function comentarioContemGatilho(textoComentario, palavraGatilho) {
  const comentarioNormalizado = normalizarParaComparacao(textoComentario);
  if (!comentarioNormalizado) return false;

  if (ehGatilhoDeTodos(palavraGatilho)) return true;

  const termos = termosDoGatilho(palavraGatilho);
  if (termos.length === 0) return false;

  return termos.some((termo) => comentarioNormalizado.includes(termo));
}

module.exports = {
  normalizarParaComparacao, comentarioContemGatilho, termosDoGatilho, ehGatilhoDeTodos, GATILHO_TODOS,
};
