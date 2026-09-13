'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Atender pelo celular (13/09/2026).
//
// Defeito real, relatado depois de instalar o app: "ficou sem a parte de
// responder o chat, ou seja, não tem box para assumir o paciente".
//
// A causa não era o composer nem permissão: era ALTURA. `.inbox` tem altura
// fixa (`calc(100dvh - 230px)`, mínimo 480px), pensada para as três colunas
// lado a lado no computador. No celular as três viram uma coluna EMPILHADA
// dentro daquela mesma caixa — e a caixa de resposta, que fica no fim da
// conversa, caía fora da área visível. No app instalado, sem barra de navegador
// para rolar, o CRM ficava sem como responder.

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8')
  .split('\r\n').join('\n');

/** O bloco de uma media query, do `{` até o `}` que a fecha. */
function blocoDaMedia(consulta) {
  const inicio = CSS.indexOf(consulta);
  assert.ok(inicio >= 0, `o CSS precisa ter ${consulta}`);
  let profundidade = 0;
  for (let i = CSS.indexOf('{', inicio); i < CSS.length; i += 1) {
    if (CSS[i] === '{') profundidade += 1;
    else if (CSS[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return CSS.slice(inicio, i + 1);
    }
  }
  throw new Error(`não consegui fechar ${consulta}`);
}

test('no celular o inbox tem altura do conteúdo, não a fixa do computador', () => {
  const estreito = blocoDaMedia('@media (max-width: 980px)');

  assert.match(estreito, /\.inbox \{[\s\S]{0,200}height: auto;/,
    'com altura fixa e as três partes empilhadas, a caixa de resposta fica fora da tela');
  assert.match(estreito, /\.inbox \{[\s\S]{0,200}max-height: none;/);
});

test('a caixa de resposta acompanha o polegar no celular', () => {
  const estreito = blocoDaMedia('@media (max-width: 980px)');
  // Ela é o motivo de a tela existir no celular: fica no fim da conversa e
  // gruda, em vez de sumir conforme a lista de mensagens cresce.
  assert.match(estreito, /\.composer \{[\s\S]{0,160}position: sticky;/);
  assert.match(estreito, /\.mensagens \{ max-height/, 'quem rola é a lista de mensagens, não a página');
});

test('a altura usa dvh: no celular a barra do navegador aparece e some', () => {
  // Com `100vh`, a conta dá mais altura do que existe de fato enquanto a barra
  // está na tela — e o fim do bloco (onde mora o composer) fica cortado.
  assert.match(CSS, /\.inbox \{[\s\S]{0,400}height: calc\(100dvh - 230px\);/);
});
