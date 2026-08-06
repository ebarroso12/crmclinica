'use strict';

// Espelha a agenda da clínica no Google Calendar do médico.
//
// A agenda do crmclinica continua sendo a fonte de verdade: é ela que impede
// dois pacientes no mesmo horário, e essa trava vive no banco, numa restrição
// que nenhuma automação contorna. O Google não substitui isso — ele resolve
// outro problema, que é o médico enxergar o dia no celular, junto do resto da
// vida dele, sem abrir o painel.
//
// Por isso o espelho é de mão única: o CRM escreve no Google. Sincronizar de
// volta significaria aceitar que um evento criado no celular vire consulta sem
// passar pela trava de conflito — e aí dois pacientes marcam o mesmo horário.
//
// ------------------------------------------------------------------ o desenho
//
// Autenticação por conta de serviço com delegação, não OAuth de usuário. OAuth
// exigiria alguém reautorizar quando o refresh token expirasse — e isso
// aconteceria num sábado, sem ninguém perceber, com as consultas da semana
// deixando de aparecer no celular do médico.
//
// Falha do Google nunca derruba o agendamento. A consulta já está marcada no
// banco quando este módulo é chamado; se o espelho falhar, a clínica atende do
// mesmo jeito e o painel continua certo.

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ESCOPO = 'https://www.googleapis.com/auth/calendar.events';

/**
 * JWT assinado para a conta de serviço.
 *
 * `assunto` só é usado em Google Workspace, onde o administrador pode delegar a
 * conta de serviço a agir em nome de um usuário do domínio. Numa conta Gmail
 * comum essa delegação não existe, e pedi-la faz o Google devolver 401 sem
 * explicar por quê — o caminho ali é a conta agir como ela mesma, e o médico
 * compartilhar o calendário com o e-mail dela.
 */
function montarAsserção(credencial, assunto, agora = Date.now()) {
  const crypto = require('node:crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const emitido = Math.floor(agora / 1000);
  const cabecalho = b64({ alg: 'RS256', typ: 'JWT' });
  const corpo = b64({
    iss: credencial.client_email,
    scope: ESCOPO,
    aud: TOKEN_URL,
    // Delegação só quando o assunto for informado — e ele só é informado em
    // Workspace. Em conta Gmail comum, a conta de serviço age como ela mesma.
    ...(assunto ? { sub: assunto } : {}),
    iat: emitido,
    exp: emitido + 3600,
  });

  const assinatura = crypto
    .sign('RSA-SHA256', Buffer.from(`${cabecalho}.${corpo}`), credencial.private_key)
    .toString('base64url');

  return `${cabecalho}.${corpo}.${assinatura}`;
}

/**
 * Monta o evento a partir do agendamento.
 *
 * O que vai para o Google é deliberadamente magro: nome, horário e telefone. O
 * calendário sincroniza com o celular, com o relógio, às vezes com uma agenda
 * compartilhada — e motivo de consulta psiquiátrica não é coisa que se deixa
 * aparecer na tela de bloqueio de um aparelho.
 */
function montarEvento({ agendamento, contato, clinica, fuso = 'America/Sao_Paulo' }) {
  const nome = contato?.nome?.trim() || 'Paciente';

  return {
    summary: `Consulta — ${nome}`,
    description: [
      contato?.telefone ? `Telefone: ${contato.telefone}` : null,
      clinica ? `Local: ${clinica}` : null,
      'Agendado pelo crmclinica.',
    ].filter(Boolean).join('\n'),
    start: { dateTime: new Date(agendamento.inicio).toISOString(), timeZone: fuso },
    end: { dateTime: new Date(agendamento.fim).toISOString(), timeZone: fuso },
    // O identificador amarra o evento ao agendamento: é o que permite atualizar
    // e cancelar depois, em vez de acumular duplicatas a cada remarcação.
    extendedProperties: { private: { crmclinica_agendamento: String(agendamento.id) } },
    reminders: { useDefault: true },
  };
}

function criarAgendaDoGoogle(configuracao = {}, dependencias = {}) {
  const buscar = dependencias.fetch ?? globalThis.fetch;
  // O calendário é o do médico, não o 'primary' da conta de serviço: aquele
  // existe, ninguém abre, e o evento sumiria lá dentro sem erro nenhum.
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
    // Um minuto de folga: renovar no limite faz a chamada seguinte falhar por
    // token expirado no meio do caminho.
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

    if (!resposta.ok) {
      throw new Error(`Google recusou a autenticação (${resposta.status})`);
    }

    const dados = await resposta.json();
    tokenEmCache = dados.access_token;
    tokenExpiraEm = Date.now() + (Number(dados.expires_in ?? 3600) * 1000);
    return tokenEmCache;
  }

  async function chamar(caminho, opcoes = {}) {
    const token = await obterToken();
    const resposta = await buscar(`${CALENDAR}${caminho}`, {
      ...opcoes,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(opcoes.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resposta.status === 404) return null;
    if (!resposta.ok) {
      throw new Error(`Google Calendar respondeu ${resposta.status}`);
    }
    return resposta.status === 204 ? true : resposta.json();
  }

  return {
    configurada,

    /** Cria (ou atualiza) o evento da consulta no calendário do médico. */
    async espelhar({ agendamento, contato, clinica }) {
      if (!configurada) return { espelhado: false, motivo: 'google_nao_configurado' };

      const evento = montarEvento({ agendamento, contato, clinica });
      const existente = agendamento.google_evento_id;

      const resultado = existente
        ? await chamar(`/calendars/${encodeURIComponent(calendario)}/events/${existente}`, {
          method: 'PATCH', body: JSON.stringify(evento),
        })
        : null;

      // Evento apagado à mão no Google devolve 404 na atualização. Recriar é o
      // comportamento certo: a consulta existe, e quem apagou provavelmente
      // limpou o calendário sem saber que aquilo era um agendamento real.
      const criado = resultado ?? await chamar(
        `/calendars/${encodeURIComponent(calendario)}/events`,
        { method: 'POST', body: JSON.stringify(evento) },
      );

      return { espelhado: true, evento_id: criado?.id ?? null };
    },


    /**
     * Os eventos já ocupados no calendário, num período.
     *
     * O Google é a agenda de verdade: consulta marcada direto lá — pelo celular,
     * por outra pessoa — não passa pelo CRM, e oferecer aquele horário a um
     * paciente colocaria dois na mesma hora. Por isso a oferta consulta aqui.
     */
    async ocupados({ de, ate }) {
      if (!configurada) return [];

      const busca = new URLSearchParams({
        timeMin: new Date(de).toISOString(),
        timeMax: new Date(ate).toISOString(),
        // Sem isto, um evento semanal apareceria uma vez só e os demais dias
        // ficariam livres no CRM enquanto estão ocupados no Google.
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });

      const dados = await chamar(
        `/calendars/${encodeURIComponent(calendario)}/events?${busca}`,
      );

      return (dados?.items ?? [])
        // Evento recusado ou cancelado não ocupa nada, e dia inteiro sem hora
        // ('date' em vez de 'dateTime') é feriado ou aviso, não consulta.
        .filter((e) => e.status !== 'cancelled' && e.start?.dateTime && e.end?.dateTime)
        .map((e) => ({
          inicio: e.start.dateTime,
          fim: e.end.dateTime,
          titulo: e.summary ?? null,
          // O que o próprio CRM criou já está no banco: marcar a origem evita
          // contar a mesma consulta duas vezes.
          doCrm: Boolean(e.extendedProperties?.private?.crmclinica_agendamento),
        }));
    },

    /** Remove o evento quando a consulta é cancelada. */
    async remover(eventoId) {
      if (!configurada || !eventoId) return { removido: false };

      await chamar(`/calendars/${encodeURIComponent(calendario)}/events/${eventoId}`, {
        method: 'DELETE',
      });
      return { removido: true };
    },
  };
}

module.exports = { criarAgendaDoGoogle, montarEvento, montarAsserção };
