'use strict';

const { criarClienteGateway, carregarOuCriarIdentidade, ESCOPOS_DE_CANAL } = require('./openclaw-gateway');

// Envio de mensagem da equipe para o paciente, pelo WhatsApp da clínica.
//
// Sem isto, responder pelo painel só gravava no banco: a equipe escrevia, via a
// mensagem na tela, e do outro lado ninguém recebia nada. O inbox parecia um
// atendimento e era um bloco de notas.
//
// É o mesmo `send` que os lembretes usam — o protocolo já estava provado. O que
// muda é a chave de idempotência, derivada da mensagem gravada: um clique duplo
// ou uma retentativa da rede não faz o paciente receber a resposta duas vezes.

function criarCanalDeConversas(configuracao = {}, dependencias = {}) {
  let cliente = dependencias.cliente ?? null;

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

  return {
    disponivel: Boolean(configuracao.url),

    /**
     * Entrega a mensagem e devolve o identificador que o gateway confirmou.
     *
     * Sem identificador não há confirmação, e sem confirmação a mensagem não
     * pode ser dada como entregue — a mesma regra que vale para os lembretes.
     */
    async enviar({ telefone, texto, chave }) {
      const gateway = conectar();
      if (!gateway) throw new Error('canal do WhatsApp não configurado');

      const resposta = await gateway.chamar('send', {
        channel: 'whatsapp',
        to: telefone.startsWith('+') ? telefone : `+${telefone}`,
        message: texto,
        idempotencyKey: chave,
      });

      const identificador = resposta?.messageId ?? resposta?.id ?? null;
      if (!identificador) throw new Error('o gateway não confirmou o envio');

      return { identificador };
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarCanalDeConversas };
