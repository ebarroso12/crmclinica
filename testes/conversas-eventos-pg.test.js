'use strict';

// Log durável do chat ao vivo (migration 037) contra PostgreSQL real —
// Pendência 4 do comando mestre. O que a suíte em memória (inbox-http.test.js)
// já prova por HTTP, este arquivo prova na camada de repositório: cursor
// monotônico de verdade (bigserial do banco, não um contador em memória),
// ticket de uso único com a MESMA guarda atômica (`RETURNING`) que
// `marcarRecuperacaoUsada` recebeu nesta sessão.
//
// Só roda por `npm run test:pg`. Sem CRMCLINICA_TEST_DATABASE_URL os casos
// ficam SKIPPED, visíveis no contador — nunca "passam vazios".

const test = require('node:test');
const assert = require('node:assert/strict');

const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';
const SEM_BANCO = URL_DE_TESTE
  ? false
  : 'exige PostgreSQL real — rode por `npm run test:pg` com CRMCLINICA_TEST_DATABASE_URL';

async function montar() {
  const { criarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');
  const { gerarHash } = require('../src/seguranca/senha');

  const pool = criarPool({ configurado: true, url: URL_DE_TESTE, poolMax: 6, tempoLimiteMs: 10000 });
  await pool.query(`
    TRUNCATE conversas_eventos, conversas_eventos_tickets,
             mensagens, conversas, contatos, usuarios
    RESTART IDENTITY CASCADE
  `);

  const repositorio = criarRepositorio(pool);
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990200', nome: 'Paciente Eventos' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const usuario = await repositorio.criarUsuario({
    nome: 'Atendente Eventos', email: `eventos-${Date.now()}@teste.local`,
    senhaHash: await gerarHash('senha-de-teste-123'), papel: 'atendente', situacao: 'ativo',
  });

  return { pool, repositorio, conversa, usuario, encerrar: () => pool.end() };
}

test('[pg] registrar evento devolve cursor monotônico crescente, e listar-desde traz só o que veio depois', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, conversa, encerrar } = await montar();
  t.after(() => encerrar());

  const e1 = await repositorio.registrarEventoDeConversa({
    conversaId: conversa.id, tipo: 'mensagem_recebida', payload: { mensagem_id: 1 },
  });
  const e2 = await repositorio.registrarEventoDeConversa({
    conversaId: conversa.id, tipo: 'mensagem_enviada', payload: { mensagem_id: 2 },
  });
  const e3 = await repositorio.registrarEventoDeConversa({
    conversaId: conversa.id, tipo: 'conversa_resolvida', payload: {},
  });

  assert.ok(e2.id > e1.id, 'o cursor precisa crescer a cada evento');
  assert.ok(e3.id > e2.id);

  // `papel: 'admin'`: este teste prova o CURSOR, não o escopo de autorização
  // (ver testes/conversas-eventos-escopo.test.js para os testes de escopo em
  // si; `listarEventosDeConversasDesde` exige `papel` desde o BLOQUEADOR 1,
  // auditoria PR #34 — admin vê tudo, o que preserva a intenção original
  // deste teste).
  const desdeE1 = await repositorio.listarEventosDeConversasDesde({ cursor: e1.id, papel: 'admin' });
  assert.deepEqual(desdeE1.map((e) => e.id), [e2.id, e3.id], 'só os eventos DEPOIS do cursor, na ordem');

  const desdeNulo = await repositorio.listarEventosDeConversasDesde({ cursor: null, limite: 10, papel: 'admin' });
  assert.deepEqual(desdeNulo.map((e) => e.id), [e1.id, e2.id, e3.id], 'sem cursor, os últimos eventos (aqui, todos)');
});

test('[pg] ticket de conexão: uso único, com RETURNING conferido — a segunda tentativa é recusada', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, usuario, encerrar } = await montar();
  t.after(() => encerrar());

  const bruto = await repositorio.criarTicketDeEventos({ usuarioId: usuario.id, papel: usuario.papel, ttlMs: 30_000 });

  const primeiro = await repositorio.resgatarTicketDeEventos(bruto);
  assert.ok(primeiro, 'o primeiro resgate precisa suceder');
  assert.equal(primeiro.usuarioId, usuario.id);
  assert.equal(primeiro.papel, usuario.papel);

  const segundo = await repositorio.resgatarTicketDeEventos(bruto);
  assert.equal(segundo, null, 'o mesmo bilhete usado duas vezes precisa ser recusado na segunda');
});

test('[pg] duas tentativas concorrentes de resgatar o MESMO ticket: só uma vence', { skip: SEM_BANCO }, async (t) => {
  // Mesma corrida que `redefinirSenha` reproduz para `recuperacoes_senha`
  // (testes/contas-http.test.js) — aqui contra o banco real, não em memória.
  const { repositorio, usuario, encerrar } = await montar();
  t.after(() => encerrar());

  const bruto = await repositorio.criarTicketDeEventos({ usuarioId: usuario.id, papel: usuario.papel });

  const [a, b] = await Promise.all([
    repositorio.resgatarTicketDeEventos(bruto),
    repositorio.resgatarTicketDeEventos(bruto),
  ]);

  const vencedores = [a, b].filter(Boolean);
  assert.equal(vencedores.length, 1, 'exatamente uma das duas chamadas concorrentes pode vencer');
});

test('[pg] ticket expirado é recusado mesmo sem nunca ter sido usado', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, usuario, encerrar } = await montar();
  t.after(() => encerrar());

  const bruto = await repositorio.criarTicketDeEventos({ usuarioId: usuario.id, papel: usuario.papel, ttlMs: -1000 });
  const resgate = await repositorio.resgatarTicketDeEventos(bruto);
  assert.equal(resgate, null, 'ticket com validade já vencida não pode ser resgatado');
});

test('[pg] ticket inventado (nunca emitido) é recusado', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, encerrar } = await montar();
  t.after(() => encerrar());

  const resgate = await repositorio.resgatarTicketDeEventos('isto-nunca-foi-emitido');
  assert.equal(resgate, null);
});
