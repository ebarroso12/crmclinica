'use strict';

// Achado de 13/09/2026: bin/worker-heartbeat.js gravava 'serena'/'inbox' como
// 'ok' INCONDICIONAL a cada ciclo, sem checar coisa nenhuma — não a porta da
// própria ponte de ingresso (crmclinica-ponte.service), nem processo, nem
// banco. `crmclinica-heartbeat.service` e `crmclinica-ponte.service` são
// unidades systemd INDEPENDENTES no mesmo VPS: uma cair não tira a outra do
// ar. Foi exatamente essa independência que deixou o incidente de 12h
// (ponte enabled+inactive+zero log, paciente esperando desde a véspera)
// invisível na tabela `system_heartbeats` e no cartão "Hoje" do painel
// (que lê `batimentos.inbox` em src/servidor/http.js, rota /api/resumo) —
// o próprio mecanismo de detecção nunca olhava para o componente que caiu.
//
// bin/worker-heartbeat.js não é seguro de `require`-ar num teste: ele
// conecta ao banco e abre um `setInterval` no topo do arquivo (mesma razão
// de testes/transporte-whatsapp-atendimento.test.js para bin/worker-lembretes.js).
// A prova aqui é estrutural.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FONTE = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-heartbeat.js'), 'utf8');

test('worker-heartbeat.js não grava mais "ok" incondicional para serena/inbox', () => {
  assert.ok(
    !/up\(pool, 'serena', 'ok',/.test(FONTE) && !/up\(pool, 'inbox', 'ok',/.test(FONTE),
    'o valor de status não pode mais ser um literal fixo — tem de vir de uma checagem real',
  );
});

test('worker-heartbeat.js checa a porta da própria ponte antes de reportar serena/inbox', () => {
  assert.match(
    FONTE,
    /checarPorta\(enderecoDaPonte, configuracao\.porta, PONTE_TIMEOUT_MS\)/,
    'precisa perguntar à própria ponte (configuracao.porta), não presumir que está viva',
  );
  assert.match(
    FONTE,
    /up\(pool, 'serena', ponteViva \? 'ok' : 'degradado', detalhePonte\)/,
    'o resultado da checagem tem de decidir o status gravado',
  );
  assert.match(
    FONTE,
    /up\(pool, 'inbox', ponteViva \? 'ok' : 'degradado', detalhePonte\)/,
  );
});

test("worker-heartbeat.js não tenta discar '0.0.0.0' — isso nunca conecta, e derrubaria o batimento sozinho", () => {
  // `configuracao.endereco` pode nascer '0.0.0.0' em produção sem HOST
  // explícito (src/config.js) — é um endereço de BIND, não de conexão.
  // Sem este desvio, o próprio teste de vida quebraria sempre que HOST não
  // estiver setado, mesmo com a ponte perfeitamente viva.
  assert.match(FONTE, /configuracao\.endereco === '0\.0\.0\.0' \? '127\.0\.0\.1' : configuracao\.endereco/);
});
