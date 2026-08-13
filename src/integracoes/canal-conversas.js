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
    disponivel: Boolean(configuracao.url) || Boolean(evolucao?.disponivel),

    /**
     * Entrega a mensagem e devolve o identificador confirmado.
     *
     * Tenta a Evolution primeiro quando disponível; se falhar (ou não
     * estiver configurada), cai para o gateway do OpenClaw — nunca o
     * contrário, e nunca silenciosamente sem tentar as duas quando ambas
     * existem. Sem identificador não há confirmação, e sem confirmação a
     * mensagem não pode ser dada como entregue.
     */
    async enviar({ telefone, texto, chave }) {
      // O contato guarda o telefone como o canal o entregou, e isso inclui
      // mascara. Normalizar aqui evita mandar para um numero que nao existe.
      // Feito uma vez só: as duas vias recebem o mesmo dado normalizado.
      const destino = normalizarTelefone(telefone);
      if (!destino) throw new Error('telefone inválido para envio');

      if (evolucao?.disponivel) {
        try {
          return await evolucao.enviar({ telefone: destino, texto, chave });
        } catch (erroEvolucao) {
          if (!configuracao.url) throw erroEvolucao; // sem reserva configurada, o erro é o que há
          console.warn(`[canal] Evolution falhou, tentando o gateway do OpenClaw como reserva: ${erroEvolucao.message}`);
        }
      }

      return enviarPeloGateway(destino, texto, chave);
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarCanalDeConversas };
