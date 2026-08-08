import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registrarPlugin } from './registro.js';

export default definePluginEntry({
  id: 'crmclinica-ingresso-whatsapp',
  name: 'CRM Clínica — ingresso WhatsApp',
  description: 'Entrega o inbound do WhatsApp ao CRM e silencia o agente direto.',
  register(api) {
    registrarPlugin(api);
  },
});
