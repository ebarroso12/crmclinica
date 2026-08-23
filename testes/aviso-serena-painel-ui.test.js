'use strict';

// Auditoria de 22/08 (horários/ativação da Serena) + revisão de UX
// independente sobre o próprio fix. Sem DOM disponível nesta suíte
// (`node --test`, sem jsdom), a prova é estrutural — mesmo padrão de
// testes/botoes-orfaos.test.js e testes/entrega-nao-realizada-ui.test.js:
// lê o código-fonte e confere o padrão esperado.
//
// Quatro achados, nesta ordem:
//   1. carregarResumo() lia resumo.atendimento?.serena — caminho inexistente
//      (montarResumo em src/dominio/resumo.js aninha em plataforma.serena).
//      O banner #aviso-serena nunca aparecia.
//   2. #estado-serena tinha duas donas (carregarResumo + desenharEstadoDaSerena)
//      escrevendo valores conflitantes; a pílula real da tela Serena.
//   3. [revisão de UX] #aviso-serena é role="alert" (aria-live assertivo) e o
//      texto mudava a cada poll de 60s ("há N min") — interrompia o leitor de
//      tela a cada minuto durante toda queda da automação.
//   4. [revisão de UX] falha no poll de /api/resumo deixava o banner congelado
//      sem indicar que o dado podia estar desatualizado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function corpoDeCarregarResumo() {
  const inicio = APP_JS.indexOf('async function carregarResumo()');
  assert.ok(inicio >= 0, 'carregarResumo precisa existir em public/app.js');
  // A próxima função top-level começa a linha seguinte ao fechamento do bloco
  // anterior; como não há parser aqui, corta num ponto generoso depois do
  // fim já confirmado por outros testes (a função é bem menor que isso).
  return APP_JS.slice(inicio, inicio + 4000);
}

test('o banner lê resumo.plataforma?.serena, não o caminho antigo resumo.atendimento?.serena', () => {
  const corpo = corpoDeCarregarResumo();
  assert.match(corpo, /resumo\.plataforma\?\.serena/, 'precisa ler do caminho real que montarResumo produz');
  assert.doesNotMatch(corpo, /resumo\.atendimento\?\.serena/, 'o caminho antigo (sempre undefined) não pode voltar');
});

test('#aviso-serena existe no HTML como role="alert"', () => {
  assert.match(HTML, /id="aviso-serena"[^>]*role="alert"/, 'o banner precisa continuar anunciado ao leitor de tela');
});

test('#estado-serena tem uma dona só: carregarResumo não escreve nele', () => {
  const corpo = corpoDeCarregarResumo();
  // Verifica o seletor de verdade (string entre aspas, como usado em
  // chamadas de `seletor(...)`) — não a substring solta, que também aparece
  // num comentário explicando por que a escrita foi removida daqui.
  assert.doesNotMatch(corpo, /['"]#estado-serena['"]/, 'a pílula pertence só a desenharEstadoDaSerena');

  // E a outra função continua sendo a dona de fato.
  const doDesenhar = APP_JS.indexOf('function desenharEstadoDaSerena');
  assert.ok(doDesenhar >= 0);
  assert.match(APP_JS.slice(doDesenhar, doDesenhar + 3000), /['"]#estado-serena['"]/);
});

test('o texto do banner só é reescrito numa transição de estado, não em todo poll', () => {
  // Achado da revisão de UX: reescrever a cada poll (60s) faz o leitor de
  // tela reanunciar role="alert" sem parar durante toda a queda. A guarda
  // por transição de estado é o que evita isso.
  const corpo = corpoDeCarregarResumo();
  assert.match(corpo, /serenaAvisoUltimoEstado/, 'precisa rastrear o último estado observado entre polls');
  assert.match(corpo, /mudouDeEstado/, 'a reescrita do texto precisa estar condicionada à mudança de estado');
});

test('falha no poll marca o banner como possivelmente desatualizado, não o deixa congelado em silêncio', () => {
  const inicioCatch = APP_JS.indexOf('} catch {', APP_JS.indexOf('async function carregarResumo()'));
  assert.ok(inicioCatch >= 0, 'carregarResumo precisa ter um catch');
  const corpoCatch = APP_JS.slice(inicioCatch, inicioCatch + 800);

  assert.match(corpoCatch, /serenaAvisoDadosDesatualizados/, 'o catch precisa marcar o dado como desatualizado');
  assert.match(corpoCatch, /desatualizado/i, 'precisa haver um aviso textual, não só um estado interno');
});
