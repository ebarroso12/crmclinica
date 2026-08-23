#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);
const { carregarConfiguracao } = require('../../src/config');
const { criarCalendarioGoogle } = require('../../src/integracoes/google-calendario');

async function main() {
  const configuracao = carregarConfiguracao(process.env);
  const calendario = criarCalendarioGoogle(configuracao.googleAgenda);
  const agora = Date.now();
  const pagina = await calendario.listarPagina({
    timeMin: agora - 10 * 86400000,
    timeMax: agora + 20 * 86400000,
    maxResults: 50,
  });
  const dosPacientes = pagina.itens.filter((e) => /^crmagendamento/.test(e.id));
  console.log('Eventos criados pelo CRM encontrados na agenda real:', dosPacientes.length);
  for (const ev of dosPacientes) {
    console.log(' -', ev.id, '|', ev.summary, '|', ev.start?.dateTime, '| organizer:', ev.organizer?.email);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
