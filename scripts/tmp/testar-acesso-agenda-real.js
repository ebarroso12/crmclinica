#!/usr/bin/env node
'use strict';
// Testa, só leitura, se a conta de servico ja consegue enxergar a agenda
// PESSOAL do Edson (precisa ter sido compartilhada no Google Calendar).
const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);

const { carregarConfiguracao } = require('../../src/config');
const { criarCalendarioGoogle } = require('../../src/integracoes/google-calendario');

async function main() {
  const configuracao = carregarConfiguracao(process.env);
  const alvo = 'edson.barroso@gmail.com';
  const calendario = criarCalendarioGoogle({ ...configuracao.googleAgenda, calendario: alvo });

  console.log('Testando acesso a calendario:', alvo);
  try {
    const agora = Date.now();
    const pagina = await calendario.listarPagina({
      timeMin: agora - 7 * 86400000,
      timeMax: agora + 30 * 86400000,
      maxResults: 10,
    });
    console.log('AC ESSO CONFIRMADO. Eventos nessa janela:', pagina.itens.length);
    for (const ev of pagina.itens.slice(0, 5)) {
      console.log(' -', ev.summary, '|', ev.start?.dateTime || ev.start?.date, '| organizer:', ev.organizer?.email);
    }
  } catch (erro) {
    console.log('SEM ACESSO. status=', erro.status, 'mensagem=', erro.message);
  }
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
