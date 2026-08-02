'use strict';

// Kimi é um provedor opcional de modelo, nunca o controlador do produto.
// Quem decide o que fazer com uma conversa é o OpenClaw (orquestração) junto da Serena
// (regras de atendimento). Este arquivo só sabe pedir texto a um modelo e devolver texto.
// Sem chave configurada, o sistema segue funcionando — apenas sem provedor.

const TEMPO_LIMITE_PADRAO_MS = 20000;

function criarProvedorKimi(configuracao = {}, dependencias = {}) {
  const requisicao = dependencias.fetch || globalThis.fetch;
  const chave = configuracao.chave || '';
  const baseUrl = (configuracao.baseUrl || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
  const modelo = configuracao.modelo || 'kimi-latest';
  const tempoLimiteMs = configuracao.tempoLimiteMs || TEMPO_LIMITE_PADRAO_MS;

  return {
    nome: 'kimi',
    papel: 'provedor opcional de modelo',
    disponivel: Boolean(chave),

    async completar(mensagens, opcoes = {}) {
      if (!chave) {
        const erro = new Error('Provedor Kimi não está configurado');
        erro.codigo = 'kimi_nao_configurado';
        throw erro;
      }
      if (!Array.isArray(mensagens) || mensagens.length === 0) {
        throw new Error('mensagens deve ser uma lista não vazia');
      }

      const resposta = await requisicao(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opcoes.modelo || modelo,
          messages: mensagens,
          temperature: opcoes.temperatura ?? 0.2,
        }),
        signal: AbortSignal.timeout(tempoLimiteMs),
      });

      if (!resposta.ok) {
        const erro = new Error(`Provedor Kimi respondeu HTTP ${resposta.status}`);
        erro.codigo = 'kimi_resposta_invalida';
        erro.status = resposta.status;
        throw erro;
      }

      const dados = await resposta.json();
      const texto = dados?.choices?.[0]?.message?.content;
      if (!texto) throw new Error('Resposta do provedor Kimi sem conteúdo');
      return texto;
    },
  };
}

module.exports = { criarProvedorKimi };
