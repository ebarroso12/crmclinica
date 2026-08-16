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

// Achado da auditoria adversarial deste lote: sem coalescência, CADA evento
// vira uma chamada HTTP. O replay de reconexão entrega até 500 eventos de uma
// vez (`listarEventosDeConversasDesde`), e a tela dispararia centenas de
// requisições em rajada — por aba. Numa recepção com várias abas isso ataca o
// próprio servidor que este lote veio consertar.
test('as recargas disparadas por evento ao vivo são coalescidas numa janela', () => {
  assert.match(APP_JS, /const JANELA_DE_COALESCENCIA_MS = \d+/,
    'precisa existir uma janela de coalescência declarada e nomeada');

  const corpo = APP_JS.match(/function reagirAEventoDeConversa\(dados\) \{[\s\S]*?\n\}/);
  assert.ok(corpo, 'reagirAEventoDeConversa precisa existir');

  assert.match(corpo[0], /if \(recargaDeEventosAgendada\) return;/,
    'evento que chega com recarga já agendada precisa entrar nela, não criar outra');
  assert.match(corpo[0], /setTimeout\([\s\S]*JANELA_DE_COALESCENCIA_MS\)/,
    'a recarga precisa ser adiada pela janela, não disparada na hora');

  // O que de fato impede a rajada: nenhuma chamada de rede solta ANTES do
  // setTimeout. Se `carregarConversas()` voltar para fora da janela, a
  // rajada volta junto — e este teste é quem pega isso.
  const antesDoTimer = corpo[0].split('setTimeout')[0];
  assert.doesNotMatch(antesDoTimer, /carregarConversas\(\)/,
    'carregarConversas não pode ser chamada fora da janela de coalescência');
  assert.doesNotMatch(antesDoTimer, /pedirJson\(/,
    'nenhuma requisição pode sair fora da janela de coalescência');
});

test('o timer de recarga é cancelado ao encerrar os eventos (logout não dispara requisição órfã)', () => {
  const corpo = APP_JS.match(/function encerrarEventosDeConversas\(\) \{[\s\S]*?\n\}/);
  assert.ok(corpo, 'encerrarEventosDeConversas precisa existir');
  assert.match(corpo[0], /clearTimeout\(recargaDeEventosAgendada\)/,
    'sem isto, uma recarga agendada dispara depois do logout, já sem token');
});
