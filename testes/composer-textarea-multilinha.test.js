'use strict';

// Item 5 do tarefário (decisão do Edson): campo de resposta trocado de
// <input> de uma linha para <textarea> multi-linha — Shift+Enter quebra
// linha, Enter sozinho envia.
//
// <textarea>, ao contrário de <input>, NÃO dispara submit do form no Enter
// sozinho — sem o handler novo, Enter viraria só quebra de linha e a
// mensagem nunca seria enviada por teclado (só pelo botão). Este teste
// prova o handler real de public/app.js, extraído e executado em vm com
// document/evento fake — não é E2E de teclado de verdade (sem browser/jsdom
// neste repositório, mesmo padrão dos outros testes de UI aqui: a prova é
// executar o trecho real do arquivo-fonte, não reimplementar a lógica).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CAMINHO_HTML = path.join(__dirname, '..', 'public', 'index.html');
const CAMINHO_APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const HTML = fs.readFileSync(CAMINHO_HTML, 'utf8');
const APP_JS = fs.readFileSync(CAMINHO_APP_JS, 'utf8');

test('index.html usa <textarea> para o campo de resposta, não <input>', () => {
  assert.match(HTML, /<textarea id="resposta"[^>]*><\/textarea>/,
    'campo #resposta precisa ser <textarea> multi-linha, não <input> de uma linha');
  assert.doesNotMatch(HTML, /<input id="resposta"/,
    '<input id="resposta"> antigo não pode mais existir — teria dois campos com o mesmo id');
});

/**
 * Extrai o listener 'keydown' real de #resposta e executa em vm, com
 * document/evento fake. Devolve { preveniu, submeteu } para o cenário dado.
 */
function executarHandlerKeydown({ tecla, comShift }) {
  const trechoSeletor = APP_JS.match(/const seletor = \(alvo\) => document\.querySelector\(alvo\);/);
  assert.ok(trechoSeletor, 'função seletor() precisa existir em app.js, formato inesperado');

  const trechoHandler = APP_JS.match(
    /seletor\('#resposta'\)\?\.addEventListener\('keydown', \(evento\) => \{[\s\S]*?\n\}\);/,
  );
  assert.ok(trechoHandler, 'listener keydown de #resposta não encontrado em app.js — handler foi removido ou renomeado?');

  let submeteu = false;
  const formFake = { requestSubmit: () => { submeteu = true; } };
  const registrados = [];
  const campoFake = { addEventListener: (tipo, cb) => registrados.push([tipo, cb]) };
  const documentFake = {
    querySelector: (alvoCss) => {
      if (alvoCss === '#resposta') return campoFake;
      if (alvoCss === '#form-resposta') return formFake;
      return null;
    },
  };

  let preveniu = false;
  const eventoFake = { key: tecla, shiftKey: comShift, preventDefault: () => { preveniu = true; } };

  const contexto = { document: documentFake, console };
  vm.createContext(contexto);
  vm.runInContext(`${trechoSeletor[0]}\n${trechoHandler[0]}`, contexto);

  const par = registrados.find(([tipo]) => tipo === 'keydown');
  assert.ok(par, 'addEventListener("keydown", ...) precisa ter sido chamado em #resposta');
  par[1](eventoFake);

  return { preveniu, submeteu };
}

test('Enter sozinho: previne quebra de linha padrão e envia o form', () => {
  const { preveniu, submeteu } = executarHandlerKeydown({ tecla: 'Enter', comShift: false });
  assert.equal(preveniu, true, 'Enter sozinho precisa chamar preventDefault (senão vira quebra de linha, não envio)');
  assert.equal(submeteu, true, 'Enter sozinho precisa chamar requestSubmit no form');
});

test('Shift+Enter: não previne, não envia — deixa quebrar linha normalmente', () => {
  const { preveniu, submeteu } = executarHandlerKeydown({ tecla: 'Enter', comShift: true });
  assert.equal(preveniu, false, 'Shift+Enter não pode chamar preventDefault — precisa quebrar linha nativamente');
  assert.equal(submeteu, false, 'Shift+Enter não pode enviar o form');
});

test('outras teclas (ex: "a") não acionam preventDefault nem submit', () => {
  const { preveniu, submeteu } = executarHandlerKeydown({ tecla: 'a', comShift: false });
  assert.equal(preveniu, false);
  assert.equal(submeteu, false);
});
