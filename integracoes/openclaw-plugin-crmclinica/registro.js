import path from 'node:path';
import { criarPonte, decisaoDeSilencio, ehWhatsapp } from './ponte.js';

export function registrarPlugin(api, ambiente = process.env) {
  // Esta barreira vem primeiro de propósito. Se endpoint, segredo ou disco
  // estiverem mal configurados, o WhatsApp continua silencioso em vez de cair
  // para a resposta direta do agente fora do CRM.
  api.on('before_agent_reply', (_evento, contexto) => {
    return decisaoDeSilencio(contexto);
  }, { priority: 10_000, eligibleTriggers: ['user'] });

  const pastaPadrao = path.join(
    api.runtime?.state?.resolveStateDir?.() || api.rootDir || process.cwd(),
    'crmclinica-ingresso-whatsapp',
  );

  let ponte;
  try {
    ponte = criarPonte({
      endpoint: ambiente.CRMCLINICA_INGRESS_URL,
      segredo: ambiente.WHATSAPP_WEBHOOK_SECRET,
      pasta: ambiente.CRMCLINICA_INGRESS_SPOOL_DIR || pastaPadrao,
      logger: api.logger,
    });
  } catch (erro) {
    api.logger.error?.(`[crmclinica-ingresso] ponte indisponível; agente WhatsApp permanece silencioso (${erro.message})`);
    return { configurada: false, erro: erro.message };
  }

  api.on('message_received', async (evento, contexto) => {
    if (!ehWhatsapp(evento, contexto)) return;
    await ponte.receber(evento, contexto);
  }, { timeoutMs: 10_000 });

  api.on('gateway_start', () => ponte.iniciar());
  api.on('gateway_stop', () => ponte.parar());
  return { configurada: true };
}
