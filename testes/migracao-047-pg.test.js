'use strict';

// Migration 047 contra PostgreSQL REAL, como a aplicação a usa (auditoria de
// acesso sobre 42939cf: migracao-047.test.js é só textual). Prova privilégios
// mínimos, RLS, FKs em cascata e o gatilho de `usuarios.acesso_clinica` com
// `SET LOCAL ROLE crmclinica_app` — cada tentativa dentro de uma transação
// desfeita no fim.
//
// Só roda por `npm run test:pg`, num banco descartável com as migrations
// aplicadas. Sem CRMCLINICA_TEST_DATABASE_URL o caso fica SKIPPED, visível no
// contador — nunca "passa vazio".

const test = require('node:test');
const assert = require('node:assert/strict');

const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';
const SEM_BANCO = URL_DE_TESTE
  ? false
  : 'exige PostgreSQL real — rode por `npm run test:pg` com CRMCLINICA_TEST_DATABASE_URL';

test('[pg] 047: privilégios mínimos, RLS, FKs em cascata e gatilho de acesso_clinica como crmclinica_app', { skip: SEM_BANCO }, async (t) => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: URL_DE_TESTE });
  await db.connect();
  t.after(() => db.end());
  const erroDe = async (sql, valores) => {
    try { await db.query(sql, valores); return null; } catch (erro) { return erro; }
  };

  const { rows: [papel] } = await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'crmclinica_app'");
  assert.equal(papel.n, 1, 'o banco de teste precisa da role crmclinica_app (migrations aplicadas)');

  // ------------------------------------------------ forma, RLS e privilégios
  const { rows: [forma] } = await db.query(`
    SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.agente_equipe'::regclass) AS rls,
           (SELECT count(*)::int FROM pg_policies WHERE tablename = 'agente_equipe' AND policyname = 'app_trabalho') AS politicas,
           (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.usuarios'::regclass
              AND tgname = 'trg_usuarios_acesso_clinica_guard' AND tgenabled <> 'D') AS gatilhos,
           has_table_privilege('crmclinica_app', 'public.agente_equipe', 'SELECT') AS le,
           has_table_privilege('crmclinica_app', 'public.agente_equipe', 'INSERT') AS insere,
           has_table_privilege('crmclinica_app', 'public.agente_equipe', 'DELETE') AS apaga,
           has_table_privilege('crmclinica_app', 'public.agente_equipe', 'UPDATE') AS atualiza,
           has_table_privilege('crmclinica_app', 'public.agente_equipe', 'TRUNCATE') AS trunca,
           has_table_privilege('anon', 'public.agente_equipe', 'SELECT') AS anon,
           has_table_privilege('authenticated', 'public.agente_equipe', 'SELECT') AS autenticado
  `);
  assert.equal(forma.rls, true, 'RLS ligada em agente_equipe');
  assert.equal(forma.politicas, 1, 'política app_trabalho');
  assert.equal(forma.gatilhos, 1, 'gatilho de acesso_clinica ligado');
  assert.ok(forma.le && forma.insere && forma.apaga, 'a aplicação lê, insere e apaga vínculo');
  assert.ok(!forma.atualiza && !forma.trunca, 'sem UPDATE e sem TRUNCATE (TRUNCATE ignora o RLS)');
  assert.ok(!forma.anon && !forma.autenticado, 'anon e authenticated sem acesso');

  // ------------------------------------------------------------ FKs em cascata
  const sufixo = `${process.pid}-${Date.now()}`;
  const { rows: [agente] } = await db.query('INSERT INTO agentes (slug, nome) VALUES ($1, $2) RETURNING id', [`pg-047-${sufixo}`, 'Agente PG 047']);
  const { rows: [usuario] } = await db.query(
    "INSERT INTO usuarios (nome, email, papel, situacao) VALUES ('Loja PG 047', $1, 'atendente', 'ativo') RETURNING id, acesso_clinica, recebe_resumo",
    [`loja-pg-047-${sufixo}@teste.local`],
  );
  assert.equal(usuario.acesso_clinica, true, 'padrão da coluna: vê a clínica');
  assert.equal(usuario.recebe_resumo, true, 'padrão da coluna: recebe resumo');
  await db.query('INSERT INTO agente_equipe (agente_id, usuario_id) VALUES ($1, $2)', [agente.id, usuario.id]);
  const duplicado = await erroDe('INSERT INTO agente_equipe (agente_id, usuario_id) VALUES ($1, $2)', [agente.id, usuario.id]);
  assert.equal(duplicado?.code, '23505', 'o mesmo vínculo não entra duas vezes');
  const orfao = await erroDe('INSERT INTO agente_equipe (agente_id, usuario_id) VALUES ($1, 999999999)', [agente.id]);
  assert.equal(orfao?.code, '23503', 'vínculo com usuário inexistente não entra');
  await db.query('DELETE FROM agentes WHERE id = $1', [agente.id]);
  const { rows: [sobra] } = await db.query('SELECT count(*)::int AS n FROM agente_equipe WHERE agente_id = $1', [agente.id]);
  assert.equal(sobra.n, 0, 'apagar o agente leva só o vínculo');

  // ------------------------------------------ gatilho, como a aplicação escreve
  // As políticas crm008_* de usuarios vivem fora do Git: dentro da transação da
  // prova, RLS desligada e UPDATE concedido só para o gatilho ser exercitado.
  // ROLLBACK desfaz tudo, inclusive o GRANT.
  async function tentarComoApp(claim, sql = 'UPDATE usuarios SET acesso_clinica = false WHERE id = $1') {
    await db.query('BEGIN');
    try {
      await db.query('ALTER TABLE usuarios DISABLE ROW LEVEL SECURITY');
      await db.query('GRANT SELECT, UPDATE ON usuarios TO crmclinica_app');
      await db.query('SET LOCAL ROLE crmclinica_app');
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ app_role: claim })]);
      return await erroDe(sql, [usuario.id]);
    } finally {
      await db.query('ROLLBACK');
    }
  }
  for (const claim of ['atendente', 'gestor', 'deny']) {
    const erro = await tentarComoApp(claim);
    assert.match(erro?.message ?? 'mudou', /só pode ser alterado por administrador/, `claim ${claim} não muda a marca`);
  }
  for (const claim of ['admin', 'backend']) {
    assert.equal(await tentarComoApp(claim), null, `claim ${claim} muda a marca`);
  }
  assert.equal(await tentarComoApp('atendente', "UPDATE usuarios SET nome = 'Loja PG 047 renomeada' WHERE id = $1"), null,
    'o gatilho só olha a marca');
  assert.equal(await erroDe('UPDATE usuarios SET acesso_clinica = false WHERE id = $1', [usuario.id]), null,
    'dono das tabelas, sem claim (SQL Editor), muda a marca');
  await db.query('DELETE FROM usuarios WHERE id = $1', [usuario.id]);
});
