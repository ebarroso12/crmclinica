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

// ---------------------------------------------------------------------------
// Achados da revisão independente de 12/09/2026, depois dos commits das seções
// da Serena e da tabela de Contatos. Os dois eram furos reais; ficam trancados
// aqui porque nenhum teste anterior olhava para eles.

test('as seções restritas da Serena não abrem para quem não gerencia', () => {
  // Antes da navegação por botões, esses três cartões nasciam `hidden` e a tela
  // não tinha como revelá-los. Com um botão para cada um, abrir virou um
  // clique — e abrir é mostrar.
  assert.match(APP_JS, /const SECOES_SO_DE_QUEM_GERENCIA = new Set\(\[([^\]]*)\]\)/);
  const restritas = APP_JS.match(/const SECOES_SO_DE_QUEM_GERENCIA = new Set\(\[([^\]]*)\]\)/)[1];
  for (const secao of ['diagnostico-card', 'serena-teste-card', 'serena-horario-card']) {
    assert.ok(restritas.includes(secao), `${secao} precisa continuar restrita a quem gerencia`);
  }

  const inicio = APP_JS.indexOf('function abrirSecaoDaSerena(');
  const abrir = APP_JS.slice(inicio, APP_JS.indexOf('\nfunction ', inicio + 1));
  assert.match(abrir, /SECOES_SO_DE_QUEM_GERENCIA\.has/, 'abrir uma seção precisa checar a permissão');
  assert.match(abrir, /podeGerenciarSerena/);

  // E a permissão entra antes de escolher a seção — senão a guardada no
  // localStorage abriria antes de alguém dizer que ela não pode.
  const permissao = APP_JS.indexOf('aplicarPermissaoNasSecoesDaSerena(dados.pode_gerenciar)');
  const escolha = APP_JS.indexOf('abrirSecaoDaSerena(guardada');
  assert.ok(permissao >= 0 && escolha > permissao, 'a permissão precisa ser aplicada antes de abrir a seção guardada');
});

test('a coluna Agendamentos da tabela de Contatos sai dos dados, não de veClinica()', () => {
  // As duas concordam no caminho normal, mas divergem quando /api/conversas/escopo
  // falha: o fallback assume clínica, e aí o cabeçalho teria uma coluna a mais
  // que as linhas — a tabela inteira torceria.
  const inicio = APP_JS.indexOf('async function carregarContatos(');
  const funcao = APP_JS.slice(inicio, APP_JS.indexOf('\nfunction ', inicio + 1));

  assert.match(funcao, /const temAgendamentos = dados\.contatos\.some\(/);
  assert.match(funcao, /colunaAgendamentos\.hidden = !temAgendamentos/);
  assert.match(funcao, /const colunas = temAgendamentos \? 5 : 4/);
  assert.doesNotMatch(funcao, /veClinica\(\) \? 5 : 4/, 'o número de colunas não pode vir da permissão da sessão');
});

test('a célula de ações da tabela não usa a classe .acoes da barra do topo', () => {
  // `.acoes` é global e traz `display: flex`, que tira a <td> do fluxo da
  // tabela: a coluna deixa de encolher e o alinhamento vertical se perde.
  assert.ok(!/<td class="acoes"/.test(APP_JS), 'a célula precisa de classe própria (celula-acoes)');
  assert.match(APP_JS, /<td class="celula-acoes">/);
  assert.match(MARCACAO, /<th scope="col" class="celula-acoes">/);
});

test('as listas em cartão de Auditoria e Bloqueios continuam com estilo', () => {
  // Elas usavam a classe da lista de Contatos, que virou tabela: sem renomear,
  // as duas perderiam o cartão e voltariam a ter marcador de bullet.
  assert.ok(!MARCACAO.includes('class="lista-contatos"'), 'a classe antiga não sobrou no HTML');
  assert.match(MARCACAO, /<ul class="lista-cartoes" id="lista-auditoria">/);
  assert.match(MARCACAO, /<ul class="lista-cartoes" id="lista-bloqueios">/);
  assert.match(CSS, /\.lista-versoes, \.lista-regras, \.lista-cartoes \{/);
});
