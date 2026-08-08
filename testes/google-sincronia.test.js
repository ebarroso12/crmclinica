'use strict';

// P0-11 e P0-12: leitura incremental Google -> CRM, full sync controlado no
// 410, reconciliação e resolução de conflitos.
//
// A regra que atravessa tudo: o que muda no Google nunca reescreve a agenda
// em silêncio — divergência vira conflito e a decisão é da clínica.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarRepositorioGoogleEmMemoria } = require('../src/dados/repositorio-google-memoria');
const { criarCalendarioGoogle, idDoEvento } = require('../src/integracoes/google-calendario');
const { criarOutboxGoogle } = require('../src/dominio/google-outbox');
const { criarSincroniaGoogle } = require('../src/dominio/google-sincronia');
const { criarGoogleFalso } = require('./google-falso');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDENCIAL = JSON.stringify({
  client_email: 'crm@projeto-falso.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const INICIO = '2026-08-06T14:00:00.000-03:00';
const FIM = '2026-08-06T15:00:00.000-03:00';

async function montar({ agora = new Date('2026-08-05T12:00:00.000-03:00') } = {}) {
  const relogio = { atual: agora };
  const agoraFn = () => relogio.atual;

  const repositorio = criarRepositorioEmMemoria({ agora: agoraFn });
  const repositorioGoogle = criarRepositorioGoogleEmMemoria({ agora: agoraFn, repositorio });
  const google = criarGoogleFalso({ agora: agoraFn });
  const calendario = criarCalendarioGoogle({
    credencial: CREDENCIAL,
    usuario: 'medico@clinica.test',
    calendario: 'primary',
  }, { fetch: google.fetch });
  const outbox = criarOutboxGoogle({
    repositorio, repositorioGoogle, calendario, clinica: 'Clínica Teste', agora: agoraFn,
  });
  const sincronia = criarSincroniaGoogle({
    repositorio, repositorioGoogle, calendario, outbox, agora: agoraFn,
  });

  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Edson', duracaoMin: 30 });
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });

  async function agendamentoSincronizado() {
    const agendamento = await repositorio.criarAgendamento({
      profissionalId: profissional.id, contatoId: contato.id, inicio: INICIO, fim: FIM,
    });
    await outbox.registrarMudanca(agendamento.id, 'criar');
    await outbox.processarLote({});
    return repositorio.obterAgendamento(agendamento.id);
  }

  return { repositorio, repositorioGoogle, google, calendario, outbox, sincronia, relogio, agendamentoSincronizado };
}

test('primeira varredura é full sync e grava o cursor só no fim', async () => {
  const { repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  await agendamentoSincronizado();

  const estadoAntes = await repositorioGoogle.garantirEstadoDaSincronia('primary');
  assert.equal(estadoAntes.precisa_full_sync, true);

  const resultado = await sincronia.sincronizar({});
  assert.equal(resultado.sincronizado, true);
  assert.equal(resultado.fullSync, true);
  assert.ok(resultado.eventos >= 1);

  const estado = await repositorioGoogle.obterEstadoDaSincronia('primary');
  assert.ok(estado.next_sync_token, 'cursor gravado ao final da última página');
  assert.equal(estado.precisa_full_sync, false);
  assert.ok(estado.ultimo_full_sync_em);
  assert.ok(google.eventos.size >= 1);
});

test('paginação: o cursor só aparece depois da última página', async () => {
  const { repositorioGoogle, google, sincronia } = await montar();

  // Dois eventos externos e página de tamanho 1: a primeira resposta traz
  // pageToken, não syncToken — e o cursor local não pode andar antes da hora.
  for (const dia of ['2026-08-06', '2026-08-07']) {
    google.eventos.set(`externo-${dia}`, {
      id: `externo-${dia}`,
      summary: 'Compromisso pessoal',
      start: { dateTime: `${dia}T09:00:00.000-03:00` },
      end: { dateTime: `${dia}T10:00:00.000-03:00` },
      status: 'confirmed', etag: '"e1"', versao: 1,
    });
  }

  const pagina1 = await sincronia ? await googlePagina(google) : null;
  assert.ok(pagina1.proximaPagina);
  assert.equal(pagina1.proximoSyncToken, null);

  const pagina2 = await googlePagina(google, pagina1.proximaPagina);
  assert.equal(pagina2.proximaPagina, null);
  assert.ok(pagina2.proximoSyncToken);

  // E a varredura completa pelo serviço deixa tudo mapeado como externo.
  const resultado = await sincronia.sincronizar({});
  assert.equal(resultado.fullSync, true);
  const externos = await repositorioGoogle.listarEventosExternos({ calendario: 'primary' });
  assert.equal(externos.length, 2);

  async function googlePagina(g, pageToken = null) {
    return g.fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({
      maxResults: '1', singleEvents: 'true', showDeleted: 'true',
      timeMin: '2026-08-01T00:00:00.000-03:00', timeMax: '2026-09-01T00:00:00.000-03:00',
      ...(pageToken ? { pageToken } : {}),
    })}`).then((r) => r.json()).then((d) => ({
      itens: d.items, proximaPagina: d.nextPageToken ?? null, proximoSyncToken: d.nextSyncToken ?? null,
    }));
  }
});

test('incremental traz só o que mudou, inclusive os apagados', async () => {
  const { repositorio, repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();

  await sincronia.sincronizar({}); // full sync inicial: cursor gravado

  // Nada mudou: o incremental vem vazio e barato.
  const vazio = await sincronia.sincronizar({});
  assert.equal(vazio.fullSync, false);
  assert.equal(vazio.eventos, 0);

  // Alguém apaga o evento no Google: o incremental mostra o cancelado
  // (showDeleted) e a consulta vira conflito — não é cancelada em silêncio.
  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    { method: 'DELETE' },
  );

  const leitura = await sincronia.sincronizar({});
  assert.equal(leitura.conflitos, 1);

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.status, 'agendado', 'o CRM não cancela sozinho');
  assert.equal(atualizado.sync_status, 'conflito');

  const conflitos = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  assert.equal(conflitos[0].tipo, 'cancelado_no_google');
});

test('410 no incremental refaz o full sync de forma controlada', async () => {
  const { repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  await agendamentoSincronizado();
  await sincronia.sincronizar({});

  google.vencerCursors();
  const resultado = await sincronia.sincronizar({});

  assert.equal(resultado.sincronizado, true);
  assert.equal(resultado.fullSync, true, 'o 410 mandou refazer como full sync');

  const estado = await repositorioGoogle.obterEstadoDaSincronia('primary');
  assert.equal(estado.precisa_full_sync, false, 'full sync refeito limpa a dívida');
  assert.ok(estado.next_sync_token, 'cursor novo gravado');
});

test('evento estranho à clínica vira externo, não conflito', async () => {
  const { repositorioGoogle, google, sincronia } = await montar();

  google.eventos.set('dentista-1', {
    id: 'dentista-1',
    summary: 'Dentista',
    start: { dateTime: '2026-08-06T09:00:00.000-03:00' },
    end: { dateTime: '2026-08-06T10:00:00.000-03:00' },
    status: 'confirmed', etag: '"e1"', versao: 1,
  });

  const resultado = await sincronia.sincronizar({});
  assert.equal(resultado.externos, 1);
  assert.equal(resultado.conflitos, 0);

  const externos = await repositorioGoogle.listarEventosExternos({ calendario: 'primary' });
  assert.equal(externos[0].titulo, 'Dentista');
});

test('edição no Google com CRM parado vira conflito de edição concorrente', async () => {
  const { repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();
  await sincronia.sincronizar({});

  // O médico move a consulta pelo celular.
  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: '2026-08-06T16:00:00.000-03:00' },
        end: { dateTime: '2026-08-06T17:00:00.000-03:00' },
      }),
    },
  );

  const leitura = await sincronia.sincronizar({});
  assert.equal(leitura.conflitos, 1);

  const conflitos = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  assert.equal(conflitos[0].tipo, 'edicao_concorrente');
  assert.equal(conflitos[0].detalhe_google.inicio, '2026-08-06T16:00:00.000-03:00');
});

test('resolver com crm_vence reimpõe o estado do CRM pelo outbox', async () => {
  const { repositorio, repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();
  await sincronia.sincronizar({});

  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: '2026-08-06T16:00:00.000-03:00' },
        end: { dateTime: '2026-08-06T17:00:00.000-03:00' },
      }),
    },
  );
  await sincronia.sincronizar({});

  const [conflito] = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  await sincronia.resolverConflito(conflito.id, { resolucao: 'crm_vence', usuarioId: 1 });

  // A resolução enfileira; o worker entrega o horário do CRM no Google.
  const fila = [...repositorioGoogle._outbox.values()];
  assert.equal(fila.at(-1).operacao, 'atualizar');

  const resolvido = await repositorioGoogle.obterConflito(conflito.id);
  assert.equal(resolvido.estado, 'resolvido');
  assert.equal(resolvido.resolucao, 'crm_vence');

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'pendente', 'aguardando o worker reimpor o CRM');
});

test('resolver cancelado_no_google com crm_vence recria o evento', async () => {
  const { repositorioGoogle, google, sincronia, outbox, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();
  await sincronia.sincronizar({});

  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    { method: 'DELETE' },
  );
  await sincronia.sincronizar({});

  const [conflito] = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  await sincronia.resolverConflito(conflito.id, { resolucao: 'crm_vence', usuarioId: 1 });
  await outbox.processarLote({});

  // O evento volta a existir com o mesmo id determinístico.
  const evento = google.eventos.get(eventoId);
  assert.equal(evento.status, 'confirmed');
  assert.equal(evento.start.dateTime, new Date(INICIO).toISOString());
});

test('resolver com google_vence aplica o cancelamento no CRM com origem google', async () => {
  const { repositorio, repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();
  await sincronia.sincronizar({});

  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    { method: 'DELETE' },
  );
  await sincronia.sincronizar({});

  const [conflito] = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  await sincronia.resolverConflito(conflito.id, { resolucao: 'google_vence', usuarioId: 1 });

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.status, 'cancelado');
  assert.equal(atualizado.origem_alteracao, 'google');
  assert.equal(atualizado.sync_status, 'ok');
});

test('reconciliar confere os vinculados e denuncia o que o incremental perdeu', async () => {
  const { repositorio, repositorioGoogle, google, sincronia, agendamentoSincronizado } = await montar();
  const agendamento = await agendamentoSincronizado();

  // O evento some do Google SEM passar pelo incremental (cursor parado,
  // webhook perdido — a reconciliação existe para isso).
  const eventoId = idDoEvento(agendamento.id);
  google.eventos.delete(eventoId);

  const conferencia = await sincronia.reconciliar({});
  assert.equal(conferencia.reconciliado, true);
  assert.equal(conferencia.ausentes_no_google, 1);
  assert.equal(conferencia.conflitos, 1);

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'conflito');

  const [conflito] = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  assert.equal(conflito.tipo, 'cancelado_no_google');

  // E o que está igual é carimbado, sem conflito.
  const { sincronia: s2, agendamentoSincronizado: a2 } = await montar();
  await a2();
  const ok = await s2.reconciliar({});
  assert.equal(ok.iguais, 1);
  assert.equal(ok.conflitos, 0);
});

test('saúde agrega cursor, conflitos, agendamentos e a fila do outbox', async () => {
  const { sincronia, agendamentoSincronizado } = await montar();
  await agendamentoSincronizado();
  await sincronia.sincronizar({});

  const saude = await sincronia.saude();
  assert.equal(saude.disponivel, true);
  assert.equal(saude.cursor.tem_cursor, true);
  assert.equal(saude.conflitos_abertos, 0);
  assert.ok(saude.agendamentos);
  assert.ok(saude.outbox, 'a fila do outbox aparece no painel');
  assert.ok(saude.outbox.ok_24h >= 1);
});
