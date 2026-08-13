'use strict';

// Comando 5, frente 12 — guardas do cartão "DESEJADO × EFETIVO" no painel
// principal da Serena. Mesma limitação de testabilidade documentada em
// testes/horario-grade-editor.test.js: sem bundler nem DOM headless neste
// projeto, a prova aqui é estrutural. O comportamento real (o que a rota
// devolve) está coberto, com HTTP de verdade, em testes/serena-http.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('o cartão desejado×efetivo existe no painel principal da Serena, junto dos outros quatro', () => {
  assert.match(HTML, /id="serena-coerencia">verificando…<\/strong>/);
  assert.match(HTML, /id="serena-coerencia-detalhe">/);
});

test('desenharEstadoDaSerena lê serena.desejado_vs_efetivo — reaproveita o dado, não recalcula', () => {
  const corpo = APP_JS.match(/function desenharEstadoDaSerena\([\s\S]*?\n\}/)?.[0];
  assert.ok(corpo, 'desenharEstadoDaSerena precisa existir');
  assert.match(corpo, /serena\.desejado_vs_efetivo/);
  // Guarda contra reimplementar a decisão no navegador: a função só LÊ os
  // campos `desejado`/`aplicado` que o servidor já calculou, não decide de
  // novo se a Serena deveria atender.
  assert.match(corpo, /coerencia\.desejado/);
  assert.match(corpo, /coerencia\.aplicado/);
});

test('sem a comparação (Arquitetura B), o cartão diz "não aplicável" — não inventa divergência nem "coerente" falso', () => {
  const corpo = APP_JS.match(/function desenharEstadoDaSerena\([\s\S]*?\n\}/)?.[0];
  assert.match(corpo, /Não aplicável/);
  assert.match(corpo, /Arquitetura B/);
});
