'use strict';

const crypto = require('node:crypto');

// Integração isolada com o OpenClaw, o orquestrador de eventos, ferramentas e tarefas.
// Nenhum outro arquivo fala HTTP com o orquestrador; se a API dele mudar, muda só aqui.

/**
 * Confere a assinatura HMAC-SHA256 de um webhook do orquestrador.
 * Comparação em tempo constante, para não vazar o segredo por diferença de tempo.
 */
function assinaturaValida({ corpoBruto, assinaturaRecebida, segredo }) {
  if (!segredo || typeof assinaturaRecebida !== 'string' || !assinaturaRecebida) return false;

  const esperada = crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex');
  const recebida = assinaturaRecebida.replace(/^sha256=/i, '').trim().toLowerCase();
  if (recebida.length !== esperada.length) return false;

  return crypto.timingSafeEqual(Buffer.from(esperada, 'utf8'), Buffer.from(recebida, 'utf8'));
}

function assinar(corpoBruto, segredo) {
  return `sha256=${crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
}

function criarClienteOpenClaw(configuracao, dependencias = {}) {
  const requisicao = dependencias.fetch || globalThis.fetch;
  const { baseUrl, token, sessao, tempoLimiteMs } = configuracao;

  const cabecalhosBase = {
    authorization: `Bearer ${token}`,
    ...(sessao ? { 'x-openclaw-sessao': sessao } : {}),
  };

  const disponivel = Boolean(baseUrl && token);

  async function enviar(caminho, dados) {
    if (!disponivel) {
      // Sem credencial o sistema segue operando: a integração apenas não é exercida.
      const erro = new Error('Integração com o OpenClaw não está configurada');
      erro.codigo = 'openclaw_nao_configurado';
      throw erro;
    }

    const cancelamento = AbortSignal.timeout(tempoLimiteMs);
    const resposta = await requisicao(`${baseUrl}${caminho}`, {
      method: 'POST',
      headers: { ...cabecalhosBase, 'content-type': 'application/json' },
      body: JSON.stringify(dados),
      signal: cancelamento,
    });

    if (!resposta.ok) {
      const erro = new Error(`OpenClaw respondeu HTTP ${resposta.status}`);
      erro.codigo = 'openclaw_resposta_invalida';
      erro.status = resposta.status;
      throw erro;
    }

    return resposta.json();
  }

  return {
    disponivel,

    /** Entrega ao orquestrador um evento já validado pelo contrato. */
    despacharEvento(evento) {
      return enviar('/eventos', {
        chave_idempotencia: evento.chave_idempotencia,
        evento,
      });
    },

    /** Consulta a saúde do orquestrador sem derrubar o CRM se ele estiver fora. */
    async verificarSaude() {
      if (!disponivel) return { estado: 'nao_configurado' };
      try {
        const cancelamento = AbortSignal.timeout(tempoLimiteMs);
        const resposta = await requisicao(`${baseUrl}/health`, {
          headers: cabecalhosBase,
          signal: cancelamento,
        });
        return { estado: resposta.ok ? 'operacional' : 'degradado' };
      } catch {
        return { estado: 'indisponivel' };
      }
    },
  };
}

module.exports = { criarClienteOpenClaw, assinaturaValida, assinar };
