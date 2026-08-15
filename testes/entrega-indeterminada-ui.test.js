'use strict';

// Migration 038/Bug B, item 1: "entrega indeterminada" é um terceiro estado,
// distinto de "falhou" (entrega-nao-realizada-ui.test.js) e de uma entrega
// normal — o canal pode ter entregue ou não, ninguém sabe (timeout/queda da
// Evolution). O backend já grava `entrega_indeterminada` na própria mensagem
// (src/dados/repositorio.js, src/dominio/atendimento.js); este arquivo prova
// que `public/app.js` lê essa marca e desenha algo diferente na tela — mesmo
// padrão estrutural de entrega-nao-realizada-ui.test.js (sem DOM/jsdom neste
// repositório, a prova é ler o código-fonte e conferir o padrão).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');

test('desenharThread confere entrega_indeterminada de cada mensagem', () => {
  assert.match(APP_JS, /mensagem\.entrega_indeterminada/, 'a tela precisa ler o campo que o backend agora grava');
});

test('mensagem com entrega_indeterminada ganha classe própria, distinta de "nao-entregue"', () => {
  assert.match(APP_JS, /entrega_indeterminada[\s\S]{0,120}classList\.add\(['"]entrega-incerta['"]\)/,
    'precisa marcar visualmente — e não pode reusar a classe de "não entregue", que afirma algo mais forte');
});

test('o aviso de entrega incerta aparece como texto na mensagem, não só como cor', () => {
  assert.match(APP_JS, /entrega incerta/i, 'precisa haver um texto explícito de "entrega incerta"');
});

test('entrega_indeterminada nunca aparece junto com o aviso de "não entregue" na mesma mensagem', () => {
  // São dois estados distintos e não podem ser desenhados como se fossem o
  // mesmo aviso — "não entregue" afirma uma certeza que "indeterminada" não tem.
  assert.match(APP_JS, /entrega_falhou\)\s*\{[\s\S]{0,400}\}\s*else if\s*\(mensagem\.entrega_indeterminada\)/,
    'o aviso de entrega incerta precisa ser um "else if" do aviso de falha, não um bloco independente que possa somar os dois');
});

test('a classe .entrega-incerta tem estilo próprio em estilo.css — não é uma classe sem efeito', () => {
  assert.match(CSS, /\.entrega-incerta/, 'a classe usada em app.js precisa ter uma regra correspondente no CSS');
});
