#!/usr/bin/env node
'use strict';
// Batimento de saude dos componentes vivos -> tabela system_heartbeats.
// O painel (Vercel) nao alcanca a rede interna; quem enxerga grava aqui.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);
const { criarPool } = require('../src/dados/pool');
const { carregarConfiguracao } = require('../src/config');
const INTERVALO_MS = Number(process.env.CRM_BATIMENTO_INTERVALO_MS) || 30000;
const GATEWAY_HOST = '172.17.0.1';
const GATEWAY_PORTA = 18790;
function checarPorta(host, porta, ms) {
  return new Promise(function (res) {
    const s = new net.Socket(); let d = false;
    function fim(ok) { if (d) return; d = true; try { s.destroy(); } catch (e) {} res(ok); }
    s.setTimeout(ms);
    s.once('connect', function () { fim(true); });
    s.once('timeout', function () { fim(false); });
    s.once('error', function () { fim(false); });
    s.connect(porta, host);
  });
}
async function up(pool, c, st, det) {
  await pool.query(
    "INSERT INTO system_heartbeats (componente,status,detalhe,updated_at) VALUES ($1,$2,$3,now()) "
    + "ON CONFLICT (componente) DO UPDATE SET status=EXCLUDED.status, detalhe=EXCLUDED.detalhe, updated_at=now()",
    [c, st, det ? JSON.stringify(det) : null],
  );
}
async function main() {
  const pool = criarPool(carregarConfiguracao().banco);
  let parando = false;
  async function ciclo() {
    try {
      const oc = await checarPorta(GATEWAY_HOST, GATEWAY_PORTA, 3000);
      await up(pool, 'serena', 'ok', { fonte: 'ponte' });
      await up(pool, 'inbox', 'ok', { fonte: 'ponte' });
      await up(pool, 'openclaw', oc ? 'ok' : 'degradado', { gateway: GATEWAY_HOST + ':' + GATEWAY_PORTA, alcancavel: oc });
    } catch (e) { console.error('[batimento] ' + e.message); }
  }
  await ciclo();
  const timer = setInterval(function () { if (!parando) ciclo(); }, INTERVALO_MS);
  function encerrar() { parando = true; clearInterval(timer); pool.end().finally(function () { process.exit(0); }); }
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
  console.log('[batimento] worker iniciado, intervalo ' + INTERVALO_MS + 'ms');
}
main().catch(function (e) { console.error('[batimento] fatal: ' + e.message); process.exit(1); });
