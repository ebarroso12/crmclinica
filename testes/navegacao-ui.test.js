'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Navegação lateral (12/09/2026): os ícones do menu deixaram de ser caracteres
// soltos (▦ ◌ ⌁ …) e passaram a sair de um sprite SVG no próprio HTML.
//
// A armadilha desse arranjo é silenciosa: um <use href="#i-nao-existe"> não dá
// erro nenhum — o item simplesmente aparece sem ícone, e ninguém descobre até
// alguém olhar a tela. Estes testes existem para isso.

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
// Comentário não é marcação: o próprio comentário do sprite cita um
// `<use href="#i-...">` de exemplo, e sem isto ele entraria na conta.
const MARCACAO = HTML.replace(/<!--[\s\S]*?-->/g, '');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'public', 'estilo.css'), 'utf8');

function simbolosDoSprite() {
  const sprite = HTML.slice(
    HTML.indexOf('<svg class="sprite-icones"'),
    HTML.indexOf('</svg>', HTML.indexOf('<svg class="sprite-icones"')),
  );
  assert.ok(sprite.length > 0, 'o sprite de ícones precisa existir no HTML');
  return new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
}

test('todo <use> da tela aponta para um símbolo que existe no sprite', () => {
  const simbolos = simbolosDoSprite();
  const usados = [...MARCACAO.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]);

  assert.ok(usados.length >= 13, `esperava os itens do menu usando o sprite, achei ${usados.length}`);
  for (const id of usados) {
    assert.ok(simbolos.has(id), `<use href="#${id}"> não tem símbolo correspondente no sprite`);
  }
});

test('o ícone que app.js cria para cada agente também existe no sprite', () => {
  const simbolos = simbolosDoSprite();
  const usados = [...APP_JS.matchAll(/setAttribute\('href', '#([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(usados.length >= 1, 'desenharMenuDeAgentes precisa montar o ícone pelo sprite');
  for (const id of usados) {
    assert.ok(simbolos.has(id), `app.js referencia #${id}, que não está no sprite`);
  }
});

test('o ícone do menu é criado no namespace SVG (createElement puro não desenha nada)', () => {
  const inicio = APP_JS.indexOf('function desenharMenuDeAgentes(');
  assert.ok(inicio >= 0);
  const fim = APP_JS.indexOf('\nfunction ', inicio + 1);
  const funcao = APP_JS.slice(inicio, fim < 0 ? undefined : fim);

  assert.match(funcao, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/);
  assert.match(funcao, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'use'\)/);
  assert.doesNotMatch(funcao, /createElement\('svg'\)/, 'svg fora do namespace não renderiza');
});

test('o sprite fica fora da tela e o traço vem do CSS, não só do atributo do sprite', () => {
  assert.match(CSS, /\.sprite-icones \{ display: none; \}/);
  // O conteúdo clonado pelo <use> herda do svg que o contém — se fill/stroke
  // ficassem só no sprite, cada forma fechada viria preta.
  const regra = CSS.slice(CSS.indexOf('.icone-menu {'), CSS.indexOf('}', CSS.indexOf('.icone-menu {')));
  assert.match(regra, /fill: none;/);
  assert.match(regra, /stroke: currentColor;/);
});

test('a lateral acompanha a rolagem e o menu rola por dentro, para a parada não sair da vista', () => {
  const trecho = CSS.slice(CSS.indexOf('@media (min-width: 981px) {'));
  assert.match(trecho, /\.lateral \{[\s\S]{0,200}position: sticky;/);
  assert.match(trecho, /\.lateral nav \{[\s\S]{0,200}overflow-y: auto;/);
});
