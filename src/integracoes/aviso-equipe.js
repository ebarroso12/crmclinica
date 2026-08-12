'use strict';

// Envio à equipe interna da clínica. Um único veículo: o `openclaw message send`
// para os três números internos. A marcação simples e o resumo completo do lead
// saem pela MESMA porta — muda só o texto.
//
// Roda no lado servidor (ponte), onde a CLI `openclaw` e o gateway da clínica
// existem. Na Vercel (serverless) a CLI não existe: `execFile` falha e o callback
// só registra no log — nada do fluxo do paciente cai por isso (fire-and-forget).
const { execFile } = require('node:child_process');

// Números humanos que recebem os avisos internos. Sobrescrever com a env
// `CRM_AVISO_EQUIPE` (lista separada por vírgula) quando precisar.
const PADRAO = ['+5516992943215', '+5516993624116', '+5516997522881'];

function numeros() {
  const e = (process.env.CRM_AVISO_EQUIPE || '').trim();
  if (!e) return PADRAO;
  return e.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

// O veículo. Todo envio interno passa por aqui.
function disparar(msg) {
  const alvos = numeros();
  const texto = String(msg || '').trim();
  if (!alvos.length || !texto) return;

  const env = Object.assign({}, process.env, {
    PATH: '/root/.nvm/versions/node/v24.18.0/bin:' + (process.env.PATH || ''),
    OPENCLAW_GATEWAY_URL: 'ws://172.17.0.1:18790',
  });

  for (const target of alvos) {
    execFile('openclaw', [
      '--profile', 'clinica', 'message', 'send',
      '--channel', 'whatsapp', '--target', target, '--message', texto,
    ], { env: env, timeout: 30000 }, function (err) {
      if (err) console.error('[aviso-equipe] falha ' + target + ': ' + err.message);
      else console.log('[aviso-equipe] enviado ' + target);
    });
  }
}

// Resumo COMPLETO do lead, montado pela Serena a partir da conversa. Mesmo
// veículo, mesmos três números — mas com a inteligência da conversa, não o
// resumo mínimo. NUNCA vai para o paciente: quem chama passa só o texto interno.
function enviarResumo(texto) {
  disparar(texto);
}

// Aviso mínimo de marcação. Mantido para compatibilidade, mas já não é o que a
// equipe recebe: o resumo completo o substituiu.
function avisarMarcacao(d) {
  let msg = 'Nova marcacao - Dr. Edson\n';
  msg += 'Paciente: ' + ((d && d.nome) || 'paciente');
  if (d && d.telefone) msg += ' | Tel: ' + d.telefone;
  msg += '\nData: ' + ((d && d.quando) || '');
  msg += '\n(aviso automatico do CRM)';
  disparar(msg);
}

module.exports = { avisarMarcacao, enviarResumo };
