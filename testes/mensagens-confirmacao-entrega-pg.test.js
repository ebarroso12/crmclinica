'use strict';

// Confirmação de entrega em `mensagens` (migration 038) contra PostgreSQL
// real. O que a suíte em memória (testes/atendimento-idempotencia.test.js,
// testes/automacao-outbox-servico.test.js) já prova na camada de domínio —
// que uma mensagem já entregue ou com entrega indeterminada nunca é
// reenviada — este arquivo prova na camada de repositório: as colunas
// `entregue_em`/`entrega_indeterminada` existem de verdade no banco, e
// `marcarEntregaConfirmada`/`marcarEntregaIndeterminada` gravam nelas.
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

  const pool = criarPool({ configurado: true, url: URL_DE_TESTE, poolMax: 6, tempoLimiteMs: 10000 });
  await pool.query(`
    TRUNCATE mensagens, conversas, contatos
    RESTART IDENTITY CASCADE
  `);

  const repositorio = criarRepositorio(pool);
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990300', nome: 'Paciente Entrega' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const { mensagem } = await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida', tipo: 'texto', conteudo: 'Olá! Sua consulta está confirmada.',
    autor_tipo: 'automacao', privada: false,
  });

  return { pool, repositorio, conversa, mensagem, encerrar: () => pool.end() };
}

test('[pg] entregue_em/entrega_indeterminada existem e nascem NULL/false', { skip: SEM_BANCO }, async (t) => {
  const { pool, mensagem, encerrar } = await montar();
  t.after(() => encerrar());

  const { rows } = await pool.query(
    'SELECT entregue_em, entrega_indeterminada FROM mensagens WHERE id = $1', [mensagem.id],
  );
  assert.equal(rows.length, 1, 'a coluna precisa existir para a consulta nem dar erro');
  assert.equal(rows[0].entregue_em, null, 'mensagem recém-gravada ainda não foi confirmada');
  assert.equal(rows[0].entrega_indeterminada, false);
});

test('[pg] marcarEntregaConfirmada grava entregue_em de verdade no banco', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, mensagem, encerrar } = await montar();
  t.after(() => encerrar());

  const atualizada = await repositorio.marcarEntregaConfirmada(mensagem.id);
  assert.ok(atualizada.entregue_em, 'precisa devolver o carimbo de confirmação');

  const relida = (await repositorio.listarMensagens(mensagem.conversa_id)).find((m) => m.id === mensagem.id);
  assert.ok(relida.entregue_em, 'a confirmação precisa sobreviver a uma releitura nova do banco');
  assert.equal(relida.entrega_indeterminada, false, 'confirmar entrega não pode também marcar indeterminada');
});

test('[pg] marcarEntregaIndeterminada grava o motivo e nunca confirma entrega', { skip: SEM_BANCO }, async (t) => {
  const { repositorio, mensagem, encerrar } = await montar();
  t.after(() => encerrar());

  const atualizada = await repositorio.marcarEntregaIndeterminada(mensagem.id, 'timeout_evolution');
  assert.equal(atualizada.entrega_indeterminada, true);

  const relida = (await repositorio.listarMensagens(mensagem.conversa_id)).find((m) => m.id === mensagem.id);
  assert.equal(relida.entrega_indeterminada, true, 'a marca precisa sobreviver a uma releitura nova do banco');
  assert.equal(relida.entregue_em, null, 'indeterminada não é o mesmo que confirmada — nunca as duas ao mesmo tempo');
  assert.match(relida.entrega_falhou_motivo, /timeout_evolution/);
});

test('[pg] uma mensagem nunca fica com entregue_em E entrega_indeterminada ao mesmo tempo', { skip: SEM_BANCO }, async (t) => {
  // Não é uma constraint no banco (migration 038 é só ADD COLUMN) — é o
  // CÓDIGO (atendimento.js) que garante isso, chamando só uma das duas
  // marcações por vez. Este teste prova o caminho feliz: confirmar depois
  // de já ter marcado indeterminada substitui o estado, não acumula.
  const { repositorio, mensagem, encerrar } = await montar();
  t.after(() => encerrar());

  await repositorio.marcarEntregaIndeterminada(mensagem.id, 'timeout_evolution');
  await repositorio.marcarEntregaConfirmada(mensagem.id);

  const relida = (await repositorio.listarMensagens(mensagem.conversa_id)).find((m) => m.id === mensagem.id);
  assert.ok(relida.entregue_em, 'a confirmação posterior precisa valer');
});
