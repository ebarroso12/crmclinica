'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Tela Usuários: WhatsApp e autorização (docs/RESUMOS.md). Guardas estruturais —
// as rotas estão provadas em testes/whatsapp-usuario-rotas.test.js. NÃO prova o
// comportamento no navegador.

const RAIZ = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');

function funcaoDoApp(nome) {
  const inicio = APP_JS.search(new RegExp(`^(?:async\\s+)?function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `function ${nome} precisa existir em app.js`);
  const proxima = APP_JS.slice(inicio + 1).search(/^(?:async\s+)?function\s|^seletor\(/m);
  return APP_JS.slice(inicio, proxima < 0 ? undefined : inicio + 1 + proxima);
}

test('o cartão de WhatsApp existe com os ids certos, DDI 55 por padrão, ao lado do painel dos resumos', () => {
  assert.match(HTML, /<article class="card" id="cartao-whatsapp-usuario" hidden>/);
  assert.match(HTML, /<form id="form-whatsapp-usuario" class="form-regra">/);
  assert.match(HTML, /<input id="whatsapp-usuario-ddi" type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="55">/);
  assert.match(HTML, /<input id="whatsapp-usuario-ddd" type="text" inputmode="numeric" maxlength="2" autocomplete="off">/);
  assert.match(HTML, /<input id="whatsapp-usuario-numero" type="text" inputmode="numeric" maxlength="9" autocomplete="off">/);
  assert.match(HTML, /<input type="checkbox" id="whatsapp-usuario-autorizado"> WhatsApp autorizado para avisos e resumos<\/label>/);
  for (const id of ['whatsapp-usuario-erro', 'whatsapp-usuario-registro', 'whatsapp-usuario-situacao', 'whatsapp-usuario-fechar']) {
    assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `id ${id} único`);
  }
  const posCartao = HTML.indexOf('id="cartao-whatsapp-usuario"');
  const posPainel = HTML.indexOf('id="cartao-resumos"');
  assert.ok(posCartao > 0 && posCartao < posPainel, 'logo antes do painel "Quem recebe os resumos"');
  assert.ok(!/\son[a-z]+=|\sstyle=/i.test(HTML.slice(posCartao - 300, posPainel)), 'sem handler nem style inline');
});

test('funções sem duplicata', () => {
  for (const nome of ['desenharWhatsappDoUsuario', 'abrirWhatsappDoUsuario', 'depoisDeMudarWhatsapp',
    'carregarPainelDeResumos', 'montarLinhaDeUsuario', 'agirNoUsuario', 'carregarUsuarios']) {
    const declaracoes = APP_JS.match(new RegExp(`^(?:async\\s+)?function ${nome}\\(`, 'gm')) ?? [];
    assert.equal(declaracoes.length, 1, `${nome} declarada ${declaracoes.length} vez(es)`);
  }
  assert.equal((APP_JS.match(/^let whatsappEmEdicao = null;/gm) ?? []).length, 1);
});

test('grava pela edição completa existente e autoriza pela rota de P1-06, com confirmação; depois recarrega lista e painel', () => {
  assert.match(APP_JS, /pedirJson\(`\/api\/usuarios\/\$\{alvo\}`, \{ metodo: 'PUT', corpo: \{ whatsapp \} \}\)/);
  assert.match(APP_JS, /pedirJson\(`\/api\/usuarios\/\$\{alvo\}\/whatsapp-particular`, \{ metodo: 'POST', corpo: \{ autorizado: caixa\.checked \} \}\)/);
  assert.match(APP_JS, /window\.confirm\('Confirma que a pessoa autorizou o uso deste WhatsApp/);
  assert.match(APP_JS, /falha\.detalhe \|\| 'WhatsApp inválido: informe DDD \(2 dígitos\) e número \(8 ou 9 dígitos\)\.'/);
  const depois = funcaoDoApp('depoisDeMudarWhatsapp');
  assert.match(depois, /await carregarUsuarios\(\);/, 'a lista recarrega — e com ela o painel dos resumos');
  assert.match(funcaoDoApp('carregarUsuarios'), /carregarPainelDeResumos\(\);/);
  const abrir = funcaoDoApp('abrirWhatsappDoUsuario');
  assert.match(abrir, /if \(whatsappEmEdicao !== alvo\) return;/, 'resposta de outra pessoa é descartada');
});

test('a ficha mostra quem autorizou e quando, só por textContent/value; o número em claro só no formulário', () => {
  const desenhar = funcaoDoApp('desenharWhatsappDoUsuario');
  assert.ok(!/innerHTML/.test(desenhar));
  assert.match(desenhar, /definirTexto\('#whatsapp-usuario-titulo', `WhatsApp de \$\{ficha\.nome \?\? 'usuário'\}`\);/);
  assert.match(desenhar, /Autorizado por \$\{ficha\.whatsapp_particular_autorizado_por_nome \?\? 'administrador'\} em \$\{dataHoraDoPainelDoAgente\(ficha\.whatsapp_particular_autorizado_em\)/);
  assert.match(desenhar, /seletor\('#whatsapp-usuario-numero'\)\.value = ficha\.whatsapp_numero \?\? '';/);

  // Toda leitura de whatsapp_numero no app fica dentro do formulário do admin.
  const leituras = APP_JS.split('whatsapp_numero').length - 1;
  const noFormulario = desenhar.split('whatsapp_numero').length - 1;
  assert.equal(leituras, noFormulario, 'o número não é lido em nenhum outro lugar da tela');
  assert.ok(!/innerHTML/.test(funcaoDoApp('abrirWhatsappDoUsuario')));
});

test('cada linha de usuário abre o WhatsApp; Meu perfil não tem campo de WhatsApp nem de autorização', () => {
  const linha = funcaoDoApp('montarLinhaDeUsuario');
  assert.match(linha, /botaoWhatsapp\.textContent = 'WhatsApp';/);
  assert.match(linha, /botaoWhatsapp\.addEventListener\('click', \(\) => abrirWhatsappDoUsuario\(usuario\.id\)\);/);

  const inicioPerfil = HTML.indexOf('<section id="perfil"');
  const perfil = HTML.slice(inicioPerfil, HTML.indexOf('</section>', inicioPerfil));
  assert.ok(inicioPerfil > 0);
  assert.ok(!/whatsapp/i.test(perfil), 'perfil sem WhatsApp');
});
