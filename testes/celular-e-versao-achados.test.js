'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Achados menores da revisão independente de 13/09/2026, todos com efeito
// visível para quem usa o CRM pelo celular.

const RAIZ = path.join(__dirname, '..');
const leia = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');

const CSS = leia('public/estilo.css');
const APP_JS = leia('public/app.js');

/** O bloco de tela estreita, onde as três partes do inbox ficam empilhadas. */
function blocoDoCelular() {
  const inicio = CSS.indexOf('@media (max-width: 980px) {');
  return CSS.slice(inicio, CSS.indexOf('@media (max-width: 560px)', inicio));
}

test('a lista de conversas tem teto no celular', () => {
  // Ela só rolava por dentro porque `.inbox` tinha altura fixa. Ao soltar
  // aquela altura para o composer caber, as 50 conversas da lista passaram a
  // ser desenhadas de uma vez — e tocar numa delas deixava a viewport lá em
  // cima, a cinquenta linhas da conversa.
  assert.match(blocoDoCelular(), /\.lista \{[^}]*max-height:[^}]*overflow-y: auto/);
});

test('abrir uma conversa leva a tela até ela, só no celular', () => {
  assert.match(APP_JS, /matchMedia\('\(max-width: 980px\)'\)\.matches/);
  assert.match(APP_JS, /seletor\('\.thread'\)\?\.scrollIntoView/);
});

test('a tela de entrada usa dvh, não vh', () => {
  // `100vh` no celular é sempre a altura MAIOR (com a barra do navegador
  // recolhida): sobra uma faixa que não se alcança. A troca tinha sido feita
  // em `.inbox` e esta ficou para trás.
  const portao = CSS.slice(CSS.indexOf('.portao {'), CSS.indexOf('.cartao-login'));
  assert.match(portao, /min-height: 100dvh/);
  assert.doesNotMatch(portao, /min-height: 100vh/);
});

test('o cartão de versão não afirma estar atualizado quando não pode saber', () => {
  // Sem `commit` (VPS, local) não há com o que comparar. Afirmar "você está
  // com a versão mais recente" ali é justamente onde a pessoa pararia de
  // procurar.
  assert.match(APP_JS, /if \(!saude\.commit\) return 'Esta é a versão carregada neste aparelho\./);
});

test('/health fora do ar não deixa o cartão preso em "Conferindo…"', () => {
  const funcao = APP_JS.slice(
    APP_JS.indexOf('async function verificarNovaVersao('),
    APP_JS.indexOf('\nfunction atualizarAgora('),
  );
  const aposFalha = funcao.slice(funcao.indexOf('} catch {'));
  assert.match(aposFalha.slice(0, 500), /definirTexto\('#perfil-versao-estado'/);
});

test('"Procurar atualização" só recarrega quando há versão nova', () => {
  // O CRM é uma página só: um rascunho digitado no composer sobrevive à troca
  // de seção e morria no `location.replace` de uma recarga sem motivo.
  const trecho = APP_JS.slice(APP_JS.indexOf("seletor('#perfil-procurar-versao')"));
  assert.match(trecho.slice(0, 400), /const temVersaoNova = await verificarNovaVersao\(\)/);
  assert.match(trecho.slice(0, 400), /if \(temVersaoNova\) atualizarAgora\(\);/);
});

test('as tabelas de setembro entram nas duas sondas do banco', () => {
  // Migration que não rodou não acende nada sozinha: o código sobe, a rota
  // responde, e o recurso simplesmente não acontece.
  const verificador = leia('bin/verificar-banco.js');
  const diagnostico = leia('src/servidor/rotas-diagnostico.js');
  for (const tabela of ['notificacoes_inscricoes', 'email_outbox', 'orientacoes']) {
    assert.ok(verificador.includes(tabela), `bin/verificar-banco.js não confere ${tabela}`);
    assert.ok(diagnostico.includes(tabela), `a varredura semanal não confere ${tabela}`);
  }
});
