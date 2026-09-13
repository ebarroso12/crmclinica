'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Saber em que versão se está, e conseguir atualizar (13/09/2026).
//
// Relato do Dr. Edson: "não estou vendo o botão de atualizar; além disso, não
// vejo as versões onde estão". Os dois tinham a mesma causa — os dois viviam no
// MENU LATERAL, que no celular vira uma faixa que rola de lado. A versão, pior
// ainda: o CSS esconde o rodapé do menu em tela estreita (`display: none`), ou
// seja, pelo celular não havia como saber a versão em uso.
//
// Isso não é cosmético: sem o botão, a pessoa fica numa versão antiga sem saber
// — inclusive sem as correções que acabaram de subir.

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'public', 'estilo.css'), 'utf8');

test('o aviso de versão nova aparece no topo do conteúdo, não só no menu', () => {
  assert.match(HTML, /id="aviso-versao-nova"[^>]*hidden/);
  assert.match(HTML, /id="aviso-versao-atualizar"/);

  // E ele fica FORA do menu lateral — que é o ponto.
  const menu = HTML.slice(HTML.indexOf('<header class="lateral">'), HTML.indexOf('</header>'));
  assert.ok(!menu.includes('aviso-versao-nova'), 'no celular o menu é uma faixa rolável: botão ali não é encontrado');
});

test('os dois avisos de versão acendem e apagam juntos', () => {
  // O do menu (computador) e o do topo (celular) mostram a mesma verdade.
  assert.match(APP_JS, /const temVersaoNova = Boolean\(saude\.commit\) && saude\.commit !== commitCarregadoNestaAba;/);
  assert.match(APP_JS, /botao\.hidden = !temVersaoNova/);
  assert.match(APP_JS, /aviso\.hidden = !temVersaoNova/);
});

test('a versão em uso aparece em Meu perfil — o rodapé do menu some no celular', () => {
  assert.match(CSS, /\.rodape-lateral,[^}]*display: none/, 'o rodapé realmente some em tela estreita');
  assert.match(HTML, /id="perfil-versao"/);
  assert.match(APP_JS, /definirTexto\('#perfil-versao', `crmclinica \$\{versaoLegivel\}`\)/);
});

test('o estado da versão não fica preso em "Conferindo…"', () => {
  // A primeira verificação retorna cedo (ela só registra a baseline). Sem sair
  // do texto de espera ali, o cartão ficaria pendurado até a checagem seguinte,
  // cinco minutos depois — parecendo que travou.
  const inicio = APP_JS.indexOf('async function verificarNovaVersao(');
  const funcao = APP_JS.slice(inicio, APP_JS.indexOf('\nfunction atualizarAgora(', inicio));
  const primeiraLeitura = funcao.slice(funcao.indexOf('commitCarregadoNestaAba === null'));
  assert.match(primeiraLeitura.slice(0, 500), /definirTexto\('#perfil-versao-estado'/);
});

test('atualizar força buscar tudo de novo, e os três botões usam o mesmo caminho', () => {
  // `reload()` puro pode reaproveitar o cache — e era disso que a pessoa estava
  // tentando escapar ao apertar o botão.
  assert.match(APP_JS, /function atualizarAgora\(\)[\s\S]{0,300}url\.searchParams\.set\('v'/);
  for (const botao of ['#banner-atualizar', '#aviso-versao-atualizar']) {
    assert.ok(
      // Comparação literal: montar regex com o seletor dentro exigiria escapar
      // parênteses e ponto, e o escape é justamente o que costuma se perder.
      APP_JS.includes(`seletor('${botao}')?.addEventListener('click', atualizarAgora)`),
      `${botao} precisa recarregar buscando de novo`,
    );
  }
  assert.match(APP_JS, /#perfil-procurar-versao[\s\S]{0,400}atualizarAgora\(\)/);
});
