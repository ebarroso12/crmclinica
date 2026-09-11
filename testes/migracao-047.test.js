'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guardas textuais da migration 047 (equipe dos agentes e acesso à clínica).
// Isto prova a FORMA do SQL — NÃO prova que ele roda: isso só `npm run test:pg`
// contra um PostgreSQL descartável com a 047 aplicada, e `npm run
// verificar-banco` depois de aplicar no Supabase.

const RAIZ = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(RAIZ, 'db', '047_equipe_de_agentes.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(RAIZ, 'db', '047_equipe_de_agentes_rollback.sql'), 'utf8');
const semComentarios = (texto) => texto.replace(/--.*$/gm, '');

test('047 é atômica: um BEGIN e um COMMIT, com lock_timeout logo depois do BEGIN', () => {
  for (const [nome, texto] of [['047', SQL], ['rollback', ROLLBACK]]) {
    const corpo = semComentarios(texto);
    assert.equal((corpo.match(/^BEGIN;/gm) ?? []).length, 1, `${nome}: um BEGIN`);
    assert.equal((corpo.match(/^COMMIT;/gm) ?? []).length, 1, `${nome}: um COMMIT`);
    const posTimeout = corpo.indexOf("SET LOCAL lock_timeout = '5s';");
    assert.ok(posTimeout > corpo.indexOf('BEGIN;'), `${nome}: lock_timeout depois do BEGIN`);
    assert.ok(posTimeout < corpo.indexOf('usuarios'), `${nome}: lock_timeout antes de tocar em usuarios`);
  }
});

test('047 é aditiva: cria agente_equipe e só ACRESCENTA usuarios.acesso_clinica, com padrão TRUE', () => {
  const corpo = semComentarios(SQL);
  assert.match(corpo, /CREATE TABLE IF NOT EXISTS agente_equipe \(/);
  assert.match(corpo, /ALTER TABLE usuarios\s+ADD COLUMN IF NOT EXISTS acesso_clinica boolean NOT NULL DEFAULT true;/);
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(corpo), '047 não remove tabela nem coluna');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(corpo));
  assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(corpo), '047 não altera linha existente');
  assert.ok(!/\bTRUNCATE\s+(TABLE\s+)?\w+\s*;/i.test(corpo));
});

test('agente_equipe: chave (agente, usuário), CASCADE nas duas FKs e índice por usuário', () => {
  const bloco = SQL.match(/CREATE TABLE IF NOT EXISTS agente_equipe \(([\s\S]*?)\n\);/)[1];
  assert.match(bloco, /agente_id\s+bigint NOT NULL REFERENCES agentes\(id\) ON DELETE CASCADE/);
  assert.match(bloco, /usuario_id\s+bigint NOT NULL REFERENCES usuarios\(id\) ON DELETE CASCADE/);
  assert.match(bloco, /criado_por\s+bigint REFERENCES usuarios\(id\) ON DELETE SET NULL/);
  assert.match(bloco, /CONSTRAINT agente_equipe_pk PRIMARY KEY \(agente_id, usuario_id\)/);
  assert.match(SQL, /CREATE INDEX IF NOT EXISTS agente_equipe_usuario_idx ON agente_equipe \(usuario_id\);/);
});

test('só backend e admin mudam acesso_clinica: gatilho próprio, sem reescrever o guard da 008', () => {
  const corpo = semComentarios(SQL);
  assert.match(corpo, /IF NEW\.acesso_clinica IS DISTINCT FROM OLD\.acesso_clinica AND current_user = 'crmclinica_app' THEN\s+IF public\.current_app_role\(\) NOT IN \('backend', 'admin'\) THEN/,
    'vale para a aplicação; o dono das tabelas no SQL Editor não fica travado');
  assert.match(corpo, /SET search_path TO 'public', 'pg_temp'/);
  assert.match(corpo, /CREATE TRIGGER trg_usuarios_acesso_clinica_guard BEFORE UPDATE ON usuarios/);
  assert.ok(!/guard_usuario_sensitive/.test(corpo), 'não mexe no guard da 008, que vive fora do repositório');
});

test('RLS, política só para crmclinica_app, GRANT mínimo sem UPDATE/TRUNCATE, PUBLIC/anon/authenticated revogados', () => {
  const corpo = semComentarios(SQL);
  assert.match(corpo, /ALTER TABLE public\.agente_equipe ENABLE ROW LEVEL SECURITY;/);
  assert.match(corpo, /REVOKE ALL ON public\.agente_equipe FROM PUBLIC;/);
  assert.match(corpo, /CREATE POLICY app_trabalho ON public\.agente_equipe\s+FOR ALL TO crmclinica_app USING \(true\) WITH CHECK \(true\);/);
  const posRevoga = corpo.indexOf('REVOKE ALL ON public.agente_equipe FROM crmclinica_app;');
  const posGrant = corpo.indexOf('GRANT SELECT, INSERT, DELETE ON public.agente_equipe TO crmclinica_app;');
  assert.ok(posRevoga > 0 && posRevoga < posGrant, 'zera o herdado antes do GRANT mínimo');
  assert.match(corpo, /ARRAY\['anon', 'authenticated'\]/);
  const concedidos = [...corpo.matchAll(/GRANT [\s\S]*? TO (\w+)/g)].map((m) => m[1]);
  assert.ok(concedidos.length >= 1 && concedidos.every((role) => role === 'crmclinica_app'), `GRANT para outra role: ${concedidos}`);
  assert.ok(!/GRANT[^;]*(UPDATE|TRUNCATE)[^;]*agente_equipe/.test(corpo));
});

test('rollback recusa com usuário sem acesso à clínica e só então remove coluna, gatilho e tabela', () => {
  const corpo = semComentarios(ROLLBACK);
  assert.match(corpo, /SET LOCAL row_security = off;/);
  const posLock = corpo.indexOf('LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE;');
  const posRecusa = corpo.indexOf('RAISE EXCEPTION');
  assert.ok(posLock > 0 && posLock < posRecusa, 'trava usuarios antes da checagem');
  assert.match(corpo, /SELECT 1 FROM usuarios WHERE acesso_clinica = false/);
  const posDropColuna = corpo.indexOf('ALTER TABLE usuarios DROP COLUMN IF EXISTS acesso_clinica;');
  assert.ok(posDropColuna > posRecusa, 'a recusa vem antes de apagar a coluna');
  assert.ok(corpo.indexOf('DROP TRIGGER IF EXISTS trg_usuarios_acesso_clinica_guard ON usuarios;') < posDropColuna);
  assert.match(corpo, /DROP FUNCTION IF EXISTS public\.guard_usuario_acesso_clinica\(\);/);
  assert.match(corpo, /DROP TABLE IF EXISTS agente_equipe;/);
});

test('verificar-banco cobra a 047: tabela, coluna, RLS, política, grants, FKs em cascata e o gatilho', () => {
  const verificador = fs.readFileSync(path.join(RAIZ, 'bin', 'verificar-banco.js'), 'utf8');
  assert.match(verificador, /'047_equipe_de_agentes': \{/);
  assert.match(verificador, /\['usuarios', 'acesso_clinica'\]/);
  assert.ok(verificador.includes("'agente_equipe'"), 'agente_equipe na lista de RLS');
  assert.match(verificador, /trg_usuarios_acesso_clinica_guard/);
  assert.match(verificador, /confdeltype === 'c'/);
});
