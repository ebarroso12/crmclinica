'use strict';
const crypto = require('node:crypto');
const {
  criarClienteGateway, carregarOuCriarIdentidade,
} = require('./openclaw-gateway');

// Integração com o OpenClaw, o orquestrador de eventos, ferramentas e tarefas.
//
// ------------------------------------------------------------------ o transporte
//
// O transporte é o gateway WebSocket (`openclaw-gateway.js`); o método de
// conversa é `chat.send` com uma `sessionKey`. O endpoint HTTP `POST /eventos`
// do desenho original nunca existiu no OpenClaw real.
//
// ------------------------------------------------------------- de quem é a sessão
//
// Este cliente atende SÓ o fluxo `crm_despacha`: eventos de canais em que o CRM
// é o responsável por acionar a IA. Isso inclui site e formulário e, na
// Arquitetura B, o WhatsApp conectado com o agente direto globalmente calado.
// No modo anterior (`openclaw_gerencia`), o atendimento apenas importa o que o
// agente do canal já respondeu e nunca redespacha a mensagem.
//
// A conversa acontece numa sessão INTERNA do CRM (`OPENCLAW_SESSION_ID`),
// nunca na sessão WhatsApp de um paciente. A versão anterior localizava a
// sessão do paciente pelo telefone (`sessions.list`) e fazia `chat.send` nela —
// o que injetava a mensagem de volta na conversa que o agente já carregava, e
// era o mecanismo exato da resposta duplicada.
//
// Sem sessão interna configurada, o despacho falha FECHADO: devolve
// `escalonar` com `motor_ia_nao_configurado`, e a conversa vai para a equipe.
// A alternativa — cair de volta para a sessão de alguém — é como um lead de
// formulário acabaria conversando dentro do WhatsApp de outro paciente.
//
// --------------------------------------------------------------- a correlação
//
// `chat.send` retorna antes de o modelo terminar; a resposta aparece depois no
// histórico. Numa sessão compartilhada por eventos consecutivos, "a última
// mensagem do assistente" pode ser a resposta da pergunta ANTERIOR. Por isso o
// despacho tira uma linha de base do histórico antes de enviar e só aceita
// como resposta uma mensagem do assistente que não existia nessa linha de base
// (e, quando o gateway devolve `runId`, que pertença à execução deste envio).
// Timeout devolve `resposta: null` — nunca uma resposta velha.
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

/** Identificador de uma mensagem do histórico, quando o gateway fornece um. */
function idDaMensagem(mensagem) {
  return mensagem?.__openclaw?.id ?? mensagem?.id ?? null;
}

/** `runId` da execução a que a mensagem pertence, quando o gateway informa. */
function runIdDaMensagem(mensagem) {
  return mensagem?.__openclaw?.runId ?? mensagem?.runId ?? null;
}

/**
 * A linha de base do histórico: o que já existia antes deste envio.
 *
 * Identidade por id quando há id; sem id, o tamanho do histórico serve de
 * marca — mensagem em posição nova é mensagem nova.
 */
async function lerLinhaDeBase(gateway, sessionKey) {
  const dados = await gateway.chamar('chat.history', { sessionKey });
  const mensagens = Array.isArray(dados?.messages) ? dados.messages : [];
  const ids = new Set(mensagens.map((m) => idDaMensagem(m)).filter(Boolean));
  return { ids, tamanho: mensagens.length };
}

/**
 * Aguarda a resposta DESTE envio, nunca uma resposta antiga.
 *
 * Só aceita mensagem do assistente que não existia na linha de base — e, quando
 * o envio recebeu `runId` e a mensagem declara o dela, os dois têm de bater.
 * Polling com backoff até encontrar ou esgotar o tempo; timeout devolve `null`.
 */
async function aguardarRespostaNova(gateway, sessionKey, {
  linhaDeBase, runId = null, timeoutMs = 25000, intervaloMs = 600,
} = {}) {
  const inicio = Date.now();
  let intervalo = intervaloMs;
  while (Date.now() - inicio < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalo));
    intervalo = Math.min(intervalo * 1.5, 3000);

    const dados = await gateway.chamar('chat.history', { sessionKey });
    const mensagens = Array.isArray(dados?.messages) ? dados.messages : [];

    for (let posicao = mensagens.length - 1; posicao >= 0; posicao -= 1) {
      const mensagem = mensagens[posicao];
      if (mensagem?.role !== 'assistant') continue;
      if (!textoDaResposta(mensagem)) continue;

      // O teste de novidade: id fora da linha de base, ou — sem id — posição
      // além do tamanho que o histórico tinha antes do envio.
      const id = idDaMensagem(mensagem);
      const nova = id ? !linhaDeBase.ids.has(id) : posicao >= linhaDeBase.tamanho;
      if (!nova) break; // daqui para trás é passado; devolver seria responder com história

      const runDaMensagem = runIdDaMensagem(mensagem);
      if (runId && runDaMensagem && runDaMensagem !== runId) continue;

      return textoDaResposta(mensagem);
    }
  }
  return null;
}

/**
 * @param {object} configuracao  `configuracao.openclaw` — com `.gateway` para
 *   WebSocket e `.sessao` (OPENCLAW_SESSION_ID) para a sessão interna do CRM.
 * @param {object} dependencias  `cliente` para injeção nos testes.
 */
function criarClienteOpenClaw(configuracao, dependencias = {}) {
  const gateway = configuracao?.gateway ?? {};
  const sessaoInterna = configuracao?.sessao || null;
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
     * Aciona a IA para um evento cuja resposta é responsabilidade do CRM
     * (`crm_despacha`): envia a última mensagem à sessão interna e espera a
     * resposta NOVA correlacionada a este envio.
     *
     * Nunca toca a sessão WhatsApp de um paciente. Sem sessão interna
     * configurada, falha fechado: `escalonar` com `motor_ia_nao_configurado`.
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

      if (!sessaoInterna) {
        return { resposta: null, escalonar: true, motivo: 'motor_ia_nao_configurado' };
      }

      // A última mensagem do contexto é o que a pessoa acabou de escrever.
      const mensagens = evento?.contexto?.mensagens ?? [];
      const texto = mensagens.at(-1)?.texto ?? '';
      if (!texto) return { resposta: null };

      // Linha de base ANTES do envio: é ela que separa a resposta desta
      // pergunta das respostas que a sessão já continha.
      let linhaDeBase;
      try {
        linhaDeBase = await lerLinhaDeBase(cliente, sessaoInterna);
      } catch (erro) {
        const e = new Error(`falha ao ler histórico da sessão interna: ${erro.message}`);
        e.codigo = erro.codigo ?? 'gateway_erro';
        throw e;
      }

      // Chave derivada do evento: a retentativa do mesmo evento reusa a mesma
      // chave, e o gateway não executa o envio duas vezes.
      const chave = evento.chave_idempotencia
        ?? `crmclinica:evento:${crypto.createHash('sha256')
          .update(`${sessaoInterna}|${texto}`)
          .digest('hex')
          .slice(0, 32)}`;

      let envio;
      try {
        envio = await cliente.chamar('chat.send', {
          sessionKey: sessaoInterna,
          message: String(texto).slice(0, 4000),
          idempotencyKey: chave,
        });
      } catch (erro) {
        const e = new Error(`falha ao enviar mensagem: ${erro.message}`);
        e.codigo = erro.codigo ?? 'gateway_erro';
        throw e;
      }

      const resposta = await aguardarRespostaNova(cliente, sessaoInterna, {
        linhaDeBase,
        runId: envio?.runId ?? envio?.run_id ?? null,
        // Piso baixo de propósito: quem configura um timeout curto no gateway
        // (os testes, um ambiente de ensaio) precisa que a espera encolha junto.
        timeoutMs: Math.max((gateway.timeoutMs ?? 20000) - 2000, 1000),
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
