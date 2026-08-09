'use strict';

// Aviso automático à equipe quando uma marcação é criada.
//
// Roda no lado servidor (ponte), onde a CLI `openclaw` e o gateway interno da
// clínica existem. Na Vercel (serverless) a CLI não existe: `execFile` falha e
// o `callback` só registra no log — a marcação NÃO cai por isso (fire-and-forget).
const { execFile } = require('node:child_process');

// Números humanos que recebem o aviso. Sobrescrever com a env `CRM_AVISO_EQUIPE`
// (lista separada por vírgula) quando precisar — em produção, os três abaixo.
const PADRAO = ['+5516992943215', '+5516993624116', '+5516997522881'];

function numeros() {
  const e = (process.env.CRM_AVISO_EQUIPE || '').trim();
  if (!e) return PADRAO;
  return e.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function avisarMarcacao(d) {
  const alvos = numeros();
  if (!alvos.length) return;
  let msg = 'Nova marcacao - Dr. Edson\n';
  msg += 'Paciente: ' + ((d && d.nome) || 'paciente');
  if (d && d.telefone) msg += ' | Tel: ' + d.telefone;
  msg += '\nData: ' + ((d && d.quando) || '');
  msg += '\n(aviso automatico do CRM)';

  const env = Object.assign({}, process.env, {
    PATH: '/root/.nvm/versions/node/v24.18.0/bin:' + (process.env.PATH || ''),
    OPENCLAW_GATEWAY_URL: 'ws://172.17.0.1:18790',
  });

  for (const target of alvos) {
    execFile('openclaw', [
      '--profile', 'clinica', 'message', 'send',
      '--channel', 'whatsapp', '--target', target, '--message', msg,
    ], { env: env, timeout: 30000 }, function (err) {
      if (err) console.error('[aviso-equipe] falha ' + target + ': ' + err.message);
      else console.log('[aviso-equipe] enviado ' + target);
    });
  }
}

module.exports = { avisarMarcacao };
