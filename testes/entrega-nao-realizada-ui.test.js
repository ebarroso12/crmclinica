'use strict';

// Comando 7, achado A-3 (segunda parte): a mensagem que a automação gerou e a
// barreira final bloqueou ficava indistinguível, na tela, de uma resposta que
// saiu normal. `src/dominio/atendimento.js` agora grava `entrega_falhou` /
// `entrega_falhou_motivo` na própria mensagem (ver testes/repositorio.test.js
// e testes/atendimento-barreira-controle.test.js); este arquivo prova que
// `public/app.js` lê essa marca e desenha algo diferente na tela — sem DOM
// nenhum disponível nos testes deste repositório (`node --test`, sem jsdom),
// a prova é estrutural: lê o código-fonte e confere o padrão, mesmo estilo
// já usado por testes/botoes-orfaos.test.js e testes/canal-evolution-editor.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');

test('desenharThread confere entrega_falhou de cada mensagem', () => {
  assert.match(APP_JS, /mensagem\.entrega_falhou/, 'a tela precisa ler o campo que o backend agora grava');
});

test('mensagem com entrega_falhou ganha uma classe própria, distinta de "enviada"/"recebida"', () => {
  assert.match(APP_JS, /entrega_falhou[\s\S]{0,120}classList\.add\(['"]nao-entregue['"]\)/,
    'precisa marcar visualmente — não basta saber internamente que falhou');
});

test('o aviso de não entrega aparece como texto na mensagem, não só como cor', () => {
  // Cor sozinha falha para quem não distingue cor (e falha em preto-e-branco
  // de qualquer print/export) — o aviso tem que existir como texto lido.
  assert.match(APP_JS, /não entregue/i, 'precisa haver um texto explícito de "não entregue"');
});

test('a classe .nao-entregue tem estilo próprio em estilo.css — não é uma classe sem efeito', () => {
  assert.match(CSS, /\.nao-entregue/, 'a classe usada em app.js precisa ter uma regra correspondente no CSS');
});
