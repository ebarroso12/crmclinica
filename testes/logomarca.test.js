'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Logomarca da clínica (12/09/2026): a mesma marca na barra do navegador, no
// menu, na tela de entrada e no ícone do app instalado.
//
// O arranjo tem duas maneiras silenciosas de quebrar: um arquivo que some do
// public/ (a tela mostra o ícone quebrado e ninguém liga o defeito ao deploy) e
// um arquivo que existe mas não está na lista fechada de ARQUIVOS_PUBLICOS do
// servidor — aí ele funciona na Vercel, que serve o public/ inteiro, e dá 404
// no servidor Node do VPS. Este teste tranca as duas.

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const HTTP_JS = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'http.js'), 'utf8');
const MANIFESTO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'public', 'manifest.webmanifest'), 'utf8'));

const ARQUIVOS = [
  'favicon.png',
  'marca-crmclinica.png',
  'logo-crmclinica.png',
  'apple-touch-icon.png',
  'icone-512.png',
  'manifest.webmanifest',
];

test('todo arquivo da logomarca existe em public/ e não está vazio', () => {
  for (const arquivo of ARQUIVOS) {
    const caminho = path.join(RAIZ, 'public', arquivo);
    assert.ok(fs.existsSync(caminho), `public/${arquivo} precisa existir`);
    assert.ok(fs.statSync(caminho).size > 512, `public/${arquivo} está vazio ou truncado`);
  }
});

test('o servidor serve cada um deles (lista fechada de ARQUIVOS_PUBLICOS)', () => {
  for (const arquivo of ARQUIVOS) {
    assert.ok(
      HTTP_JS.includes(`['/${arquivo}', ['${arquivo}'`),
      `/${arquivo} precisa estar em ARQUIVOS_PUBLICOS — senão dá 404 fora da Vercel`,
    );
  }
});

test('a tela declara ícone, ícone do iPhone e manifesto', () => {
  assert.match(HTML, /<link rel="icon" href="\/favicon\.png" type="image\/png"/);
  assert.match(HTML, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(HTML, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(HTML, /<meta name="theme-color" content="#0d1930">/);
});

test('a marca aparece no menu e na tela de entrada, com texto alternativo coerente', () => {
  // No menu o nome está escrito ao lado, então a imagem é decorativa (alt="");
  // na entrada ela É o nome, e precisa ser lida por quem usa leitor de tela.
  assert.match(HTML, /<img class="marca-icone" src="\/marca-crmclinica\.png"[^>]*alt="">/);
  assert.match(HTML, /<img class="logo-entrada" src="\/logo-crmclinica\.png"[\s\S]{0,120}alt="CRM Clínica — Dr\. Edson Barroso">/);
});

test('o manifesto aponta só para ícones que existem', () => {
  assert.ok(MANIFESTO.icons.length >= 2);
  for (const icone of MANIFESTO.icons) {
    const arquivo = icone.src.replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(RAIZ, 'public', arquivo)), `manifesto aponta para ${icone.src}, que não existe`);
  }
  assert.equal(MANIFESTO.start_url, '/');
  assert.ok(MANIFESTO.icons.some((icone) => icone.purpose === 'maskable'), 'o ícone do app precisa de versão maskable');
});
