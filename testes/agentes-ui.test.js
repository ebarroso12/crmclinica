'use strict';

// Tela de Agentes (docs/AGENTES.md). Sem DOM nesta suíte (`node --test`, sem
// jsdom), a prova é estrutural — mesmo padrão de testes/botoes-orfaos.test.js:
// lê index.html e app.js e confere que as peças se encontram (ids, abas,
// campos de configuração, rotas chamadas, confirmação antes de ligar).
//
// NÃO prova que a tela funciona no navegador: clique, preenchimento e resposta
// da API só um teste manual ou automação de navegador comprovam.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONFIGURACOES_PADRAO } = require('../src/dominio/agentes/regras');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function secaoDeAgentes() {
  const secao = HTML.match(/<section id="agentes" class="tela"[\s\S]*?<\/section>/)?.[0];
  assert.ok(secao, 'a seção #agentes precisa existir em index.html');
  return secao;
}

function blocoDeAgentes() {
  const inicio = APP_JS.indexOf('// Agentes configuráveis (docs/AGENTES.md)');
  const fim = APP_JS.indexOf('// Contatos: a base de pacientes');
  assert.ok(inicio >= 0 && fim > inicio, 'o bloco de agentes precisa existir em app.js, antes do de contatos');
  return APP_JS.slice(inicio, fim);
}

const ABAS = ['perfil', 'trabalho', 'treinamentos', 'configuracoes', 'inatividade', 'canais', 'teste'];

test('o menu tem Agentes escondido por padrão e liberado só por agentes:ler', () => {
  assert.match(HTML, /<li id="item-agentes" hidden>\s*<button type="button" data-tela="agentes">/);
  assert.match(APP_JS, /seletor\('#item-agentes'\)/);
  assert.match(APP_JS, /itemAgentes\.hidden = !podeFazer\('agentes:ler'\)/);
});

test('a tela está registrada em TITULOS e abrirTela carrega os agentes', () => {
  assert.match(APP_JS, /agentes: 'Agentes',/);
  assert.match(APP_JS, /if \(tela === 'agentes'\) carregarAgentes\(\);/);
});

test('cada aba do editor tem o seu painel, e só um painel começa visível', () => {
  const secao = secaoDeAgentes();
  for (const aba of ABAS) {
    assert.match(secao, new RegExp(`data-aba-agente="${aba}"`), `aba ${aba}`);
    assert.match(secao, new RegExp(`data-painel-agente="${aba}"`), `painel ${aba}`);
  }
  const paineis = secao.match(/<[^>]*data-painel-agente="[^"]+"[^>]*>/g);
  assert.equal(paineis.length, ABAS.length);
  assert.equal(paineis.filter((tag) => !/\shidden\b/.test(tag)).length, 1, 'só o perfil nasce aberto');
});

test('todo campo de CONFIGURACOES_PADRAO tem controle na aba Configurações', () => {
  const secao = secaoDeAgentes();
  for (const chave of Object.keys(CONFIGURACOES_PADRAO)) {
    assert.match(secao, new RegExp(`id="agente-cfg-${chave}"`), `falta o controle de ${chave}`);
  }
  // E o app.js lê as oito chaves booleanas pelo mesmo nome.
  for (const [chave, valor] of Object.entries(CONFIGURACOES_PADRAO)) {
    if (typeof valor === 'boolean') assert.ok(blocoDeAgentes().includes(`'${chave}'`), `app.js não lê ${chave}`);
  }
});

test('todo id que o bloco de agentes procura existe no HTML', () => {
  const bloco = blocoDeAgentes();
  const ids = new Set([...bloco.matchAll(/seletor\('#([\w-]+)'\)/g)].map((achado) => achado[1]));
  assert.ok(ids.size > 20, 'o teste precisa enxergar os seletores do bloco');
  for (const id of ids) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} é usado em app.js mas não existe em index.html`);
  }
});

test('nenhum botão da tela de agentes nasce órfão', () => {
  for (const botao of secaoDeAgentes().match(/<button[^>]*>/g)) {
    const ligado = /\sid="/.test(botao) || /\sdata-[\w-]+="/.test(botao) || /type="submit"/.test(botao);
    assert.ok(ligado, `botão sem id, data-* ou submit: ${botao}`);
  }
});

test('a tela chama todas as rotas da API de agentes', () => {
  const bloco = blocoDeAgentes();
  assert.ok(bloco.includes("pedirJson('/api/agentes')"));
  assert.ok(bloco.includes("pedirJson('/api/agentes', {"));
  for (const trecho of ['/treinamentos', '/inatividade', '/canais', '/teste', '/comportamento/', '/restaurar']) {
    assert.ok(bloco.includes(trecho), `a tela não usa ${trecho}`);
  }
  assert.ok(bloco.includes("metodo: 'DELETE'"));
  assert.ok(bloco.includes("metodo: 'PUT'"));
});

test('ligar um agente pede confirmação antes de salvar', () => {
  const bloco = blocoDeAgentes();
  const inicio = bloco.indexOf("seletor('#agente-aba-perfil')?.addEventListener('submit'");
  assert.ok(inicio >= 0);
  const perfil = bloco.slice(inicio, inicio + 1200);
  const confirmacao = perfil.indexOf('window.confirm(');
  const salvar = perfil.indexOf('salvarAgenteAberto(');
  assert.ok(perfil.includes("status === 'ativo'"));
  assert.ok(confirmacao >= 0 && confirmacao < salvar, 'a confirmação vem antes do salvamento');
});

test('texto dinâmico em atributo usa escaparAtributo, nunca escapar (que não escapa aspas)', () => {
  const bloco = blocoDeAgentes();
  assert.ok(bloco.includes('function escaparAtributo('));
  assert.doesNotMatch(bloco, /="\$\{escapar\(/, 'escapar() dentro de atributo deixa aspas passarem');
  assert.match(bloco, /value="\$\{escaparAtributo\(acao\.instrucao/);
  assert.match(bloco, /value="\$\{escaparAtributo\(canal\.instancia/);
});

test('a seção não tem script, estilo ou manipulador inline (CSP estrita)', () => {
  const secao = secaoDeAgentes();
  assert.doesNotMatch(secao, /<script/i);
  assert.doesNotMatch(secao, /\sstyle="/i);
  assert.doesNotMatch(secao, /\son[a-z]+="/i);
});

test('o teste de agente não reaproveita os rótulos dos botões órfãos removidos', () => {
  const bloco = blocoDeAgentes();
  for (const rotulo of ['Nova tarefa', 'Nova conversa', 'Novo lead']) {
    assert.ok(!bloco.includes(rotulo), `"${rotulo}" não pode aparecer no bloco de agentes`);
  }
});
