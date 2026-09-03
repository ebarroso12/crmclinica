'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizarParaComparacao,
  comentarioContemGatilho,
} = require('../src/dominio/texto-normalizado.js');

test('normalizarParaComparacao: "avaliacao" e "avaliação" normalizam pro mesmo valor', () => {
  assert.equal(
    normalizarParaComparacao('avaliação'),
    normalizarParaComparacao('avaliacao')
  );
});

test('normalizarParaComparacao: caixa alta/baixa/mista normalizam igual', () => {
  const esperado = normalizarParaComparacao('avaliação');
  assert.equal(normalizarParaComparacao('AVALIAÇÃO'), esperado);
  assert.equal(normalizarParaComparacao('Avaliação'), esperado);
  assert.equal(normalizarParaComparacao('avaliação'), esperado);
});

test('normalizarParaComparacao: "ç" isolado normaliza pra "c"', () => {
  assert.equal(normalizarParaComparacao('ç'), 'c');
});

test('normalizarParaComparacao: "Ç" isolado normaliza pra "c"', () => {
  assert.equal(normalizarParaComparacao('Ç'), 'c');
});

test('comentarioContemGatilho: substring no meio do comentario, com acento igual', () => {
  assert.equal(
    comentarioContemGatilho('adorei, quero fazer esta avaliação já', 'avaliação'),
    true
  );
});

test('comentarioContemGatilho: caixa alta E sem acento ao mesmo tempo no comentario', () => {
  assert.equal(
    comentarioContemGatilho('ADOREI QUERO FAZER ESTA AVALIACAO JA', 'avaliação'),
    true
  );
});

test('comentarioContemGatilho: comentario sem a palavra-gatilho nao pode dar falso positivo', () => {
  assert.equal(
    comentarioContemGatilho('muito bom o atendimento', 'avaliação'),
    false
  );
});

test('comentarioContemGatilho: comentario vazio nunca casa', () => {
  assert.equal(comentarioContemGatilho('', 'avaliação'), false);
});

test('comentarioContemGatilho: gatilho vazio nunca casa com tudo', () => {
  assert.equal(comentarioContemGatilho('oi', ''), false);
});

test('normalizarParaComparacao: null e undefined devolvem string vazia sem lancar', () => {
  assert.doesNotThrow(() => normalizarParaComparacao(null));
  assert.doesNotThrow(() => normalizarParaComparacao(undefined));
  assert.equal(normalizarParaComparacao(null), '');
  assert.equal(normalizarParaComparacao(undefined), '');
});

test('normalizarParaComparacao: outros acentos comuns em portugues', () => {
  assert.equal(normalizarParaComparacao('á'), 'a');
  assert.equal(normalizarParaComparacao('à'), 'a');
  assert.equal(normalizarParaComparacao('ã'), 'a');
  assert.equal(normalizarParaComparacao('â'), 'a');
  assert.equal(normalizarParaComparacao('é'), 'e');
  assert.equal(normalizarParaComparacao('ê'), 'e');
  assert.equal(normalizarParaComparacao('í'), 'i');
  assert.equal(normalizarParaComparacao('ó'), 'o');
  assert.equal(normalizarParaComparacao('ô'), 'o');
  assert.equal(normalizarParaComparacao('õ'), 'o');
  assert.equal(normalizarParaComparacao('ú'), 'u');
});
