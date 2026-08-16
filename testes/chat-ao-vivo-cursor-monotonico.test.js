'use strict';

// BLOQUEADOR 2 do gate final do PR #34, camada do cliente (public/app.js).
//
// O defeito: `if (typeof dados.id === 'number') cursorDeEventos = dados.id;`
// grava o cursor SEM comparar com o que já havia. Um evento que chega fora de
// ordem (o servidor entregava [2,1] — ver testes/conversas-eventos-ordem.test.js
// — mas também um proxy, uma reconexão ou outro processo podem produzir isso)
// faz o cursor RETROCEDER. Na reconexão seguinte, o replay (`?cursor=`/
// `Last-Event-ID`) reenvia um evento que a tela já processou → MENSAGEM
// DUPLICADA NO CHAT, que é exatamente o bug que este hotfix existe para
// corrigir.
//
// Serializar no servidor não substitui esta camada: o cursor do cliente é o
// que sobrevive à reconexão, e ele precisa ser monotônico por construção,
// independentemente do que chegar pelo fio (defesa em profundidade).
//
// Sem DOM/jsdom neste repositório: a prova segue o padrão já usado por
// chat-ao-vivo-eventos-ui.test.js e entrega-nao-realizada-ui.test.js — ler o
// código-fonte. A diferença é que aqui a função de cursor é PURA e o teste a
// EXECUTA de verdade (não só confere o texto), porque "nunca retrocede" é uma
// afirmação sobre comportamento, não sobre a forma da linha.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * Extrai `proximoCursorDeEventos` de public/app.js e a executa de verdade.
 * A função é pura de propósito (recebe o cursor atual, devolve o próximo)
 * exatamente para poder ser exercida aqui sem navegador.
 */
function carregarProximoCursorDeEventos() {
  const fonte = APP_JS.match(/function proximoCursorDeEventos\([\s\S]*?\n\}/);
  assert.ok(fonte, 'public/app.js precisa declarar `proximoCursorDeEventos` — é a função que impede o cursor de retroceder');
  // eslint-disable-next-line no-new-func
  return new Function(`${fonte[0]}\nreturn proximoCursorDeEventos;`)();
}

const proximoCursorDeEventos = carregarProximoCursorDeEventos();

test('cursor ainda não iniciado (null) adota o primeiro id recebido', () => {
  assert.equal(proximoCursorDeEventos(null, 5), 5);
  assert.equal(proximoCursorDeEventos(null, 0), 0, 'id 0 é um cursor válido — "desde o começo"');
});

test('evento com id MAIOR avança o cursor', () => {
  assert.equal(proximoCursorDeEventos(5, 6), 6);
  assert.equal(proximoCursorDeEventos(5, 900), 900);
});

test('evento DUPLICADO (mesmo id) não retrocede nem altera o cursor', () => {
  assert.equal(proximoCursorDeEventos(5, 5), 5);
});

test('evento ATRASADO (id menor) não retrocede o cursor — é o caso [2,1]', () => {
  assert.equal(
    proximoCursorDeEventos(2, 1), 2,
    'receber o evento 1 depois do 2 não pode devolver o cursor para 1: a reconexão reenviaria o 2 e a mensagem apareceria duas vezes',
  );
  assert.equal(proximoCursorDeEventos(900, 3), 900);
});

test('id inválido não corrompe o cursor (nada de NaN silencioso)', () => {
  // `Math.max(5, Number(x))` seria a forma curta e é justamente a armadilha:
  // com qualquer coisa que não vire número, `Math.max` devolve NaN, todo `>`
  // seguinte vira false e a reconexão manda `cursor=NaN` — o cursor morre em
  // silêncio e o replay volta a duplicar.
  const INVALIDOS = [
    undefined, null, Number.NaN, Infinity, -Infinity, 'abc', '', '  ', {}, [], true, false,
    1.5, -1, () => {},
  ];
  for (const invalido of INVALIDOS) {
    const resultado = proximoCursorDeEventos(5, invalido);
    assert.equal(resultado, 5, `id inválido (${String(invalido)}) precisa manter o cursor em 5`);
    assert.equal(Number.isInteger(resultado), true, `id inválido (${String(invalido)}) não pode produzir NaN`);
  }
  for (const invalido of INVALIDOS) {
    assert.equal(proximoCursorDeEventos(null, invalido), null, 'com cursor ainda não iniciado, id inválido mantém null');
  }
});

test('id numérico em texto é aceito — o cursor acompanha o tipo que o fio entrega', () => {
  // O servidor entrega `id` como número (`Number(linha.id)` em
  // src/dados/repositorio.js), mas `Last-Event-ID` e qualquer intermediário
  // trafegam texto. Aceitar "7" é o que impede o cursor de simplesmente
  // PARAR DE AVANÇAR (que também termina em replay duplicado).
  assert.equal(proximoCursorDeEventos(5, '7'), 7);
  assert.equal(proximoCursorDeEventos(5, '3'), 5, 'texto com id menor continua sem retroceder');
});

test('uma sequência fora de ordem termina no maior id visto, sempre', () => {
  const SEQUENCIA = [1, 2, 5, 3, 5, 4, 'x', null, 7, 6];
  let cursor = null;
  let maiorVisto = 0;
  for (const id of SEQUENCIA) {
    const anterior = cursor;
    cursor = proximoCursorDeEventos(cursor, id);
    if (typeof id === 'number') maiorVisto = Math.max(maiorVisto, id);
    if (anterior !== null) {
      assert.ok(cursor >= anterior, `cursor retrocedeu de ${anterior} para ${cursor} ao receber ${String(id)}`);
    }
  }
  assert.equal(cursor, maiorVisto, 'o cursor final precisa ser o maior id válido já visto');
});

// ---------------------------------------------------------------- ligação com a tela

test('reagirAEventoDeConversa usa a função monotônica — não atribui o cursor direto', () => {
  const corpo = APP_JS.match(/function reagirAEventoDeConversa\(dados\) \{[\s\S]*?\n\}/);
  assert.ok(corpo, 'reagirAEventoDeConversa precisa existir');

  // Só linhas de CÓDIGO: o comentário que documenta o defeito antigo cita a
  // linha original de propósito (é o que explica por que a função monotônica
  // existe), e não pode ser confundido com a reintrodução do defeito. A
  // varredura segue sendo do arquivo inteiro, não só desta função — o cursor
  // não pode voltar a ser gravado sem comparação em lugar nenhum.
  const codigo = APP_JS.split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(
    codigo, /cursorDeEventos\s*=\s*dados\.id/,
    'a atribuição direta é o defeito: um evento atrasado retrocederia o cursor',
  );
  assert.match(
    corpo[0], /proximoCursorDeEventos\(/,
    'o cursor precisa passar pela função monotônica antes de ser gravado',
  );
});

test('o evento atrasado continua sendo PROCESSADO — só não retrocede o cursor', () => {
  // Não basta ignorar o evento fora de ordem: ele carrega estado real
  // (mensagem nova, status de entrega, conversa resolvida) e a tela precisa
  // reagir. A garantia estrutural é que o tratamento do cursor não tem
  // `return` — nenhum caminho de saída antecipada entre a linha do cursor e o
  // guard de tipos conhecidos, que é o único filtro legítimo.
  const corpo = APP_JS.match(/function reagirAEventoDeConversa\(dados\) \{[\s\S]*?\n\}/);
  const indiceCursor = corpo[0].indexOf('proximoCursorDeEventos(');
  const indiceGuarda = corpo[0].indexOf('TIPOS_DE_EVENTO_CONHECIDOS.includes(dados?.tipo)');
  assert.ok(indiceCursor >= 0 && indiceGuarda > indiceCursor,
    'o cursor é atualizado antes do guard de tipos — e o guard continua sendo o único filtro');

  const entre = corpo[0].slice(indiceCursor, indiceGuarda);
  assert.doesNotMatch(entre, /\breturn\b/,
    'nenhuma saída antecipada por id fora de ordem: o evento atrasado ainda precisa atualizar a tela');
});
