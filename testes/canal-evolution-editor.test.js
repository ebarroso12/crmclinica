'use strict';

// Comando 4, frente 8 — guardas do cartão "WhatsApp da clínica" e do botão
// "Conectar WhatsApp" em public/app.js: precisam refletir a Evolution API
// como canal efetivo, não só o gateway do OpenClaw. Mesma limitação de
// testabilidade documentada em testes/horario-grade-editor.test.js: sem
// bundler nem DOM headless neste projeto, a prova aqui é estrutural — o
// comportamento real (o que a rota devolve) está coberto, com HTTP de
// verdade, em testes/serena-canal-http.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('desenharEstadoDoCanal considera canal.evolucao antes de anunciar indisponibilidade', () => {
  const corpo = APP_JS.match(/async function desenharEstadoDoCanal\(\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(corpo, 'desenharEstadoDoCanal precisa existir');
  assert.match(corpo, /canal\.evolucao/, 'precisa ler o campo evolucao da resposta');
  assert.match(corpo, /evolucaoOk/);
  // A frase antiga que só falava do gateway, sem citar a Evolution, não pode voltar.
  assert.ok(!/`conexão indisponível — \$\{canal\.motivo/.test(corpo),
    'a frase antiga (só sobre o gateway) não pode voltar sozinha');
});

test('o botão "Conectar WhatsApp" avisa quando é a via de reserva', () => {
  const corpo = APP_JS.match(/async function desenharEstadoDoCanal\(\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.match(corpo, /Conectar WhatsApp \(reserva\)/);
});
