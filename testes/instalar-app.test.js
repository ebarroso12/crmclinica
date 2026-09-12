'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Instalar o CRM como app no aparelho (12/09/2026).
//
// Três coisas precisam continuar verdadeiras, e nenhuma delas dá erro visível
// quando quebra — o botão simplesmente nunca aparece, e ninguém liga o sumiço
// a uma mudança:
//
//   1. o service worker existe, é servido da RAIZ e NÃO guarda cache;
//   2. o manifesto tem o que o navegador exige para oferecer a instalação;
//   3. o HTML declara um ícone só — com dois, o Chrome prefere o SVG, e foi
//      exatamente assim que a aba continuou mostrando a marca antiga depois do
//      deploy da logomarca nova.

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const SW = fs.readFileSync(path.join(RAIZ, 'public', 'sw.js'), 'utf8');
const HTTP_JS = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'http.js'), 'utf8');
const MANIFESTO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'public', 'manifest.webmanifest'), 'utf8'));

test('o ícone da aba é declarado UMA vez, e é o PNG da logomarca', () => {
  const icones = [...HTML.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
  assert.equal(icones.length, 1, `com mais de um <link rel="icon"> o Chrome escolhe, e escolheu errado: ${icones.join(' | ')}`);
  assert.match(icones[0], /href="\/favicon\.png"/);
  assert.ok(!HTML.includes('favicon.svg'), 'o favicon antigo não pode continuar declarado');
});

test('o service worker é servido da raiz e não guarda cache', () => {
  assert.ok(
    HTTP_JS.includes("['/sw.js', ['sw.js'"),
    '/sw.js precisa estar em ARQUIVOS_PUBLICOS — servido de subpasta, o escopo não cobre o CRM',
  );

  // O projeto acabou de corrigir o "Ctrl+Shift+R": um worker que servisse do
  // cache desfaria isso, e a pessoa veria conversa de paciente desatualizada.
  assert.ok(!/caches\.open|cache\.put|cache\.match|cache\.addAll/.test(SW), 'o worker não pode guardar nada em cache');
  assert.match(SW, /respondWith\(fetch\(evento\.request\)\)/, 'o fetch precisa ser repasse puro para a rede');
  assert.match(SW, /caches\.delete/, 'o worker precisa limpar cache deixado por versões anteriores');
});

test('o manifesto tem o que o navegador exige para oferecer a instalação', () => {
  assert.equal(MANIFESTO.display, 'standalone');
  assert.equal(MANIFESTO.start_url, '/');
  assert.ok(MANIFESTO.name && MANIFESTO.short_name);
  const tamanhos = MANIFESTO.icons.map((icone) => icone.sizes);
  assert.ok(tamanhos.includes('192x192'), 'falta o ícone de 192');
  assert.ok(tamanhos.includes('512x512'), 'falta o ícone de 512');
  assert.match(HTML, /<link rel="manifest" href="\/manifest\.webmanifest">/);
});

test('o convite de instalação existe nos dois lugares e nasce escondido', () => {
  const botoes = [...HTML.matchAll(/<button[^>]*data-instalar-app[^>]*>/g)].map((m) => m[0]);
  assert.equal(botoes.length, 2, 'um na tela de entrada, um no menu');
  for (const botao of botoes) {
    assert.match(botao, /hidden/, 'o botão só aparece quando o navegador diz que dá para instalar');
  }
  assert.match(HTML, /data-instalar-ajuda/, 'o iPhone precisa da instrução, já que lá não existe o evento');
});

test('a tela registra o worker, guarda o convite e trata iPhone e app já instalado', () => {
  assert.match(APP_JS, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(APP_JS, /beforeinstallprompt/);
  assert.match(APP_JS, /evento\.preventDefault\(\)/);
  assert.match(APP_JS, /appinstalled/);
  // Convite é de uso único: reaproveitar faz o segundo clique falhar calado.
  assert.match(APP_JS, /conviteDeInstalacao = null;/);
  assert.match(APP_JS, /display-mode: standalone/, 'quem já está no app instalado não vê o convite');
  assert.match(APP_JS, /iPad\|iPhone\|iPod/, 'no iPhone o caminho é o menu Compartilhar');
});

test('"Esqueci minha senha" aparece sempre, e sem SMTP mostra o caminho que funciona', () => {
  // Antes o link sumia quando o servidor estava sem SMTP (é o caso de produção
  // hoje): quem esquecia a senha ficava sem nenhuma pista do que fazer.
  assert.ok(
    !/recuperar.*\.hidden = !opcoes\.recuperacao_por_email/.test(APP_JS),
    'o link não pode mais ser escondido pela falta de e-mail',
  );
  assert.match(APP_JS, /const semEmail = !opcoes\.recuperacao_por_email;/);

  // Sem envio, o formulário some e entra a instrução — a tela não pode oferecer
  // um "Enviar link" cujo e-mail nunca chegaria.
  assert.match(APP_JS, /campos\.hidden = semEmail/);
  assert.match(APP_JS, /aviso\.hidden = !semEmail/);
  // Campo escondido e `required` trava o envio do formulário no navegador.
  assert.match(APP_JS, /campoEmail\.required = !semEmail/);

  assert.match(HTML, /id="recuperar-sem-email"[^>]*hidden/);
  assert.match(HTML, /id="recuperar-campos"/);
  assert.match(HTML, /senha temporária/i, 'a instrução precisa dizer o caminho que existe hoje');
});
