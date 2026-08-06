'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redigirAuditoria, chaveESensivel } = require('../src/seguranca/redator-auditoria');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// A trilha de auditoria não pode conter segredos — nem os que o trigger do
// banco grava (migration 017 corrige a origem), nem os que chegariam por um
// detalhe montado errado na aplicação, nem os que já estão no histórico.
//
// Nenhum valor de teste aqui é um segredo real: são marcadores sintéticos.
// Nenhum teste imprime o valor de uma chave sensível.

const MARCADOR = 'valor-sintetico-de-teste';

test('redator remove as chaves sensíveis conhecidas de usuarios', () => {
  const detalhe = {
    old: { id: 1, nome: 'Fulana', senha_hash: MARCADOR, totp_segredo_cifrado: MARCADOR },
    new: { id: 1, nome: 'Fulana B.', senha_hash: MARCADOR, totp_segredo_cifrado: null },
  };
  const limpo = redigirAuditoria(detalhe);

  assert.equal('senha_hash' in limpo.old, false);
  assert.equal('totp_segredo_cifrado' in limpo.old, false);
  assert.equal('senha_hash' in limpo.new, false);
  assert.equal('totp_segredo_cifrado' in limpo.new, false);
  // O que não é segredo permanece.
  assert.equal(limpo.old.nome, 'Fulana');
  assert.equal(limpo.new.nome, 'Fulana B.');
  assert.equal(limpo.old.id, 1);
});

test('redator nega por padrão chaves claramente secretas que ninguém listou', () => {
  const detalhe = {
    hash_token: MARCADOR,
    refresh_token: MARCADOR,
    session_token: MARCADOR,
    api_key: MARCADOR,
    apiKey: MARCADOR,
    stripe_secret: MARCADOR,
    google_credential: MARCADOR,
    chave_privada: MARCADOR,
    novo_password_hash: MARCADOR,
  };
  const limpo = redigirAuditoria(detalhe);
  assert.deepEqual(Object.keys(limpo), []);
});

test('precisa_trocar_senha é flag de fluxo, não segredo — permanece', () => {
  const limpo = redigirAuditoria({ precisa_trocar_senha: true, totp_ativo: false });
  assert.deepEqual(limpo, { precisa_trocar_senha: true, totp_ativo: false });
});

test('redator alcança objetos e arrays aninhados em qualquer profundidade', () => {
  const detalhe = {
    nivel1: {
      lista: [
        { senha_hash: MARCADOR, ok: 1 },
        { nivel3: { token_recuperacao: MARCADOR, ok: 2 } },
        'texto',
        7,
      ],
    },
  };
  const limpo = redigirAuditoria(detalhe);
  assert.deepEqual(limpo, {
    nivel1: { lista: [{ ok: 1 }, { nivel3: { ok: 2 } }, 'texto', 7] },
  });
});

test('redator não altera o objeto original', () => {
  const original = { old: { senha_hash: MARCADOR, nome: 'x' } };
  redigirAuditoria(original);
  assert.equal(original.old.senha_hash, MARCADOR);
  assert.equal(original.old.nome, 'x');
});

test('valores primitivos e nulos atravessam intactos', () => {
  assert.equal(redigirAuditoria(null), null);
  assert.equal(redigirAuditoria('texto'), 'texto');
  assert.equal(redigirAuditoria(42), 42);
});

test('chaveESensivel decide por nome, sem olhar o valor', () => {
  assert.equal(chaveESensivel('senha_hash'), true);
  assert.equal(chaveESensivel('SENHA_HASH'), true);
  assert.equal(chaveESensivel('totp_segredo_cifrado'), true);
  assert.equal(chaveESensivel('precisa_trocar_senha'), false);
  assert.equal(chaveESensivel('nome'), false);
  assert.equal(chaveESensivel('ultimo_login_em'), false);
});

// ─── A costura de escrita: registrarAuditoria redige na entrada ───

test('registrarAuditoria descarta segredos de um detalhe contaminado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({
    entidade: 'usuarios',
    entidadeId: 1,
    acao: 'update',
    detalhe: {
      old: { id: 1, nome: 'A', senha_hash: MARCADOR },
      new: { id: 1, nome: 'B', senha_hash: MARCADOR, totp_segredo_cifrado: MARCADOR },
    },
  });

  const trilha = repositorio._auditoria ?? repositorio.auditoria ?? null;
  const registro = Array.isArray(trilha) ? trilha.at(-1) : null;
  assert.ok(registro, 'o repositório em memória expõe a trilha para os testes');
  const texto = JSON.stringify(registro);
  assert.equal(texto.includes(MARCADOR), false);
  assert.equal(texto.includes('senha_hash'), false);
  assert.equal(texto.includes('totp_segredo_cifrado'), false);
  // Metadados e campos úteis permanecem.
  assert.equal(registro.acao, 'update');
  assert.equal(registro.detalhe.old.nome, 'A');
  assert.equal(registro.detalhe.new.nome, 'B');
});

test('auditoria sem segredos passa intacta — inclusive a de cancelamento', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({
    entidade: 'agendamento',
    entidadeId: 35,
    acao: 'agendamento_cancelado',
    detalhe: { motivo: 'ensaio encerrado' },
    usuarioId: 1,
  });

  const trilha = repositorio._auditoria ?? repositorio.auditoria ?? null;
  const registro = Array.isArray(trilha) ? trilha.at(-1) : null;
  assert.ok(registro);
  assert.deepEqual(registro.detalhe, { motivo: 'ensaio encerrado' });
  assert.equal(registro.acao, 'agendamento_cancelado');
  assert.equal(registro.usuarioId, 1);
});

test('eventos de outras entidades não perdem campos legítimos', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({
    entidade: 'lead',
    entidadeId: 132,
    acao: 'lead_estagio_alterado',
    detalhe: { de: 'qualificando', para: 'agendado', motivo: null },
  });
  const trilha = repositorio._auditoria ?? repositorio.auditoria ?? null;
  const registro = Array.isArray(trilha) ? trilha.at(-1) : null;
  assert.deepEqual(registro.detalhe, { de: 'qualificando', para: 'agendado', motivo: null });
});

// ─── A migration 017: o texto precisa dizer o que o banco vai fazer ───

const CAMINHO_MIGRATION = path.join(__dirname, '..', 'db', '017_redacao_segredos_auditoria.sql');

test('migration 017 existe e redige exatamente as chaves do schema real', () => {
  const sql = fs.readFileSync(CAMINHO_MIGRATION, 'utf8');
  assert.match(sql, /array\['senha_hash', 'totp_segredo_cifrado'\]/);
  assert.match(sql, /tg_table_name = 'usuarios'/);
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
});

test('migration 017 limpa o histórico sem apagar linhas e registra o evento semântico', () => {
  const sql = fs.readFileSync(CAMINHO_MIGRATION, 'utf8');
  assert.match(sql, /UPDATE public\.audit_log/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.audit_log/i);
  assert.match(sql, /sanitizacao_de_segredos/);
  assert.match(sql, /linhas_sanitizadas/);
  assert.match(sql, /irrevers/i);
});

test('migration 017 não contém nenhum valor que pareça segredo', () => {
  const sql = fs.readFileSync(CAMINHO_MIGRATION, 'utf8');
  // Nenhum hash scrypt/bcrypt/base64 longo embutido no arquivo.
  assert.doesNotMatch(sql, /scrypt\$|\$2[aby]\$|[A-Za-z0-9+/=]{60,}/);
});
