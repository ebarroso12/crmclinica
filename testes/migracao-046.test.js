'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const regras = require('../src/dominio/agentes/regras');

// Guardas textuais da migration 046 (agentes). Isto prova a FORMA do SQL e a
// coerência com as regras da aplicação — NÃO prova que o SQL roda: isso só
// `npm run test:pg` contra um PostgreSQL descartável com a 046 aplicada, e
// `npm run verificar-banco` depois de aplicar no Supabase.

const RAIZ = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(RAIZ, 'db', '046_agentes.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(RAIZ, 'db', '046_agentes_rollback.sql'), 'utf8');
const semComentarios = (texto) => texto.replace(/--.*$/gm, '');

const TABELAS = ['agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais'];

function listaSql(valores) {
  return `IN (${valores.map((valor) => `'${valor}'`).join(', ')})`;
}

test('046 é atômica: um BEGIN e um COMMIT', () => {
  assert.equal((SQL.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((SQL.match(/^COMMIT;/gm) ?? []).length, 1);
  assert.equal((ROLLBACK.match(/^BEGIN;/gm) ?? []).length, 1);
  assert.equal((ROLLBACK.match(/^COMMIT;/gm) ?? []).length, 1);
});

test('046 é aditiva: cria as cinco tabelas e só ACRESCENTA conversas.agente_id', () => {
  const corpo = semComentarios(SQL);
  for (const tabela of TABELAS) {
    assert.match(corpo, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\(`), `falta ${tabela}`);
  }
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(corpo), '046 não remove tabela nem coluna');
  assert.ok(!/\bTRUNCATE\b/i.test(corpo));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(corpo));
  assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(corpo), '046 não altera linha existente');
  assert.match(corpo, /ALTER TABLE conversas\s+ADD COLUMN IF NOT EXISTS agente_id bigint REFERENCES agentes\(id\) ON DELETE RESTRICT/);
});

test('conversas.agente_id é RESTRICT — apagar agente nunca devolve conversas à clínica', () => {
  const corpo = semComentarios(SQL);
  assert.ok(!/agente_id bigint REFERENCES agentes\(id\) ON DELETE SET NULL/.test(corpo));
  assert.match(corpo, /conversas_agente_idx\s+ON conversas \(agente_id\) WHERE agente_id IS NOT NULL/);
});

test('RLS ligada, política só para crmclinica_app, GRANT só para crmclinica_app, anon/authenticated revogados — nas cinco tabelas', () => {
  const arrays = [...SQL.matchAll(/FOREACH t IN ARRAY ARRAY\[([^\]]+)\]/g)].map((m) => m[1].replace(/['\s]/g, '').split(','));
  assert.equal(arrays.length, 2, 'um laço de RLS/GRANT e um de REVOKE');
  for (const lista of arrays) assert.deepEqual([...lista].sort(), [...TABELAS].sort());

  assert.match(SQL, /ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL, /CREATE POLICY app_trabalho ON public\.%I\s+FOR ALL TO crmclinica_app/);
  assert.match(SQL, /pg_roles WHERE rolname = 'crmclinica_app'/);
  assert.match(SQL, /ARRAY\['anon', 'authenticated'\]/);
  assert.match(SQL, /REVOKE ALL ON public\.%I FROM %I/);
  const concedidos = [...semComentarios(SQL).matchAll(/GRANT [\s\S]*? TO (\w+)/g)].map((m) => m[1]);
  assert.ok(concedidos.length >= 2);
  assert.ok(concedidos.every((role) => role === 'crmclinica_app'), `GRANT para outra role: ${concedidos}`);
});

test('enumerações do SQL são exatamente as de src/dominio/agentes/regras.js', () => {
  assert.ok(SQL.includes(`status IN ${listaSql(regras.STATUS_AGENTE).slice(3)}`));
  assert.ok(SQL.includes(`comunicacao ${listaSql(regras.COMUNICACOES)}`));
  assert.ok(SQL.includes(`finalidade ${listaSql(regras.FINALIDADES)}`));
  assert.ok(SQL.includes(`tipo ${listaSql(regras.TIPOS_TREINAMENTO)}`));
  assert.ok(SQL.includes(`acao ${listaSql(regras.ACOES_INATIVIDADE)}`));
  assert.ok(SQL.includes(`canal ${listaSql(regras.CANAIS_AGENTE)}`));
});

test('limites do SQL batem com os limites da validação da aplicação', () => {
  const { LIMITES } = regras;
  const esperados = [
    `char_length(nome) BETWEEN 1 AND ${LIMITES.nome}`,
    `char_length(descricao) <= ${LIMITES.descricao}`,
    `char_length(comportamento) <= ${LIMITES.comportamento}`,
    `char_length(empresa_nome) <= ${LIMITES.empresaNome}`,
    `char_length(empresa_site) <= ${LIMITES.empresaSite}`,
    `char_length(empresa_descricao) <= ${LIMITES.empresaDescricao}`,
    `char_length(provedor) <= ${LIMITES.provedor}`,
    `char_length(modelo) <= ${LIMITES.modelo}`,
    `char_length(titulo) <= ${LIMITES.tituloTreinamento}`,
    `char_length(conteudo) BETWEEN 1 AND ${LIMITES.conteudoTreinamento}`,
    `char_length(origem) <= ${LIMITES.origemTreinamento}`,
    `char_length(instrucao) <= ${LIMITES.instrucaoInatividade}`,
    `apos_minutos BETWEEN 1 AND ${LIMITES.minutosInatividade}`,
    `char_length(instancia) BETWEEN 1 AND ${LIMITES.instancia}`,
  ];
  for (const trecho of esperados) assert.ok(SQL.includes(trecho), `falta no SQL: ${trecho}`);
});

test('unicidades que o repositório e o verificar-banco esperam existem com o nome certo', () => {
  assert.match(SQL, /CONSTRAINT agentes_slug_uk UNIQUE/);
  assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS agente_canais_instancia_uk\s+ON agente_canais \(canal, lower\(instancia\)\)/);
  assert.match(SQL, /CONSTRAINT agente_acoes_inatividade_minutos_uk UNIQUE \(agente_id, apos_minutos\)/);

  const verificador = fs.readFileSync(path.join(RAIZ, 'bin', 'verificar-banco.js'), 'utf8');
  assert.match(verificador, /\['agentes', 'agentes_slug_uk'/);
  for (const tabela of TABELAS) assert.ok(verificador.includes(`'${tabela}'`), `verificar-banco não cobra RLS de ${tabela}`);
});

test('toda coluna que o repositório grava existe na migration', () => {
  const repositorio = fs.readFileSync(path.join(RAIZ, 'src', 'dados', 'repositorio.js'), 'utf8');
  const colunasDoAgente = repositorio.match(/const COLUNAS_DO_AGENTE = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .replace(/['\s]/g, '').split(',').filter(Boolean);
  const blocoAgentes = SQL.match(/CREATE TABLE IF NOT EXISTS agentes \(([\s\S]*?)\n\);/)[1];
  for (const coluna of [...colunasDoAgente, 'configuracoes', 'criado_em', 'atualizado_em']) {
    assert.match(blocoAgentes, new RegExp(`^\\s+${coluna}\\s`, 'm'), `agentes.${coluna} ausente`);
  }

  const inserts = [
    ['agente_comportamentos', ['agente_id', 'comportamento', 'criado_por']],
    ['agente_treinamentos', ['agente_id', 'tipo', 'titulo', 'conteudo', 'origem', 'status']],
    ['agente_acoes_inatividade', ['agente_id', 'apos_minutos', 'acao', 'instrucao', 'ordem']],
    ['agente_canais', ['agente_id', 'canal', 'instancia', 'ativo']],
  ];
  for (const [tabela, colunas] of inserts) {
    assert.ok(repositorio.includes(`INSERT INTO ${tabela} (${colunas.join(', ')})`), `repositório mudou o INSERT de ${tabela}`);
    const bloco = SQL.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tabela} \\(([\\s\\S]*?)\\n\\);`))[1];
    for (const coluna of colunas) assert.match(bloco, new RegExp(`^\\s+${coluna}\\s`, 'm'), `${tabela}.${coluna} ausente`);
  }
});

test('rollback recusa rodar com conversa de agente e só então remove coluna e tabelas', () => {
  const corpo = semComentarios(ROLLBACK);
  const posRecusa = corpo.indexOf('RAISE EXCEPTION');
  const posDropColuna = corpo.indexOf('DROP COLUMN IF EXISTS agente_id');
  assert.ok(posRecusa > 0, 'rollback precisa recusar quando existe conversa de agente');
  assert.match(corpo, /SELECT 1 FROM conversas WHERE agente_id IS NOT NULL/);
  assert.ok(posDropColuna > posRecusa, 'a recusa vem antes de apagar a coluna');
  for (const tabela of TABELAS) assert.match(corpo, new RegExp(`DROP TABLE IF EXISTS ${tabela};`));
  assert.ok(corpo.indexOf('DROP TABLE IF EXISTS agentes;') > posDropColuna, 'a coluna com FK sai antes da tabela agentes');
});
