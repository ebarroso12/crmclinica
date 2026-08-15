'use strict';

// Gate 2 da auditoria ("chat realmente ao vivo", 2026-08-15): antes deste
// commit, `reagirAEventoDeConversa` (public/app.js) só reagia a
// mensagem_recebida/mensagem_enviada — status_entrega, conversa_assumida,
// conversa_devolvida, conversa_resolvida e erro (envio abortado pela
// barreira) eram publicados no log durável (migration 037, Pendência 4) mas
// IGNORADOS pela tela: só apareciam ao trocar de conversa ou recarregar a
// página. Mesmo padrão estrutural de entrega-nao-realizada-ui.test.js (sem
// DOM/jsdom neste repositório: a prova é ler o código-fonte e conferir o
// padrão).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Os 7 tipos do CHECK de conversas_eventos (db/037_conversas_eventos_duraveis.sql).
const TIPOS_DO_CHECK_DE_EVENTOS = [
  'mensagem_recebida', 'mensagem_enviada', 'status_entrega',
  'conversa_assumida', 'conversa_devolvida', 'conversa_resolvida', 'erro',
];

test('todo tipo do CHECK de conversas_eventos está na lista que a tela reage ao vivo', () => {
  const trecho = APP_JS.match(/const TIPOS_DE_EVENTO_CONHECIDOS = \[([\s\S]*?)\];/);
  assert.ok(trecho, 'reagirAEventoDeConversa precisa declarar a lista de tipos conhecidos');

  for (const tipo of TIPOS_DO_CHECK_DE_EVENTOS) {
    assert.match(trecho[1], new RegExp(`'${tipo}'`), `"${tipo}" precisa estar na lista — senão a tela ignora esse evento em silêncio`);
  }
});

test('reagirAEventoDeConversa não filtra mais só por mensagem — usa a lista completa', () => {
  // O defeito original: `const tiposDeMensagem = ['mensagem_recebida', 'mensagem_enviada']`
  // seguido de um `if (!tiposDeMensagem.includes(...)) return`. Confirma que
  // esse padrão específico não existe mais — não é suficiente checar que a
  // lista nova existe em algum lugar do arquivo se o filtro velho continuar
  // ativo em paralelo.
  assert.doesNotMatch(APP_JS, /tiposDeMensagem\s*=\s*\['mensagem_recebida',\s*'mensagem_enviada'\]/,
    'o filtro antigo, restrito a mensagem, não pode mais existir');
});

test('conversa aberta refaz a thread para qualquer evento reconhecido, não só mensagem', () => {
  // A chamada que busca a thread atualizada tem que estar DEPOIS do guard de
  // tipos conhecidos (early return) e não duplicada dentro de um `if` que só
  // cobre tipo de mensagem.
  const indiceGuarda = APP_JS.indexOf('TIPOS_DE_EVENTO_CONHECIDOS.includes(dados?.tipo)');
  const indiceThread = APP_JS.indexOf('desenharThread', indiceGuarda);
  assert.ok(indiceGuarda >= 0 && indiceThread > indiceGuarda,
    'a atualização da thread aberta precisa vir depois do guard geral, para valer para todo tipo conhecido');
});
