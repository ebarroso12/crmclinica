'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Tema claro / escuro / seguir o sistema (12/09/2026).
//
// O erro clássico de tema escuro não é escolher cor feia: é uma cor ter a sua
// ÚNICA definição dentro do bloco escuro. Aí, no tema claro, aquela regra
// simplesmente não existe — e a tela mistura texto de um tema com fundo do
// outro. Estes testes trancam a estrutura que evita isso.

const RAIZ = path.join(__dirname, '..');
// Os arquivos do projeto são gravados com CRLF; comparar com "\n" não casaria.
const semCrLf = (arquivo) => fs
  .readFileSync(path.join(RAIZ, 'public', arquivo), 'utf8')
  .split('\r\n')
  .join('\n');

const CSS = semCrLf('estilo.css');
const APP_JS = semCrLf('app.js');
const HTML = semCrLf('index.html');
/** Os tokens declarados dentro de um bloco (`:root { ... }`, por exemplo). */
function tokensDe(inicioDoBloco) {
  const inicio = CSS.indexOf(inicioDoBloco);
  assert.ok(inicio >= 0, `o CSS precisa ter o bloco ${inicioDoBloco}`);
  const bloco = CSS.slice(inicio, CSS.indexOf('}', inicio));
  return new Set([...bloco.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
}

test('todo token do tema escuro existe também no claro', () => {
  const claro = tokensDe(':root {\n  color-scheme: light;');
  const escuro = tokensDe(':root[data-tema="escuro"] {');

  for (const token of escuro) {
    if (token === '--sombra') continue; // redefinida, e declarada no :root também
    assert.ok(claro.has(token), `${token} só existe no tema escuro — no claro a regra não aplicaria`);
  }
  assert.ok(escuro.size >= 10, 'o tema escuro precisa redefinir o conjunto, não uma cor solta');
});

test('nenhum token se define a partir de si mesmo', () => {
  // `--superficie: var(--superficie)` é referência circular: o navegador
  // descarta a declaração inteira e a tela fica sem aquela cor. Aconteceu de
  // verdade ao converter as cores literais em token.
  for (const [, nome, valor] of CSS.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    assert.ok(!valor.includes(`var(${nome})`), `${nome} referencia a si mesmo`);
  }
});

test('quem escolheu claro à mão continua no claro, mesmo com o sistema no escuro', () => {
  // Sem o `:not([data-tema="claro"])`, o sistema no escuro passaria por cima da
  // escolha da pessoa.
  assert.match(CSS, /@media \(prefers-color-scheme: dark\) \{\s*\n\s*:root:not\(\[data-tema="claro"\]\)/);
  // E a escolha manual de escuro vale mesmo com o sistema no claro.
  assert.match(CSS, /:root\[data-tema="escuro"\] \{/);
});

test('o tema é aplicado no carregamento, não quando a pessoa entra', () => {
  // Aplicar depois do login faz a tela piscar branca antes de escurecer — que
  // é justamente o que incomoda quem abre o CRM no escuro.
  assert.match(APP_JS, /^aplicarTema\(lerTemaEscolhido\(\)\);$/m,
    'a chamada precisa estar no nível do módulo, não dentro de uma função');

  const aplicacao = APP_JS.search(/^aplicarTema\(lerTemaEscolhido\(\)\);$/m);
  const sessao = APP_JS.indexOf('function guardarSessao(');
  assert.ok(aplicacao < sessao, 'o tema vem antes de qualquer coisa de sessão');
});

test('"seguir o sistema" não carimba nada no <html>', () => {
  const inicio = APP_JS.indexOf('function aplicarTema(');
  const funcao = APP_JS.slice(inicio, APP_JS.indexOf('\nfunction ', inicio + 1));
  // Com o atributo presente, o `prefers-color-scheme` deixaria de mandar.
  assert.match(funcao, /removeAttribute\('data-tema'\)/);
  assert.match(funcao, /setAttribute\('data-tema', escolha\)/);
});

test('a tela oferece as três opções e a barra do sistema acompanha', () => {
  for (const escolha of ['sistema', 'claro', 'escuro']) {
    assert.ok(HTML.includes(`data-tema-escolha="${escolha}"`), `falta a opção ${escolha}`);
  }
  assert.match(HTML, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)"/);
  assert.match(HTML, /role="radiogroup"/, 'três opções mutuamente exclusivas são um grupo de rádio');
});

test('a escolha é por aparelho, e sobrevive a armazenamento bloqueado', () => {
  assert.match(APP_JS, /const CHAVE_TEMA = 'crmclinica:tema';/);
  const inicio = APP_JS.indexOf('function lerTemaEscolhido(');
  const ler = APP_JS.slice(inicio, APP_JS.indexOf('\nfunction ', inicio + 1));
  // Janela anônima ou site bloqueado não pode derrubar a tela.
  assert.match(ler, /catch \{\s*\n\s*return 'sistema';/);
});
