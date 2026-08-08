'use strict';

// Um Google Calendar de mentira para os testes.
//
// Não é um stub de respostas prontas: é uma implementação em memória das
// regras que o cliente de verdade usa — ETag que muda a cada escrita, 409 na
// criação com id repetido, 412 quando o If-Match não bate, syncToken que anda
// a cada mudança, pageToken na paginação, showDeleted trazendo os cancelados
// e 410 quando o cursor não presta mais. Testar contra respostas enlatadas
// provaria que o cliente lê o roteiro; testar contra isto prova que ele lê o
// protocolo.
//
// Uso: `criarCalendarioGoogle(config, { fetch: criarGoogleFalso().fetch })`.

const crypto = require('node:crypto');

function respostaJson(status, corpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
    text: async () => JSON.stringify(corpo ?? null),
  };
}

function criarGoogleFalso({ agora = () => new Date() } = {}) {
  // eventos: id -> { id, summary, start, end, status, etag, updated, versao }
  const eventos = new Map();
  let versaoDoCalendario = 0;
  let proximoEtag = 1;
  // Falhas injetadas: { restantes, status } — os próximos N acessos ao
  // calendário quebram com o status dado, para testar retry e backoff.
  let falhaInjetada = null;
  // Quando verdadeiro, qualquer syncToken recebido devolve 410 uma vez.
  let cursorsVencidos = false;

  function tocar(evento) {
    versaoDoCalendario += 1;
    evento.etag = `"etag-${proximoEtag++}"`;
    evento.updated = agora().toISOString();
    evento.versao = versaoDoCalendario;
    return evento;
  }

  function talvezFalhar() {
    if (falhaInjetada && falhaInjetada.restantes > 0) {
      falhaInjetada.restantes -= 1;
      return respostaJson(falhaInjetada.status, { error: { message: 'falha injetada' } });
    }
    return null;
  }

  async function lerCorpo(opcoes) {
    // O pedido de token vai em form-url-encoded; os do calendário, em JSON.
    const tipo = String(opcoes?.headers?.['content-type'] ?? '');
    if (!opcoes?.body) return {};
    if (tipo.includes('json')) return JSON.parse(opcoes.body);
    return Object.fromEntries(new URLSearchParams(opcoes.body));
  }

  async function fetch(url, opcoes = {}) {
    const alvo = new URL(url);
    const metodo = opcoes.method ?? 'GET';

    // -------------------------------------------------------------- token
    if (alvo.hostname === 'oauth2.googleapis.com') {
      const corpo = await lerCorpo(opcoes);
      if (!corpo.assertion) return respostaJson(401, { error: 'unauthorized' });
      return respostaJson(200, {
        access_token: `token-falso-${crypto.randomBytes(4).toString('hex')}`,
        expires_in: 3600,
      });
    }

    const falha = talvezFalhar();
    if (falha) return falha;

    // /calendars/:cal/events[/:id]
    const partes = alvo.pathname.split('/').filter(Boolean);
    const indiceEventos = partes.indexOf('events');
    if (partes[0] !== 'calendar' || indiceEventos === -1) {
      return respostaJson(404, { error: { message: 'rota desconhecida' } });
    }
    const eventoId = partes[indiceEventos + 1] ? decodeURIComponent(partes[indiceEventos + 1]) : null;

    // ------------------------------------------------------------ criar
    if (metodo === 'POST' && !eventoId) {
      const corpo = await lerCorpo(opcoes);
      const id = corpo.id ?? `evt-${crypto.randomBytes(6).toString('hex')}`;
      const existente = eventos.get(id);
      if (existente && existente.status !== 'cancelled') {
        return respostaJson(409, { error: { message: 'The specified identifier already exists.' } });
      }
      const evento = tocar({
        ...corpo,
        id,
        status: 'confirmed',
        extendedProperties: corpo.extendedProperties ?? {},
      });
      eventos.set(id, evento);
      return respostaJson(200, evento);
    }

    const evento = eventoId ? eventos.get(eventoId) : null;

    // ------------------------------------------------------------ ler um
    if (metodo === 'GET' && eventoId) {
      if (!evento) return respostaJson(404, { error: { message: 'Not Found' } });
      return respostaJson(200, evento);
    }

    // ------------------------------------------------------------ atualizar
    if (metodo === 'PATCH' && eventoId) {
      if (!evento || evento.status === 'cancelled') {
        return respostaJson(404, { error: { message: 'Not Found' } });
      }
      const ifMatch = opcoes.headers?.['if-match'];
      if (ifMatch && ifMatch !== evento.etag) {
        return respostaJson(412, { error: { message: 'Precondition Failed' } });
      }
      const corpo = await lerCorpo(opcoes);
      Object.assign(evento, corpo, { id: evento.id });
      return respostaJson(200, tocar(evento));
    }

    // ------------------------------------------------------------ remover
    if (metodo === 'DELETE' && eventoId) {
      if (!evento || evento.status === 'cancelled') {
        return respostaJson(404, { error: { message: 'Not Found' } });
      }
      const ifMatch = opcoes.headers?.['if-match'];
      if (ifMatch && ifMatch !== evento.etag) {
        return respostaJson(412, { error: { message: 'Precondition Failed' } });
      }
      evento.status = 'cancelled';
      tocar(evento);
      return respostaJson(204, null);
    }

    // ------------------------------------------------------------ listar
    if (metodo === 'GET' && !eventoId) {
      const syncToken = alvo.searchParams.get('syncToken');
      if (syncToken) {
        const versaoLida = Number(syncToken.replace('sync-', ''));
        if (cursorsVencidos || !Number.isFinite(versaoLida) || versaoLida < 0) {
          cursorsVencidos = false; // o 410 dispara uma vez: o full sync refaz
          return respostaJson(410, { error: { message: 'Sync token is no longer valid' } });
        }
        const mudados = [...eventos.values()].filter((e) => e.versao > versaoLida);
        return respostaJson(200, {
          kind: 'calendar#events',
          items: mudados,
          nextSyncToken: `sync-${versaoDoCalendario}`,
        });
      }

      // Full sync: janela de tempo + paginação por deslocamento.
      const timeMin = alvo.searchParams.get('timeMin');
      const timeMax = alvo.searchParams.get('timeMax');
      const mostrarApagados = alvo.searchParams.get('showDeleted') === 'true';
      const porPagina = Number(alvo.searchParams.get('maxResults') ?? 250);
      const deslocamento = Number(alvo.searchParams.get('pageToken') ?? 0);

      let itens = [...eventos.values()];
      if (!mostrarApagados) itens = itens.filter((e) => e.status !== 'cancelled');
      if (timeMin) itens = itens.filter((e) => !e.start?.dateTime || e.start.dateTime >= timeMin);
      if (timeMax) itens = itens.filter((e) => !e.start?.dateTime || e.start.dateTime <= timeMax);
      itens.sort((a, b) => String(a.start?.dateTime).localeCompare(String(b.start?.dateTime)));

      const pagina = itens.slice(deslocamento, deslocamento + porPagina);
      const temMais = deslocamento + porPagina < itens.length;
      return respostaJson(200, {
        kind: 'calendar#events',
        items: pagina,
        ...(temMais
          ? { nextPageToken: String(deslocamento + porPagina) }
          : { nextSyncToken: `sync-${versaoDoCalendario}` }),
      });
    }

    return respostaJson(405, { error: { message: 'método não suportado pelo falso' } });
  }

  return {
    fetch,
    eventos,
    /** Injeta falha: os próximos `n` acessos ao calendário quebram com `status`. */
    falharProximos(n, status = 500) {
      falhaInjetada = { restantes: n, status };
    },
    /** O próximo syncToken recebido devolve 410, uma vez. */
    vencerCursors() {
      cursorsVencidos = true;
    },
  };
}

module.exports = { criarGoogleFalso };
