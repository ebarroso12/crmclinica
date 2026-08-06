'use strict';
const crypto = require('node:crypto');
const {
  criarClienteGateway, carregarOuCriarIdentidade,
} = require('./openclaw-gateway');

// Integração com o OpenClaw, o orquestrador de eventos, ferramentas e tarefas.
//
// ------------------------------------------------------------------ o transporte
//
// O cliente HTTP original (`POST /eventos`) foi migrado para o gateway WebSocket.
// O endpoint HTTP não existe no OpenClaw real — o transporte é sempre WebSocket,
// e o método de conversa é `chat.send` com uma `sessionKey`.
//
// O caminho estava documentado em `docs/OPENCLAW.md` (seção "O que continua fora"):
//
//   > `src/integracoes/openclaw.js` — o cliente de **eventos de conversa** —
//   > ainda fala HTTP (`POST /eventos`), desenho que não corresponde ao transporte
//   > real. Quando for migrado, o caminho está pronto: `openclaw-gateway.js` já
//   > fala o protocolo, e o método de conversa é `chat.send`.
//
// Esta migração fecha esse circuito.
//
// ------------------------------------------------------------------ o mecanismo
//
// `despacharEvento` recebe o contexto da conversa e:
//   1. Localiza a sessão existente pelo telefone do contato (`sessions.list`)
//   2. Envia a última mensagem via `chat.send` com a `sessionKey` da sessão
//   3. Aguarda a resposta via `chat.history` (polling até o modelo terminar)
//
// A resposta da Serena é lida do histórico e devolvida como `{ resposta: texto }`,
// mantendo a mesma interface que o atendimento espera.
//
// ------------------------------------------------------------------ verificarSaude
//
// Usa `channels.status` em vez de `GET /health` — que também não existe no
// OpenClaw real. O estado do canal WhatsApp é a prova mais direta de que o
// gateway está no ar e conectado.

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
 * Extrai o texto da resposta do agente, que vem em formatos diferentes.
 *
 * O histórico pode trazer `content` como string ou como array de partes.
 * Mensagens sem texto são chamadas de ferramenta ou marcação interna — ignoradas.
 */
function textoDaResposta(mensagem) {
  const conteudo = mensagem?.content;
  if (typeof conteudo === 'string') return conteudo.trim();
  if (Array.isArray(conteudo)) {
    return conteudo
      .filter((parte) => parte?.type === 'text' && typeof parte.text === 'string')
      .map((parte) => parte.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Aguarda a resposta do agente consultando o histórico.
 *
 * O `chat.send` retorna imediatamente com `status: started`. A resposta
 * aparece no histórico quando o modelo termina. Polling com backoff exponencial
 * até encontrar uma mensagem do assistente, ou esgotar o tempo.
 */
async function aguardarResposta(gateway, sessionKey, { timeoutMs = 25000, intervaloMs = 600 } = {}) {
  const inicio = Date.now();
  let intervalo = intervaloMs;
  while (Date.now() - inicio < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalo));
    intervalo = Math.min(intervalo * 1.5, 3000);
    const dados = await gateway.chamar('chat.history', { sessionKey });
    const mensagens = Array.isArray(dados?.messages) ? dados.messages : [];
    // A última mensagem do assistente é a resposta. Mensagens de ferramenta
    // (`toolResult`, `system`) não são resposta ao paciente.
    const resposta = [...mensagens].reverse().find(
      (m) => m?.role === 'assistant' && textoDaResposta(m).length > 0,
    );
    if (resposta) return textoDaResposta(resposta);
  }
  return null;
}

/**
 * Localiza a sessão WhatsApp do contato pelo telefone.
 *
 * `sessions.list` devolve todas as sessões. A sessão do paciente é identificada
 * pelo telefone no campo `origin.from` — o mesmo que `sincronia-conversas.js` usa.
 */
async function localizarSessao(gateway, telefone) {
  const lista = await gateway.chamar('sessions.list', {});
  const todas = lista?.sessions ?? lista?.entries ?? lista?.items ?? [];
  // Normaliza o telefone para comparação: remove caracteres não numéricos.
  const normalizado = String(telefone).replace(/\D/g, '');
  return todas.find((sessao) => {
    const from = String(sessao?.origin?.from ?? '').replace(/\D/g, '');
    return from && from.endsWith(normalizado);
  }) ?? null;
}

/**
 * @param {object} configuracao  `configuracao.openclaw` — com `.gateway` para WebSocket.
 * @param {object} dependencias  `cliente` para injeção nos testes.
 */
function criarClienteOpenClaw(configuracao, dependencias = {}) {
  const gateway = configuracao?.gateway ?? {};
  const disponivel = Boolean(gateway.url && (gateway.token || gateway.deviceToken));

  // Cliente injetado é a via dos testes: exercita o caminho real sem abrir socket.
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
     * Entrega ao orquestrador um evento de conversa.
     *
     * Localiza a sessão do paciente pelo telefone, envia a última mensagem via
     * `chat.send` e aguarda a resposta no histórico. Devolve `{ resposta: texto }`
     * para o atendimento gravar no histórico local.
     *
     * Sem sessão ativa (paciente ainda não escreveu pelo WhatsApp), devolve
     * `{ resposta: null }` — a conversa fica com a equipe, sem erro.
     */
    async despacharEvento(evento) {
      if (!disponivel || erroDeMontagem) {
        const erro = new Error(
          erroDeMontagem
            ? `gateway indisponível: ${erroDeMontagem.message}`
            : 'Integração com o OpenClaw não está configurada',
        );
        erro.codigo = 'openclaw_nao_configurado';
        throw erro;
      }

      const telefone = evento?.contexto?.contato?.telefone;
      if (!telefone) {
        // Sem telefone não há sessão a localizar. A conversa fica com a equipe.
        return { resposta: null };
      }

      // Localiza a sessão ativa do paciente no gateway.
      let sessao;
      try {
        sessao = await localizarSessao(cliente, telefone);
      } catch (erro) {
        // Falha ao listar sessões é indisponibilidade, não ausência de sessão.
        const e = new Error(`falha ao localizar sessão: ${erro.message}`);
        e.codigo = erro.codigo ?? 'gateway_erro';
        throw e;
      }

      if (!sessao?.key) {
        // Sem sessão ativa, a Serena ainda não conhece este paciente no gateway.
        // A conversa fica com a equipe — sem erro, sem escalonamento forçado.
        return { resposta: null };
      }

      // A última mensagem do contexto é o que o paciente acabou de escrever.
      const mensagens = evento?.contexto?.mensagens ?? [];
      const ultimaMensagem = mensagens.at(-1);
      const texto = ultimaMensagem?.texto ?? '';

      if (!texto) return { resposta: null };

      // Chave de idempotência derivada do evento: reenvio não duplica resposta.
      const chave = evento.chave_idempotencia
        ?? `crmclinica:evento:${crypto.createHash('sha256')
          .update(`${sessao.key}|${texto}`)
          .digest('hex')
          .slice(0, 32)}`;

      try {
        await cliente.chamar('chat.send', {
          sessionKey: sessao.key,
          message: String(texto).slice(0, 4000),
          idempotencyKey: chave,
        });
      } catch (erro) {
        const e = new Error(`falha ao enviar mensagem: ${erro.message}`);
        e.codigo = erro.codigo ?? 'gateway_erro';
        throw e;
      }

      // Aguarda a resposta da Serena no histórico.
      const resposta = await aguardarResposta(cliente, sessao.key, {
        timeoutMs: Math.max((gateway.timeoutMs ?? 20000) - 2000, 5000),
      });

      return { resposta };
    },

    /**
     * Consulta a saúde do orquestrador sem derrubar o CRM se ele estiver fora.
     *
     * Usa `channels.status` — a mesma chamada que o adaptador de lembretes usa —
     * em vez de `GET /health`, que não existe no OpenClaw real.
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
