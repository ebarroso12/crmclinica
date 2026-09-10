'use strict';

const { criarClienteGateway, carregarOuCriarIdentidade, ESCOPOS_DE_CANAL } = require('./openclaw-gateway');
const { normalizarTelefone } = require('../dominio/serena');

// Envio de mensagem da equipe (ou da automação) para o paciente, pelo
// WhatsApp da clínica.
//
// Sem isto, responder pelo painel só gravava no banco: a equipe escrevia, via a
// mensagem na tela, e do outro lado ninguém recebia nada. O inbox parecia um
// atendimento e era um bloco de notas.
//
// Duas vias, nesta ordem:
//   1. Evolution API (REST) — quando configurada, é a via PRIMÁRIA: não
//      depende de um processo de gateway sempre conectado.
//   2. Gateway WebSocket do OpenClaw — reserva. Continua exatamente como
//      antes: o mesmo `send` que os lembretes usam, protocolo já provado.
// A chave de idempotência, derivada da mensagem gravada, vale para a via 2;
// a via 1 não tem idempotência nativa nesse endpoint — ver o aviso em
// evolution-envio.js.

function criarCanalDeConversas(configuracao = {}, dependencias = {}) {
  let cliente = dependencias.cliente ?? null;
  const evolucao = dependencias.evolucao ?? null;
  const instagram = dependencias.instagram ?? null;

  function conectar() {
    if (cliente) return cliente;
    if (!configuracao.url) return null;

    cliente = criarClienteGateway({
      url: configuracao.url,
      token: configuracao.token || null,
      deviceToken: configuracao.deviceToken || null,
      identidade: carregarOuCriarIdentidade(configuracao.identidadePath, configuracao.chavePrivada),
      timeoutMs: configuracao.timeoutMs ?? 30000,
      escopos: ESCOPOS_DE_CANAL,
    });
    return cliente;
  }

  async function enviarPeloGateway(destino, texto, chave) {
    const gateway = conectar();
    if (!gateway) throw new Error('canal do WhatsApp não configurado');

    const resposta = await gateway.chamar('send', {
      channel: 'whatsapp',
      to: destino.startsWith('+') ? destino : `+${destino}`,
      message: texto,
      idempotencyKey: chave,
    });

    const identificador = resposta?.messageId ?? resposta?.id ?? null;
    if (!identificador) throw new Error('o gateway não confirmou o envio');

    return { identificador };
  }

  return {
    disponivel: Boolean(configuracao.url) || Boolean(evolucao?.disponivel) || Boolean(instagram?.disponivel),

    /**
     * Entrega a mensagem e devolve o identificador confirmado.
     *
     * Tenta a Evolution primeiro quando disponível; se falhar (ou não
     * estiver configurada), cai para o gateway do OpenClaw — nunca o
     * contrário, e nunca silenciosamente sem tentar as duas quando ambas
     * existem. Sem identificador não há confirmação, e sem confirmação a
     * mensagem não pode ser dada como entregue.
     *
     * Quando `canal === 'instagram'`, o envio vai pela Graph API do Instagram
     * (instagram-envio.js) em vez das vias de WhatsApp.
     */
    async enviar({ canal: canalDestino = 'whatsapp', telefone, texto, chave, instancia = null }) {
      // Conversa de agente (docs/AGENTES.md, invariante 2): ela só pode sair
      // pelo número do próprio agente. O Instagram daqui é a conta da clínica —
      // Instagram de agente ainda não existe, então recusar é o único seguro.
      if (instancia && canalDestino === 'instagram') {
        throw new Error('Instagram de agente ainda não é suportado: a conversa não pode sair pela conta da clínica');
      }

      if (canalDestino === 'instagram') {
        if (!instagram?.disponivel) throw new Error('Instagram API não configurada');
        // No Instagram o "telefone" é o PSID (page-scoped id) — quem chama
        // (entregarAoPaciente) já extraiu o identificador correto.
        return instagram.enviar({ telefone, texto });
      }

      // O contato guarda o telefone como o canal o entregou, e isso inclui
      // mascara. Normalizar aqui evita mandar para um numero que nao existe.
      // Feito uma vez só: as duas vias recebem o mesmo dado normalizado.
      const destino = normalizarTelefone(telefone);
      if (!destino) throw new Error('telefone inválido para envio');

      if (instancia) {
        // Só a Evolution, e sem reserva. O gateway do OpenClaw é o WhatsApp DA
        // CLÍNICA: cair nele aqui mandaria a resposta do agente a partir do
        // número da clínica — pior que não entregar, porque o cliente recebe
        // de um número que não conhece e a conversa se parte em duas. A falha
        // sobe inteira (inclusive `indeterminado`) para quem chama decidir.
        if (!evolucao?.disponivel) {
          throw new Error('Evolution API não configurada: a conversa do agente só sai pela instância dele');
        }
        return evolucao.enviar({ telefone: destino, texto, chave, instancia });
      }

      if (evolucao?.disponivel) {
        try {
          return await evolucao.enviar({ telefone: destino, texto, chave });
        } catch (erroEvolucao) {
          // Indeterminado (timeout): não sabemos se a Evolution já entregou.
          // Cair para a reserva aqui seria o pior caso possível — duas vias
          // tentando mandar a mesma mensagem ao mesmo tempo. Melhor propagar a
          // incerteza e deixar quem chama decidir (não retentar sozinho).
          if (erroEvolucao.indeterminado) throw erroEvolucao;
          if (!configuracao.url) throw erroEvolucao; // sem reserva configurada, o erro é o que há
          console.warn(`[canal] Evolution falhou, tentando o gateway do OpenClaw como reserva: ${erroEvolucao.message}`);
        }
      }

      return enviarPeloGateway(destino, texto, chave);
    },

    /**
     * Entrega um anexo (imagem/documento/áudio/vídeo) ao paciente.
     *
     * Só a Evolution API: o protocolo `send` do gateway WebSocket do OpenClaw
     * nunca teve suporte a mídia confirmado (é outro processo, no VPS, fora
     * do que este projeto testa) — arriscar mandar um anexo por um canal sem
     * contrato conhecido é pior do que recusar com um erro claro.
     */
    async enviarMidia({
      canal: canalDestino = 'whatsapp', telefone, mediaUrl, tipo, legenda, nomeArquivo, instancia = null,
    }) {
      if (canalDestino === 'instagram') {
        throw new Error(instancia
          ? 'Instagram de agente ainda não é suportado: a conversa não pode sair pela conta da clínica'
          : 'envio de anexo pelo Instagram ainda não é suportado');
      }

      const destino = normalizarTelefone(telefone);
      if (!destino) throw new Error('telefone inválido para envio');
      if (!evolucao?.disponivel) throw new Error('envio de anexo exige a Evolution API configurada');

      // Mídia já não tinha reserva no gateway; com instância, só muda o número de origem.
      return evolucao.enviarMidia({
        telefone: destino, mediaUrl, tipo, legenda, nomeArquivo, ...(instancia ? { instancia } : {}),
      });
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarCanalDeConversas };
