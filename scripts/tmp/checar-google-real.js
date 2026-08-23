#!/usr/bin/env node
'use strict';
// Diagnóstico só-leitura: usa o MESMO módulo que o worker usa
// (criarCalendarioGoogle) para confirmar em qual calendário os eventos
// estão sendo criados de verdade, e se "delegar" (impersonar o usuário)
// está de fato ativo.

const fs = require('node:fs');
const path = require('node:path');
const CAMINHO_ENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(CAMINHO_ENV);

const { carregarConfiguracao } = require('../../src/config');
const { criarCalendarioGoogle, idDoEvento } = require('../../src/integracoes/google-calendario');

async function main() {
  const configuracao = carregarConfiguracao(process.env);
  const g = configuracao.googleAgenda;

  console.log('configurada (credencial+usuario presentes)?', Boolean(g.credencial && g.usuario));
  console.log('configuracao.calendario resolvido:', g.calendario);
  console.log('configuracao.delegar (deveria existir para impersonar o usuario):', g.delegar);

  let credencial = null;
  try { credencial = JSON.parse(g.credencial); } catch { /* ignore */ }
  console.log('client_email da service account (quem realmente autentica):', credencial?.client_email);
  console.log('usuario que DEVERIA ser o dono do calendario:', g.usuario);

  const calendario = criarCalendarioGoogle(g);
  console.log('\ncalendario efetivo usado nas chamadas:', calendario.calendario);

  // Tenta ler o evento do agendamento 55 (o mais recente, sync_status=ok)
  const eventoId = idDoEvento(55);
  console.log('\nBuscando evento', eventoId, 'no calendario', calendario.calendario, '...');
  try {
    const resultado = await calendario.obterEvento(eventoId);
    if (resultado) {
      console.log('ENCONTRADO no calendario', calendario.calendario);
      console.log('  summary:', resultado.evento.summary);
      console.log('  organizer:', JSON.stringify(resultado.evento.organizer));
      console.log('  htmlLink:', resultado.evento.htmlLink);
    } else {
      console.log('NAO encontrado (404) no calendario', calendario.calendario);
    }
  } catch (erro) {
    console.log('ERRO ao buscar:', erro.message, erro.status);
  }

  // Lista quantos eventos existem no calendario 'primary' da service account,
  // numa janela ampla, para confirmar se é ali que tudo está caindo.
  console.log('\nListando eventos no calendario efetivo (janela: hoje-30d a hoje+60d)...');
  try {
    const agora = Date.now();
    const pagina = await calendario.listarPagina({
      timeMin: agora - 30 * 86400000,
      timeMax: agora + 60 * 86400000,
      maxResults: 50,
    });
    console.log('Total de eventos encontrados nessa janela:', pagina.itens.length);
    for (const ev of pagina.itens.slice(0, 10)) {
      console.log(' -', ev.id, '|', ev.summary, '|', ev.start?.dateTime || ev.start?.date);
    }
  } catch (erro) {
    console.log('ERRO ao listar:', erro.message, erro.status);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
