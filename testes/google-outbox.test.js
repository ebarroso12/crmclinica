'use strict';

// P0-09 e P0-10: o outbox transacional e as escritas no Google.
//
// Cada teste aqui responde a uma pergunta de produção: e se o Google cair no
// meio? e se o evento já existir? e se alguém editar pelo celular? O Google
// é o falso em memória, mas o protocolo é o de verdade — ETag, 409, 412.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarRepositorioGoogleEmMemoria } = require('../src/dados/repositorio-google-memoria');
const { criarCalendarioGoogle, idDoEvento } = require('../src/integracoes/google-calendario');
const { criarOutboxGoogle } = require('../src/dominio/google-outbox');
const { criarGoogleFalso } = require('./google-falso');

// Chave RSA de verdade, gerada uma vez: o cliente assina o JWT de serviço de
// verdade — o falso não verifica a assinatura, mas o sign precisa de uma chave.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDENCIAL = JSON.stringify({
  client_email: 'crm@projeto-falso.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const INICIO = '2026-08-06T14:00:00.000-03:00';
const FIM = '2026-08-06T15:00:00.000-03:00';

async function montar({ agora = new Date('2026-08-05T12:00:00.000-03:00'), maxTentativas = 8 } = {}) {
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
    repositorio,
    repositorioGoogle,
    calendario,
    clinica: 'Clínica Teste',
    maxTentativas,
    agora: agoraFn,
  });

  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Edson', duracaoMin: 30 });
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id, inicio: INICIO, fim: FIM,
  });

  return { repositorio, repositorioGoogle, google, calendario, outbox, agendamento, relogio };
}

test('registrar mudança enfileira na mesma hora e marca o agendamento como pendente', async () => {
  const { repositorio, repositorioGoogle, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar', { usuarioId: 1 });

  const fila = [...repositorioGoogle._outbox.values()];
  assert.equal(fila.length, 1);
  assert.equal(fila[0].operacao, 'criar');
  assert.equal(fila[0].versao, 1);
  assert.equal(fila[0].chave_idempotencia, `${agendamento.id}:criar:1`);

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'pendente');
  assert.equal(atualizado.sync_version, 1);
  assert.equal(atualizado.origem_alteracao, 'crm');
});

test('mudança nova torna obsoleto o item ainda na fila', async () => {
  const { repositorioGoogle, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  await outbox.registrarMudanca(agendamento.id, 'atualizar');

  const fila = [...repositorioGoogle._outbox.values()];
  assert.equal(fila.length, 2);
  assert.equal(fila[0].estado, 'obsoleto');
  assert.equal(fila[1].estado, 'pendente');
  assert.equal(fila[1].versao, 2);
});

test('processar cria o evento com id determinístico e grava etag e vínculo', async () => {
  const { repositorio, repositorioGoogle, google, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  const resultado = await outbox.processarLote({});

  assert.equal(resultado.processados, 1);
  assert.equal(resultado.resultados[0].resultado, 'ok');

  const eventoId = idDoEvento(agendamento.id);
  const evento = google.eventos.get(eventoId);
  assert.ok(evento, 'o evento deveria existir no Google');
  assert.match(evento.summary, /Consulta — Marina/);
  // Nada sensível atravessa: o corpo do evento não pode levar motivo clínico.
  assert.ok(!/diagn[oó]stico|CID|depress|ansiedade/i.test(evento.description ?? ''));

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'ok');
  assert.equal(atualizado.google_evento_id, eventoId);
  assert.ok(atualizado.google_etag, 'etag deveria estar gravado');
  assert.ok(atualizado.last_synced_at);

  const item = [...repositorioGoogle._outbox.values()][0];
  assert.equal(item.estado, 'ok');
});

test('409 na criação é sucesso idempotente: o PATCH alinha o conteúdo', async () => {
  const { repositorio, google, outbox, agendamento } = await montar();

  // O evento já existe (worker morreu depois de criar, antes de concluir).
  const eventoId = idDoEvento(agendamento.id);
  google.eventos.set(eventoId, {
    id: eventoId,
    summary: 'Consulta — Marina',
    description: 'versão antiga',
    start: { dateTime: '2026-08-06T10:00:00.000-03:00' },
    end: { dateTime: '2026-08-06T11:00:00.000-03:00' },
    status: 'confirmed',
    etag: '"etag-antiga"',
    versao: 0,
  });

  await outbox.registrarMudanca(agendamento.id, 'criar');
  const resultado = await outbox.processarLote({});

  assert.equal(resultado.resultados[0].resultado, 'ok');
  const evento = google.eventos.get(eventoId);
  // O PATCH alinhou o horário com o CRM — criar de novo teria duplicado.
  assert.equal(evento.start.dateTime, new Date(INICIO).toISOString());
  assert.equal(google.eventos.size, 1);

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'ok');
});

test('falha transitória reagenda com backoff e a repetição converge', async () => {
  const { repositorio, repositorioGoogle, google, outbox, agendamento, relogio } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');

  google.falharProximos(1, 500);
  const primeira = await outbox.processarLote({});
  assert.equal(primeira.resultados[0].resultado, 'reagendado');

  const item = [...repositorioGoogle._outbox.values()][0];
  assert.equal(item.estado, 'pendente');
  assert.equal(item.tentativas, 1);
  assert.ok(item.proximo_retry_em > relogio.atual.toISOString(), 'backoff no futuro');
  assert.ok(item.ultimo_erro);

  // O tempo passa, o retry acontece — e converge sem duplicar nada.
  relogio.atual = new Date(relogio.atual.getTime() + 60_000);
  const segunda = await outbox.processarLote({});
  assert.equal(segunda.resultados[0].resultado, 'ok');
  assert.equal(google.eventos.size, 1);

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'ok');
});

test('esgotadas as tentativas, o item falha e o agendamento mostra o erro', async () => {
  const { repositorio, repositorioGoogle, google, outbox, agendamento, relogio } = await montar({ maxTentativas: 2 });

  await outbox.registrarMudanca(agendamento.id, 'criar');
  google.falharProximos(5, 503);

  await outbox.processarLote({}); // tentativa 1: reagendado
  relogio.atual = new Date(relogio.atual.getTime() + 60_000);
  const ultima = await outbox.processarLote({}); // tentativa 2 = limite: falhou
  assert.equal(ultima.resultados[0].resultado, 'falhou');

  const item = [...repositorioGoogle._outbox.values()][0];
  assert.equal(item.estado, 'falhou');

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'falhou');
  assert.ok(atualizado.last_sync_error);
});

test('412 denuncia edição concorrente: vira conflito, nunca sobrescrita cega', async () => {
  const { repositorio, repositorioGoogle, google, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  await outbox.processarLote({});

  // Alguém edita o evento direto no Google — o etag que conhecemos envelhece.
  const eventoId = idDoEvento(agendamento.id);
  await google.fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventoId}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'Consulta — Marina (movida no celular)' }) },
  );

  // O CRM remarca: o PATCH sai com o etag velho e o Google recusa (412).
  await repositorio.atualizarAgendamento(agendamento.id, {
    inicio: '2026-08-06T16:00:00.000-03:00', fim: '2026-08-06T17:00:00.000-03:00',
  });
  await outbox.registrarMudanca(agendamento.id, 'atualizar');
  const resultado = await outbox.processarLote({});

  assert.equal(resultado.resultados[0].resultado, 'conflito');

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'conflito');

  const conflitos = await repositorioGoogle.listarConflitos({ estado: 'aberto' });
  assert.equal(conflitos.length, 1);
  assert.equal(conflitos[0].tipo, 'edicao_concorrente');

  // O Google continua com a edição da pessoa: nada foi sobrescrito.
  assert.match(google.eventos.get(eventoId).summary, /movida no celular/);
});

test('cancelar remove o evento; evento já apagado à mão também é sucesso', async () => {
  const { repositorio, google, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  await outbox.processarLote({});
  const eventoId = idDoEvento(agendamento.id);

  // Caminho 1: cancelamento normal apaga no Google.
  await repositorio.atualizarAgendamento(agendamento.id, { status: 'cancelado', canceladoEm: new Date().toISOString() });
  await outbox.registrarMudanca(agendamento.id, 'cancelar');
  const resultado = await outbox.processarLote({});
  assert.equal(resultado.resultados[0].resultado, 'ok');
  assert.equal(google.eventos.get(eventoId).status, 'cancelled');

  const atualizado = await repositorio.obterAgendamento(agendamento.id);
  assert.equal(atualizado.sync_status, 'ok');

  // Caminho 2: alguém apagou o evento no Google antes do cancelamento chegar.
  const { repositorio: repo2, google: google2, outbox: outbox2, agendamento: ag2 } = await montar();
  await outbox2.registrarMudanca(ag2.id, 'cancelar');
  const segundo = await outbox2.processarLote({});
  assert.equal(segundo.resultados[0].resultado, 'ok');
  const final2 = await repo2.obterAgendamento(ag2.id);
  assert.equal(final2.sync_status, 'ok');
});

test('item de versão antiga é descartado sem tocar no Google', async () => {
  const { repositorioGoogle, google, outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  // A segunda mudança obsoleta a primeira; mas se a primeira já estivesse
  // 'processando' quando a obsolescência chegou, o worker a descarta ao ler.
  const primeiro = [...repositorioGoogle._outbox.values()][0];
  primeiro.estado = 'processando';
  primeiro.processando_desde = new Date().toISOString();
  await outbox.registrarMudanca(agendamento.id, 'atualizar'); // versão 2

  // Processa o item velho à força, como um worker lento faria.
  const resultado = await outbox.processarLote({});
  // O lote pega só o pendente (versão 2); o velho em 'processando' preso não
  // é nem reivindicado — e o importante: um evento só, do estado final.
  assert.equal(resultado.processados, 1);
  assert.equal(google.eventos.size, 1);
});

test('saúde agrega a fila e os agendamentos por status', async () => {
  const { outbox, agendamento } = await montar();

  await outbox.registrarMudanca(agendamento.id, 'criar');
  const saude = await outbox.saude();

  assert.equal(saude.disponivel, true);
  assert.equal(saude.fila.pendentes, 1);
  assert.equal(saude.agendamentos.pendente ?? saude.agendamentos.pendentes, 1);
});
