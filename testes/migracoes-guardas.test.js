'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// Guardas das migrations 026 e 029 — nascidas de um incidente real: a primeira
// aplicação da 026 em produção caiu com `column l.criado_em does not exist`,
// porque o repositório em memória expunha uma coluna que o esquema real nunca
// teve, e a suíte inteira passou em cima da coluna fantasma.
//
// Estes testes quebram o build se o erro voltar por qualquer porta.

const SQL_026 = fs.readFileSync(path.join(__dirname, '..', 'db', '026_analitica.sql'), 'utf8');
const SQL_029 = fs.readFileSync(path.join(__dirname, '..', 'db', '029_restringir_delete_operacao.sql'), 'utf8');

// ---------------------------------------------------------------- 026

test('026 não referencia leads.criado_em — a coluna não existe no esquema real', () => {
  // `l.` é o alias de leads em todas as views; `leads.criado_em` pega acesso direto.
  assert.ok(!/\bl\.criado_em\b/.test(SQL_026), 'referência via alias l. reapareceu');
  assert.ok(!/\bleads\.criado_em\b/.test(SQL_026), 'referência direta leads.criado_em reapareceu');
});

test('026: o dia de criação do lead vem de lead_eventos, com fallback declarado', () => {
  assert.match(SQL_026, /FROM lead_eventos e/i);
  assert.match(SQL_026, /min\(e\.criado_em\)/i);
  assert.match(SQL_026, /coalesce\(pe\.criado_em, l\.atualizado_em\)/i);
});

test('026: toda view nasce com security_invoker', () => {
  const criacoes = SQL_026.match(/CREATE OR REPLACE VIEW \w+/g) ?? [];
  const comInvoker = SQL_026.match(/CREATE OR REPLACE VIEW \w+ WITH \(security_invoker = true\)/g) ?? [];
  assert.ok(criacoes.length >= 7, `esperava ao menos 7 views; achei ${criacoes.length}`);
  assert.equal(comInvoker.length, criacoes.length, 'view sem security_invoker fura o RLS das tabelas-base');
});

test('026: PUBLIC é revogado explicitamente das views e da tabela de eventos', () => {
  assert.match(SQL_026, /REVOKE ALL ON public\.eventos_analiticos FROM PUBLIC/);
  assert.match(SQL_026, /REVOKE ALL ON vw_[\s\S]*?FROM PUBLIC/);
});

test('026 continua atômica: um BEGIN, um COMMIT, nenhum COMMIT intermediário', () => {
  assert.equal((SQL_026.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((SQL_026.match(/^COMMIT;/gm) ?? []).length, 1);
});

// -------------------------------------------------- paridade do esquema real

test('o lead do repositório em memória NÃO expõe criado_em — como o banco de verdade', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const contato = await repositorio.encontrarOuCriarContato({
    telefone: '5511933330001', nome: 'Paridade', canal: 'whatsapp',
  });
  const lead = await repositorio.salvarLead(contato.id, { origem: 'WHATSAPP' });

  assert.ok(!('criado_em' in lead),
    'leads não tem criado_em no esquema real; o espelho não pode inventar a coluna');
  const relido = await repositorio.obterLead(lead.id);
  assert.ok(!('criado_em' in relido));
});

test('leads por dia usa o primeiro evento da jornada; sem evento, o fallback é atualizado_em', async () => {
  const relogio = { momento: new Date('2026-08-03T12:00:00.000Z') };
  const repositorio = criarRepositorioEmMemoria({ agora: () => new Date(relogio.momento) });

  // Lead COM jornada: nasce no dia 03 (primeiro evento), mesmo com o lead
  // atualizado dias depois.
  const a = await repositorio.encontrarOuCriarContato({
    telefone: '5511933330002', nome: 'Com Jornada', canal: 'whatsapp',
  });
  const leadA = await repositorio.salvarLead(a.id, { origem: 'WHATSAPP' });
  await repositorio.registrarEventoDeLead({
    lead_id: leadA.id, tipo: 'primeiro_contato', origem: 'contato',
  });

  relogio.momento = new Date('2026-08-06T12:00:00.000Z');
  await repositorio.atualizarLead(leadA.id, { interesse: 'avaliação' });

  // Lead SEM jornada: cai no fallback (atualizado_em = dia 06).
  const b = await repositorio.encontrarOuCriarContato({
    telefone: '5511933330003', nome: 'Sem Jornada', canal: 'whatsapp',
  });
  await repositorio.salvarLead(b.id, { origem: 'SITE' });

  const linhas = await repositorio.metricasLeadsPorDia({ de: '2026-08-01', ate: '2026-08-10' });

  const doA = linhas.find((linha) => linha.origem === 'WHATSAPP');
  const doB = linhas.find((linha) => linha.origem === 'SITE');
  assert.equal(doA.dia, '2026-08-03', 'o dia vem do PRIMEIRO evento da jornada');
  assert.equal(doB.dia, '2026-08-06', 'sem jornada, o fallback declarado é atualizado_em');
});

// ---------------------------------------------------------------- 029

test('029 revoga DELETE de crmclinica_app nas duas tabelas de operação — e só nelas', () => {
  assert.match(SQL_029, /'operacao_heartbeats', 'auditoria_exportacoes'/);
  assert.match(SQL_029, /REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.%I FROM crmclinica_app/);
  assert.match(SQL_029, /GRANT SELECT, INSERT, UPDATE ON public\.%I TO crmclinica_app/);

  // Escopo estrito: nenhuma outra tabela do produto aparece no arquivo.
  for (const foraDoEscopo of ['mensagens', 'conversas', 'contatos', 'leads', 'agendamentos',
    'lembretes', 'audit_log', 'usuarios', 'ia_chamadas', 'tarefas']) {
    assert.ok(!new RegExp(`'${foraDoEscopo}'`).test(SQL_029),
      `029 não pode tocar em ${foraDoEscopo}`);
  }
});

test('029 revoga PUBLIC, anon e authenticated de modo defensivo, com guards', () => {
  assert.match(SQL_029, /REVOKE ALL ON public\.%I FROM PUBLIC/);
  assert.match(SQL_029, /ARRAY\['anon', 'authenticated'\]/);
  assert.match(SQL_029, /to_regclass\('public\.' \|\| t\) IS NULL/,
    'guard de existência de tabela é obrigatório');
  assert.match(SQL_029, /pg_roles WHERE rolname = 'crmclinica_app'/,
    'guard de existência de role é obrigatório');
});

test('029 é atômica e idempotente por construção', () => {
  assert.equal((SQL_029.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((SQL_029.match(/^COMMIT;/gm) ?? []).length, 1);
  // Comandos de estrutura/dados, não palavras soltas: "UPDATE" aparece
  // legitimamente dentro de GRANT/REVOKE.
  assert.ok(!/\b(CREATE|ALTER|DROP)\s+TABLE\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\s+TABLE\b/i.test(SQL_029),
    '029 só mexe em privilégios — nunca em estrutura ou dados');
});

// O teste negativo EXECUTÁVEL contra o banco real vive em bin/verificar-banco.js:
// as duas tabelas entram em SEM_DELETE, e `npm run verificar-banco` falha se a
// aplicação puder apagá-las. Aqui, o build garante que a lista não regrida.
test('verificar-banco cobra o não-DELETE das tabelas de operação', () => {
  const verificador = fs.readFileSync(path.join(__dirname, '..', 'bin', 'verificar-banco.js'), 'utf8');
  const semDelete = verificador.match(/const SEM_DELETE = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.match(semDelete, /'operacao_heartbeats'/);
  assert.match(semDelete, /'auditoria_exportacoes'/);
});

// ---------------------------------------------------------- 031 (Comando 3)

const SQL_031 = fs.readFileSync(path.join(__dirname, '..', 'db', '031_automacao_outbox.sql'), 'utf8');
const SQL_031_ROLLBACK = fs.readFileSync(path.join(__dirname, '..', 'db', '031_automacao_outbox_rollback.sql'), 'utf8');

test('031: automacao_outbox habilita RLS e revoga anon/authenticated explicitamente', () => {
  assert.match(SQL_031, /ALTER TABLE public\.automacao_outbox ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL_031, /REVOKE ALL ON public\.automacao_outbox FROM %I/);
  assert.match(SQL_031, /ARRAY\['anon', 'authenticated'\]/);
});

test('031: só crmclinica_app recebe GRANT na tabela nova, com guard de existência da role', () => {
  assert.match(SQL_031, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.automacao_outbox TO crmclinica_app/);
  assert.match(SQL_031, /pg_roles WHERE rolname = 'crmclinica_app'/);
  // Nenhuma outra role nomeada recebe GRANT nesta tabela.
  const concessoes = [...SQL_031.matchAll(/GRANT [\s\S]*?ON public\.automacao_outbox TO (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(concessoes, ['crmclinica_app']);
});

test('031 é aditiva: nenhum DROP TABLE, DROP COLUMN ou TRUNCATE', () => {
  const semComentarios = SQL_031.replace(/--.*$/gm, '');
  assert.ok(!/DROP\s+TABLE/i.test(semComentarios), '031 não pode fazer DROP TABLE de nada — nem da própria tabela nova');
  assert.ok(!/DROP\s+COLUMN/i.test(semComentarios));
  assert.ok(!/TRUNCATE/i.test(semComentarios));
  assert.match(SQL_031, /CREATE TABLE IF NOT EXISTS automacao_outbox/);
});

test('031 é atômica: um BEGIN, um COMMIT', () => {
  assert.equal((SQL_031.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((SQL_031.match(/^COMMIT;/gm) ?? []).length, 1);
});

test('031: a tabela não guarda conteúdo de mensagem — só referências e motivo técnico', () => {
  // Só o SQL executável, sem os comentários que EXPLICAM por que essas
  // colunas não existem (que citam as próprias palavras de propósito).
  const semComentarios = SQL_031.replace(/--.*$/gm, '');
  // Nenhuma coluna de texto livre de conversa: nem "conteudo", nem "texto",
  // nem "prompt", nem "resposta". Só IDs, status, contadores, timestamps e
  // `ultimo_erro` (documentado como técnico).
  for (const proibida of ['conteudo', 'texto_paciente', 'prompt', 'resposta_ia', 'token', 'segredo']) {
    assert.ok(!new RegExp(`\\b${proibida}\\b`, 'i').test(semComentarios), `coluna "${proibida}" não pode existir em automacao_outbox`);
  }
});

// ---------------------------------------------------------- 032 (Comando 7, achado A-3)

const SQL_032 = fs.readFileSync(path.join(__dirname, '..', 'db', '032_mensagens_marca_entrega_falhou.sql'), 'utf8');

test('032 é aditiva: só ADD COLUMN, nenhum DROP, DELETE ou UPDATE em linha existente', () => {
  const semComentarios = SQL_032.replace(/--.*$/gm, '');
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(semComentarios), '032 não pode remover nada');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(semComentarios), '032 não pode apagar linha nenhuma');
  assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(semComentarios), '032 não pode reescrever linha existente');
  assert.match(SQL_032, /ALTER TABLE public\.mensagens\s+ADD COLUMN IF NOT EXISTS entrega_falhou boolean NOT NULL DEFAULT false/);
  assert.match(SQL_032, /ALTER TABLE public\.mensagens\s+ADD COLUMN IF NOT EXISTS entrega_falhou_motivo text/);
});

test('032 não redefine RLS nem GRANT — a coluna herda o que a tabela já tinha', () => {
  const semComentarios = SQL_032.replace(/--.*$/gm, '');
  assert.ok(!/ENABLE ROW LEVEL SECURITY/i.test(semComentarios));
  assert.ok(!/\bGRANT\b/i.test(semComentarios));
  assert.ok(!/\bREVOKE\b/i.test(semComentarios));
});

test('032 é atômica: um BEGIN, um COMMIT', () => {
  assert.equal((SQL_032.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((SQL_032.match(/^COMMIT;/gm) ?? []).length, 1);
});

test('032: nenhum conteúdo de conversa nas colunas novas — só a marca técnica', () => {
  const semComentarios = SQL_032.replace(/--.*$/gm, '');
  for (const proibida of ['conteudo_paciente', 'texto_gerado', 'prompt', 'resposta_ia']) {
    assert.ok(!new RegExp(`\\b${proibida}\\b`, 'i').test(semComentarios), `coluna "${proibida}" não pode existir`);
  }
});

test('031_rollback existe, é aditivo em espírito (só derruba o que a 031 criou) e documenta o custo', () => {
  assert.match(SQL_031_ROLLBACK, /DROP TABLE IF EXISTS public\.automacao_outbox/);
  // Nenhuma outra tabela do produto é tocada pelo rollback.
  for (const foraDoEscopo of ['mensagens', 'conversas', 'contatos', 'leads', 'agendamentos', 'lembretes']) {
    assert.ok(!new RegExp(`\\b${foraDoEscopo}\\b`).test(SQL_031_ROLLBACK.replace(/--.*$/gm, '')),
      `o rollback da 031 não pode tocar em ${foraDoEscopo}`);
  }
  assert.match(SQL_031_ROLLBACK, /BEGIN;/);
  assert.match(SQL_031_ROLLBACK, /COMMIT;/);
});
