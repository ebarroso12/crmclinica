'use strict';

// Guardas do editor de grade da Serena (Comando 4, frente 7).
//
// `public/app.js` é servido cru ao navegador, sem bundler nem módulo — não dá
// para `require()` o arquivo num teste Node (ele espera `document`, `window`,
// `fetch`) nem para reusar sua lógica num teste de domínio sem duplicar
// código entre browser e servidor, que este projeto não tem infraestrutura
// para fazer (nenhum outro trecho de `public/app.js` tem teste automatizado
// hoje — só a matriz estática de botões, feita por auditoria externa).
//
// O que ESTES testes provam, por inspeção do código-fonte: que o editor não
// tem mais nenhum caminho que descarta uma janela extra ao salvar — nem o
// texto "+N faixa(s)" que só informava sem deixar editar, nem a leitura que
// dependia de `anterior` para não perder o que não aparecia na tela. O que
// eles NÃO provam: que o clique realmente funciona no navegador — isso seguiu
// sendo verificado por leitura do código, no mesmo padrão que o resto deste
// arquivo sempre teve.
//
// A garantia de comportamento real (dado um payload com 2+ janelas por dia,
// nada se perde) está em testes/serena-horario.test.js (validação) e
// testes/serena-horario-http.test.js (round-trip PUT → GET) — a parte do
// contrato que roda em Node e pode ser testada de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('o editor não esconde mais janela nenhuma atrás de uma nota de texto', () => {
  assert.ok(!/faixa\(s\) definidas pela API/.test(APP_JS),
    'a nota "+N faixa(s)" era o sintoma do defeito: informava sem deixar editar');
  assert.ok(!/janelas\[0\]/.test(APP_JS),
    'nenhum trecho pode voltar a olhar só a primeira janela do dia');
});

test('a leitura da grade não depende mais de "anterior" para preservar janela escondida', () => {
  const corpoDeLerGrade = APP_JS.match(/function lerGradeDaTela\(\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(corpoDeLerGrade, 'lerGradeDaTela precisa existir');
  assert.ok(!/anterior/.test(corpoDeLerGrade),
    'a leitura agora vem inteira do DOM — não deveria mais precisar de um estado anterior para não perder janela');
});

test('cada dia desenha uma linha por janela, com início, fim e um botão de remover', () => {
  const corpoDeDesenharDia = APP_JS.match(/function desenharDiaDaGrade\([\s\S]*?\n\}/)?.[0];
  assert.ok(corpoDeDesenharDia, 'desenharDiaDaGrade precisa existir');
  assert.match(corpoDeDesenharDia, /for \(const \[inicio, fim\] of (linhasIniciais|janelas)/,
    'precisa iterar por TODAS as janelas do dia, não pegar um índice fixo');

  const corpoDeDesenharJanela = APP_JS.match(/function desenharJanelaDaGrade\([\s\S]*?\n\}/)?.[0];
  assert.ok(corpoDeDesenharJanela, 'desenharJanelaDaGrade precisa existir');
  // Os campos são gerados como `horario-${classe}` a partir de ['inicio', 'fim'].
  assert.match(corpoDeDesenharJanela, /\['inicio', inicio\], \['fim', fim\]/);
  assert.match(corpoDeDesenharJanela, /horario-\$\{classe\}/);
  assert.match(corpoDeDesenharJanela, /horario-remover/, 'cada janela precisa de um jeito de ser removida');
});

test('existe um jeito de adicionar mais de uma janela por dia, e o clique está ligado', () => {
  assert.match(APP_JS, /function adicionarJanelaNaGrade\(/);
  assert.match(APP_JS, /horario-adicionar/);
  // O handler de clique delegado precisa reconhecer os dois botões novos.
  const corpoDoHandler = APP_JS.match(/document\.addEventListener\('click', \(evento\) => \{[\s\S]*?horario-salvar[\s\S]*?\n\}\);/)?.[0];
  assert.ok(corpoDoHandler, 'o handler de clique que trata horario-salvar precisa existir');
  assert.match(corpoDoHandler, /horario-adicionar/);
  assert.match(corpoDoHandler, /horario-remover/);
});

test('lerGradeDaTela lê todas as linhas de cada dia pelo seletor de janela, sem campo único por dia', () => {
  const corpo = APP_JS.match(/function lerGradeDaTela\(\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.match(corpo, /querySelectorAll\(`\.horario-janela\[data-dia="\$\{dia\}"\]`\)/,
    'precisa buscar TODAS as linhas de janela do dia, não um único campo fixo');
});

test('a nota da tela sobre a grade continua descrevendo o comportamento real (dia sem intervalo cala)', () => {
  // Guard de conteúdo mínimo: não é sobre o editor, mas sobre não deixar a
  // instrução da tela mentir depois da mudança de estrutura.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /cala a semana inteira|deixar todos vazios/);
});
