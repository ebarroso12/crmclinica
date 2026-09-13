'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Login contínuo (12/09/2026).
//
// O refresh vivia em `sessionStorage`, que morre quando a aba — ou o app
// instalado no celular — fecha. Resultado: e-mail e senha a cada volta. Agora
// vive em `localStorage`, e quem manda no prazo é o servidor: sete dias,
// renovados a cada uso (o refresh é rotativo).
//
// O que estes testes protegem é o lado perigoso da mudança: "Sair" tem de
// limpar os DOIS lugares. Se o refresh velho sobrar no sessionStorage, a
// próxima carga da aba ressuscita a sessão que a pessoa acabou de encerrar —
// num CRM clínico, é deixar aberta a conta de quem saiu.

const RAIZ = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');

function funcao(nome) {
  const inicio = APP_JS.search(new RegExp(`^function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `public/app.js precisa declarar ${nome}`);
  const resto = APP_JS.slice(inicio + 1);
  const proxima = resto.search(/^(?:async )?function /m);
  return APP_JS.slice(inicio, proxima < 0 ? undefined : inicio + 1 + proxima);
}

test('a sessão é guardada em localStorage, para sobreviver ao fechar do app', () => {
  const guardar = funcao('guardarRefresh');
  assert.match(guardar, /localStorage\.setItem\(CHAVE_REFRESH/);
  assert.ok(!/sessionStorage\.setItem\(CHAVE_REFRESH/.test(APP_JS), 'nada mais grava o refresh em sessionStorage');
});

test('quem já estava logado antes da mudança não é posto para fora', () => {
  // A sessão antiga vive no sessionStorage daquela aba: ela continua valendo.
  const ler = funcao('lerRefresh');
  assert.match(ler, /localStorage\.getItem\(CHAVE_REFRESH\)/);
  assert.match(ler, /sessionStorage\.getItem\(CHAVE_REFRESH\)/);
});

test('Sair limpa os dois lugares — senão a sessão encerrada volta na próxima carga', () => {
  const limpar = funcao('limparSessao');
  assert.match(limpar, /localStorage\.removeItem\(CHAVE_REFRESH\)/);
  assert.match(limpar, /sessionStorage\.removeItem\(CHAVE_REFRESH\)/);
});

test('o access token continua só em memória', () => {
  // Ele é o que abre porta: em armazenamento, qualquer script injetado o lê.
  assert.ok(!/localStorage\.setItem\([^)]*access/i.test(APP_JS));
  assert.ok(!/sessionStorage\.setItem\([^)]*access/i.test(APP_JS));
  assert.match(APP_JS, /^let accessToken = null;$/m);
});

test('a entrada pelo Google usa o mesmo caminho, e não grava por fora', () => {
  assert.match(APP_JS, /guardarRefresh\(refreshTokenGoogle\)/);
});
