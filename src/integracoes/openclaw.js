'use strict';
const crypto = require('node:crypto');

// Integração com o OpenClaw, o orquestrador de eventos, ferramentas e tarefas.
//
// ------------------------------------------------------------------ arquitetura
//
// O OpenClaw controla a conversa (Arquitetura A — ver docs/ADR-TRANSPORTE-MENSAGENS-SERENA.md).
//
// O WhatsApp do paciente está conectado ao OpenClaw. Quando o paciente escreve,
// o OpenClaw recebe e a Serena responde diretamente no canal. O CRM atua como:
//   - observador: importa o histórico via polling (sincronia-conversas.js)
//   - provedor de ferramentas: o servidor MCP (bin/mcp-crmclinica.js)
//   - controlador de estado: liga/desliga a Serena (openclaw-politica.js)
//
// O CRM **não** reenvia a mensagem do paciente para o OpenClaw via chat.send.
// Fazer isso criaria um circuito duplicado: a mensagem já está na sessão, e
// reenviar faria a Serena processá-la duas vezes.
//
// ------------------------------------------------------------------ este arquivo
//
// Mantém apenas o que o CRM ainda precisa:
//   - assinaturaValida: verificar webhooks recebidos do OpenClaw
//   - assinar: assinar webhooks enviados
//   - criarClienteOpenClaw: interface de saúde para o painel (channels.status)
//
// O despacharEvento permanece por compatibilidade com o atendimento, mas agora
// retorna { resposta: null } imediatamente — a Serena já respondeu no canal.
// O atendimento interpreta isso como "sem resposta do orquestrador" e mantém
// a conversa disponível para a equipe, sem escalonar.
//
// ------------------------------------------------------------------ verificarSaude
//
// Usa channels.status via gateway WebSocket — o endpoint GET /health não existe
// no OpenClaw real.

const {
  criarClienteGateway, carregarOuCriarIdentidade,
} = require('./openclaw-gateway');

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

/**
 * @param {object} configuracao  `configuracao.openclaw` — com `.gateway` para WebSocket.
 * @param {object} dependencias  `cliente` para injeção nos testes.
 */
function criarClienteOpenClaw(configuracao, dependencias = {}) {
  const gateway = configuracao?.gateway ?? {};
  const disponivel = Boolean(gateway.url && (gateway.token || gateway.deviceToken));

  let cliente = dependencias.cliente ?? null;
  let erroDeMontagem = null;

  if (!cliente && disponivel) {
    try {
      const identidade = carregarOuCriarIdentidade(gateway.identidadePath, gateway.chavePrivada);
      cliente = criarClienteGateway({
        url: gateway.url,
        token: gateway.token || null,
        deviceToken: gateway.deviceToken || null,
        identidade,
        timeoutMs: gateway.timeoutMs ?? 20000,
      });
    } catch (erro) {
      erroDeMontagem = erro;
    }
  }

  return {
    disponivel: disponivel && !erroDeMontagem,

    /**
     * Stub de compatibilidade — não envia mensagem ao OpenClaw.
     *
     * Na Arquitetura A, o OpenClaw já controla a conversa: a Serena responde
     * diretamente no canal quando o paciente escreve. O CRM não precisa (e não
     * deve) reenviar a mensagem do paciente via chat.send, pois isso criaria
     * um circuito duplicado.
     *
     * Retorna { resposta: null } para que o atendimento mantenha a conversa
     * disponível para a equipe, sem escalonar por falha.
     *
     * O controle de ligar/desligar a Serena é feito via openclaw-politica.js
     * (config.set com dmPolicy), e as ferramentas são expostas via MCP.
     */
    async despacharEvento(_evento) {
      if (!disponivel || erroDeMontagem) {
        const erro = new Error(
          erroDeMontagem
            ? `gateway indisponível: ${erroDeMontagem.message}`
            : 'Integração com o OpenClaw não está configurada',
        );
        erro.codigo = 'openclaw_nao_configurado';
        throw erro;
      }
      // A Serena já respondeu no canal (Arquitetura A).
      // O CRM importará a resposta via sincronia-conversas.js.
      return { resposta: null };
    },

    /**
     * Consulta a saúde do orquestrador sem derrubar o CRM se ele estiver fora.
     *
     * Usa channels.status — a mesma chamada que o adaptador de lembretes usa —
     * em vez de GET /health, que não existe no OpenClaw real.
     */
    async verificarSaude() {
      if (!disponivel || erroDeMontagem) return { estado: 'nao_configurado' };
      try {
        const status = await cliente.chamar('channels.status', {});
        const whatsapp = status?.channels?.whatsapp ?? null;
        if (whatsapp?.connected === true) return { estado: 'operacional' };
        if (status !== null && status !== undefined) return { estado: 'degradado' };
        return { estado: 'indisponivel' };
      } catch {
        return { estado: 'indisponivel' };
      }
    },
  };
}

module.exports = { criarClienteOpenClaw, assinaturaValida, assinar };
