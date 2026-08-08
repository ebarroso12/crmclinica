'use strict';

// Cliente de baixo nível do Google Calendar para a sincronia transacional.
//
// O google-agenda.js resolve o espelho simples (melhor esforço, na hora). Este
// módulo é outra camada: ele dá ao outbox e ao sync incremental as primitivas
// de que eles precisam — criação idempotente, escrita condicionada por ETag,
// leitura paginada com syncToken — sem esconder os códigos de erro que o
// domínio usa para decidir conflito, retry ou full sync.
//
// O que NÃO muda em relação ao espelho simples:
//   - o CRM continua a fonte administrativa de verdade;
//   - nada de diagnóstico, motivo clínico ou qualquer dado sensível no evento —
//     o corpo continua saindo de `montarEvento` do google-agenda.js;
//   - falha do Google nunca derruba o agendamento: quem chama é o worker.

const { montarAsserção, montarEvento } = require('./google-agenda');

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Erro HTTP do Google com o status acessível.
 *
 * O domínio decide o que fazer olhando o status: 409 vira sucesso idempotente
 * na criação, 412 vira conflito de edição concorrente, 410 manda refazer o
 * full sync, 404 no delete vira "já estava apagado". Um Error comum esconderia
 * isso atrás de comparação de mensagem, que é frágil e muda de idioma.
 */
class ErroDoGoogle extends Error {
  constructor(status, mensagem) {
    super(mensagem ?? `Google Calendar respondeu ${status}`);
    this.name = 'ErroDoGoogle';
    this.status = status;
  }

  get conflito() { return this.status === 409; }
  get precondicao() { return this.status === 412; }
  get cursorInvalido() { return this.status === 410; }
  get naoEncontrado() { return this.status === 404; }
}

/**
 * Identificador determinístico do evento no Google.
 *
 * O Google só aceita IDs em base32hex (letras a-v e dígitos, 5 a 1024
 * caracteres), então o prefixo não leva hífen e o número vai com zeros à
 * esquerda. Ser determinístico é o que torna a criação idempotente: repetir o
 * insert devolve 409 em vez de um evento duplicado, e o 409 confirma que o
 * evento certo já existe.
 */
function idDoEvento(agendamentoId) {
  return `crmagendamento${String(agendamentoId).padStart(10, '0')}`;
}

/** Inverso de `idDoEvento`: devolve o id do agendamento ou null. */
function agendamentoDoEventoId(eventoId) {
  const casamento = /^crmagendamento0*([0-9]+)$/.exec(eventoId ?? '');
  return casamento ? Number(casamento[1]) : null;
}

function criarCalendarioGoogle(configuracao = {}, dependencias = {}) {
  const buscar = dependencias.fetch ?? globalThis.fetch;
  const calendario = configuracao.calendario || configuracao.usuario || 'primary';
  const timeoutMs = configuracao.timeoutMs ?? 15000;

  let credencial = null;
  try {
    credencial = configuracao.credencial ? JSON.parse(configuracao.credencial) : null;
  } catch {
    credencial = null;
  }

  const configurada = Boolean(credencial?.client_email && credencial?.private_key && configuracao.usuario);

  let tokenEmCache = null;
  let tokenExpiraEm = 0;

  async function obterToken() {
    if (tokenEmCache && Date.now() < tokenExpiraEm - 60_000) return tokenEmCache;

    const resposta = await buscar(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: montarAsserção(credencial, configuracao.delegar ? configuracao.usuario : null),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resposta.ok) throw new ErroDoGoogle(resposta.status, `Google recusou a autenticação (${resposta.status})`);

    const dados = await resposta.json();
    tokenEmCache = dados.access_token;
    tokenExpiraEm = Date.now() + (Number(dados.expires_in ?? 3600) * 1000);
    return tokenEmCache;
  }

  async function chamar(caminho, { metodo = 'GET', corpo = null, cabecalhos = {} } = {}) {
    const token = await obterToken();
    const resposta = await buscar(`${CALENDAR}${caminho}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${token}`,
        ...(corpo !== null ? { 'content-type': 'application/json' } : {}),
        ...cabecalhos,
      },
      body: corpo !== null ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resposta.status === 204) return { status: 204, dados: null, etag: null };
    const dados = resposta.status === 404 || resposta.ok ? await resposta.json().catch(() => null) : null;
    if (!resposta.ok) throw new ErroDoGoogle(resposta.status);
    return { status: resposta.status, dados, etag: dados?.etag ?? null };
  }

  const caminhoDoEvento = (eventoId) => `/calendars/${encodeURIComponent(calendario)}/events/${encodeURIComponent(eventoId)}`;

  return {
    configurada,
    calendario,

    /**
     * Cria o evento com id determinístico.
     *
     * O 409 aqui não é falha: é o Google confirmando que o evento daquele
     * agendamento já existe — exatamente o que uma repetição idempotente quer
     * saber. O chamador (outbox) trata como sucesso e segue para o PATCH.
     */
    async criarEvento({ agendamento, contato, clinica, fuso }) {
      const corpo = { id: idDoEvento(agendamento.id), ...montarEvento({ agendamento, contato, clinica, fuso }) };
      const { dados, etag } = await chamar(`/calendars/${encodeURIComponent(calendario)}/events`, {
        metodo: 'POST',
        corpo,
      });
      return { eventoId: dados?.id ?? corpo.id, etag };
    },

    /**
     * Atualiza condicionado ao ETag: se alguém mexeu no evento pelo Google
     * desde a nossa última leitura, o Google devolve 412 e nada é gravado. É
     * a trava de edição concorrente — sem ela, a última escrita venceria em
     * silêncio.
     */
    async atualizarEvento(eventoId, { agendamento, contato, clinica, fuso, etag = null }) {
      const corpo = montarEvento({ agendamento, contato, clinica, fuso });
      const { dados, etag: novoEtag } = await chamar(caminhoDoEvento(eventoId), {
        metodo: 'PATCH',
        corpo,
        cabecalhos: etag ? { 'if-match': etag } : {},
      });
      return { eventoId: dados?.id ?? eventoId, etag: novoEtag };
    },

    /**
     * Cancela o evento. 404 e 410 contam como sucesso: o objetivo era não
     * haver evento, e não há. Forçar erro aqui deixaria um cancelamento
     * preso no outbox para sempre por causa de um evento já apagado à mão.
     */
    async removerEvento(eventoId, { etag = null } = {}) {
      try {
        await chamar(caminhoDoEvento(eventoId), {
          metodo: 'DELETE',
          cabecalhos: etag ? { 'if-match': etag } : {},
        });
        return { removido: true };
      } catch (erro) {
        if (erro instanceof ErroDoGoogle && (erro.naoEncontrado || erro.cursorInvalido)) {
          return { removido: true, jaInexistia: true };
        }
        throw erro;
      }
    },

    /** Lê um evento; devolve null quando não existe (404). */
    async obterEvento(eventoId) {
      try {
        const { dados, etag } = await chamar(caminhoDoEvento(eventoId));
        return dados ? { evento: dados, etag } : null;
      } catch (erro) {
        if (erro instanceof ErroDoGoogle && erro.naoEncontrado) return null;
        throw erro;
      }
    },

    /**
     * Uma página da listagem de eventos.
     *
     * Dois modos, mesmo endpoint:
     *   - full sync: `timeMin`/`timeMax` + pageToken até esgotar; o Google dá
     *     o syncToken na última página;
     *   - incremental: `syncToken` + showDeleted, também paginado; o 410 aqui
     *     significa "cursor vencido, refaça o full sync" — e o domínio obedece.
     *
     * O cursor novo (nextSyncToken) só aparece na página final. O chamador só
     * o persiste quando `proximaPagina` vem vazio — gravar no meio do caminho
     * perderia eventos se o processo morresse entre duas páginas.
     */
    async listarPagina({ syncToken = null, pageToken = null, timeMin = null, timeMax = null, maxResults = 250 } = {}) {
      const parametros = new URLSearchParams({
        maxResults: String(maxResults),
        singleEvents: 'true',
        orderBy: 'startTime',
        showDeleted: 'true',
      });
      if (syncToken) parametros.set('syncToken', syncToken);
      if (pageToken) parametros.set('pageToken', pageToken);
      if (timeMin) parametros.set('timeMin', new Date(timeMin).toISOString());
      if (timeMax) parametros.set('timeMax', new Date(timeMax).toISOString());
      // orderBy exige janela de tempo; no incremental o Google recusa a
      // combinação, então a ordenação sai quando há syncToken.
      if (syncToken) parametros.delete('orderBy');

      const { dados } = await chamar(`/calendars/${encodeURIComponent(calendario)}/events?${parametros}`);
      return {
        itens: dados?.items ?? [],
        proximaPagina: dados?.nextPageToken ?? null,
        proximoSyncToken: dados?.nextSyncToken ?? null,
      };
    },
  };
}

module.exports = {
  criarCalendarioGoogle,
  ErroDoGoogle,
  idDoEvento,
  agendamentoDoEventoId,
};
