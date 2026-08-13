'use strict';

// Comando 5, frente 11 — os três botões que a auditoria do Comando 1 marcou
// como órfãos (public/index.html:217, 287, 433 — sem id, sem data-*, zero
// handler em app.js). Investigação, para cada um, por um fluxo equivalente
// já existente:
//
//   • "Nova tarefa"  — não há rota para CRIAR tarefa manualmente. As únicas
//     que existem são GET /api/tarefas (listar), POST /api/tarefas/varrer
//     (o sino gera automaticamente por acompanhamento) e
//     POST /api/tarefas/:id/concluir. Nenhum fluxo equivalente.
//   • "Nova conversa" — conversas nascem de uma mensagem de ENTRADA (o
//     paciente escreve primeiro) ou são vistas a partir de um lead/contato
//     já existente. Não há hoje nenhum caminho para a equipe iniciar uma
//     conversa do zero (mensagem de saída sem conversa prévia). Nenhum
//     fluxo equivalente.
//   • "Novo lead"    — rotas-leads.js só tem qualificação/estágio/gestão/
//     temperatura de um lead JÁ existente; leads nascem só de
//     `atendimento.receberMensagem` (o contato escreveu). Nenhuma rota cria
//     um lead do zero. Nenhum fluxo equivalente.
//
// Nenhum dos três tem destino real para apontar sem inventar tela, modal
// ou endpoint novo — fora do escopo deste programa. Opção default aplicada:
// remoção, em vez de deixar prometendo uma ação que não faz nada.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('o botão órfão "Nova tarefa" do painel inicial foi removido, não esquecido', () => {
  assert.ok(!/<button[^>]*>Nova tarefa<\/button>/.test(HTML));
});

test('o botão órfão "Nova conversa" do cabeçalho de Conversas foi removido, não esquecido', () => {
  // Cuidado: "Nova conversa" também é o rótulo do botão #teste-reiniciar, no
  // laboratório da Serena (public/index.html:732) — esse é legítimo, tem id
  // e handler de verdade (ver testes/serena-http.test.js e app.js). O
  // órfão era especificamente o do CABEÇALHO da tela de Conversas, sem id
  // nem data-*; a checagem precisa mirar só nesse trecho.
  const cabecalhoDeConversas = HTML.match(/<h2 id="titulo-conversas">[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  assert.ok(cabecalhoDeConversas, 'o bloco do cabeçalho de Conversas precisa existir para o teste fazer sentido');
  assert.ok(!/<button[^>]*>Nova conversa<\/button>/.test(cabecalhoDeConversas));

  // E o botão legítimo do laboratório continua de pé, intocado.
  assert.match(HTML, /id="teste-reiniciar">Nova conversa<\/button>/);
});

test('o botão órfão "Novo lead" da tela de Leads foi removido, não esquecido', () => {
  assert.ok(!/<button[^>]*>Novo lead<\/button>/.test(HTML));
});

test('nenhum dos três textos órfãos sobra em app.js como handler morto', () => {
  // Nenhum dos três nomes precisa aparecer em app.js: não havia handler
  // antes (é o próprio defeito), e continua não havendo — a remoção é só
  // no HTML.
  for (const rotulo of ['Nova tarefa', 'Nova conversa', 'Novo lead']) {
    assert.ok(!APP_JS.includes(rotulo), `"${rotulo}" não deveria aparecer em app.js`);
  }
});

test('os cabeçalhos das três telas continuam existindo — só o botão saiu', () => {
  assert.match(HTML, /<h2 id="titulo-painel">Bom dia, equipe<\/h2>/);
  assert.match(HTML, /<h2 id="titulo-conversas">Conversas<\/h2>/);
  assert.match(HTML, /<h2 id="titulo-leads">Leads<\/h2>/);
});

test('os outros botões dos mesmos cabeçalhos (que têm handler de verdade) continuam intactos', () => {
  // Prova de que a remoção foi cirúrgica: os botões ligados que dividiam
  // linha com os órfãos não foram arrastados junto.
  assert.match(HTML, /data-tela="conversas">Ver todas<\/button>/, 'painel: "Ver todas" continua');
});
