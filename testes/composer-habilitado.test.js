'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A caixa de resposta aparecia e não deixava digitar (13/09/2026).
//
// Relato do Dr. Édson, na conversa da Rose Oliveira: "apesar de estar vendo a
// caixa de resposta após eu assumir a conversa, não consegui escrever nem
// enviar mensagem".
//
// A causa: o campo virou `<textarea>` quando ganhou várias linhas, e o seletor
// que habilita os controles continuou procurando `input`. Dentro do
// formulário, o único `input` é o seletor de arquivo — oculto. O `<textarea>`
// nasce `disabled` no HTML e nunca era destravado.
//
// Era o pior tipo de defeito de interface: nada parecia errado. A caixa
// aparecia, o botão "Enviar" habilitava, e o campo não aceitava uma letra. Sem
// responder pela tela, o atendimento humano simplesmente não acontecia — e
// isso ficou no ar junto com a correção que fez a caixa aparecer no celular.

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');

/** O seletor que `alternarAcoes` usa para destravar os controles. */
function seletorDeHabilitacao() {
  const inicio = APP_JS.indexOf('function alternarAcoes(');
  const trecho = APP_JS.slice(inicio, APP_JS.indexOf('}', inicio));
  const achado = trecho.match(/querySelectorAll\(\s*'([^']+)'/);
  assert.ok(achado, 'alternarAcoes precisa habilitar por um seletor legível');
  return achado[1];
}

/** As tags que nascem `disabled` dentro do formulário de resposta. */
function tagsTravadasNoComposer() {
  const inicio = HTML.indexOf('<form class="composer" id="form-resposta">');
  assert.ok(inicio > 0, 'o formulário de resposta precisa existir');
  const formulario = HTML.slice(inicio, HTML.indexOf('</form>', inicio));

  const tags = new Set();
  for (const elemento of formulario.matchAll(/<(textarea|input|button|select)\b([^>]*)>/g)) {
    const [, tag, atributos] = elemento;
    // `hidden` não precisa ser destravado: ninguém interage com ele direto.
    if (/\bdisabled\b/.test(atributos) && !/\bhidden\b/.test(atributos)) tags.add(tag);
  }
  return tags;
}

test('todo controle que nasce travado no composer é destravado ao abrir a conversa', () => {
  // A regra geral, não o caso de ontem: se alguém acrescentar um `<select>` ou
  // trocar a tag de novo, o teste acusa antes de a equipe descobrir tentando
  // responder a um paciente.
  const seletor = seletorDeHabilitacao();

  for (const tag of tagsTravadasNoComposer()) {
    assert.ok(
      seletor.includes(`#form-resposta ${tag}`),
      `<${tag}> nasce disabled no composer e o seletor de alternarAcoes não o alcança: "${seletor}"`,
    );
  }
});

test('o campo de resposta é um textarea, e o seletor sabe disso', () => {
  // Fixa o par que quebrou: a tag do campo e o seletor que a destrava.
  assert.match(HTML, /<textarea id="resposta"[^>]*disabled/, 'o campo nasce travado, por isso precisa ser destravado');
  assert.ok(seletorDeHabilitacao().includes('#form-resposta textarea'));
});

test('o botão de enviar e o de nota continuam cobertos', () => {
  // O defeito anterior deixava ESTES habilitados e o campo travado — a
  // combinação que fazia a tela parecer funcionando.
  const seletor = seletorDeHabilitacao();
  assert.ok(seletor.includes('#form-resposta button'));
  assert.ok(seletor.includes('#botao-nota'));
});
