-- 036 — Reconstrução versionada das 13 policies `restrict_*`, encontradas em
-- produção durante esta investigação. NÃO fazem parte de
-- `008_crmclinica_security_hardening` nem `009_storage_privilege_revoke` —
-- db/010 (já commitada) só nomeia essas duas migrations desconhecidas; estas
-- 13 policies têm nome, papel e ROLE-ALVO diferentes de tudo que 008
-- documentadamente criou, e por isso ganham um número próprio em vez de
-- entrar em 034.
--
-- ORIGEM DESCONHECIDA COM PRECISÃO: podem ser de uma migration anterior a
-- 008 (possivelmente da configuração inicial do projeto Supabase, antes
-- deste repositório existir), ou de uma migration paralela nunca
-- referenciada em nenhum comentário deste repositório. Marcado aqui como
-- BLOQUEIO ao invés de inventado: não há como saber o nome/número original
-- sem acesso a `supabase_migrations.schema_migrations` (fora do escopo
-- autorizado desta tarefa — só catálogo estrutural, não histórico de
-- migrations do painel).
--
-- MÉTODO: mesmo de 034 — `pg_get_functiondef`/`pg_policies`, extraído em
-- 2026-08-14, SQL gerado mecanicamente a partir do JSON da extração.
--
-- POR QUE ESTAS 13 POLICIES SÃO INERTES HOJE (comprovado, não suposto):
--
--   1. Todas são `AS RESTRICTIVE`, role-alvo `{authenticated}` — NUNCA
--      `crmclinica_app`. RESTRICTIVE só ESTREITA o que uma policy PERMISSIVE
--      já teria liberado para a MESMA role; não concede nada sozinha.
--   2. `db/007_hardening.sql`, linha 290 (já commitada, aplicada):
--      `REVOKE USAGE ON SCHEMA public FROM anon, authenticated`. Sem USAGE
--      no schema, a role `authenticated` não alcança nenhuma tabela de
--      `public` — a policy nunca chega a ser avaliada, porque a checagem de
--      privilégio de schema vem antes do RLS.
--   3. `SELECT rolbypassrls FROM pg_roles WHERE rolname='crmclinica_app'`
--      devolve `false` (RLS é avaliado para ela) e a conexão desta sessão,
--      via `CRMCLINICA_DATABASE_URL`, confirmou `current_user='crmclinica_app'`
--      — ou seja, o backend de fato conecta pela role que as policies
--      `crm008_*` (db/034) protegem, não pela `authenticated` que estas 13
--      protegem.
--
--   Conclusão: hoje, para o tráfego real do produto (sempre via o backend
--   Node, sempre como `crmclinica_app`), estas 13 policies não fazem
--   diferença nenhuma — nem para mais, nem para menos. Elas só importariam
--   se algo algum dia consultasse o Supabase DIRETAMENTE via PostgREST com
--   uma sessão de Supabase Auth (`authenticated`) — caminho que este
--   repositório não usa em lugar nenhum do código atual (`grep` por
--   `auth.jwt\(\)`, `supabase-js` ou chamadas diretas a `/rest/v1/` no
--   frontend não encontrou nenhuma — o front fala só com `/api/*` do próprio
--   backend). Reconstruídas aqui por completude e para não perder a
--   informação, não porque protegem algo hoje.
--
-- Aplicar depois de 034 (usa is_admin_master/is_colaborador, criadas lá) E
-- depois de 011 (`serena_configuracao`/`serena_prompts`/`serena_regras` só
-- existem a partir de `db/011_serena.sql`) — COMPROVADO por validação real
-- contra banco descartável nesta sessão: aplicar 036 logo após 034/035, antes
-- de 011, falha em "relation public.serena_configuracao does not exist".
-- Mesma nota de ordem funcional de 034: numericamente vem depois de 018, mas
-- nada em 010-033 depende de 036 existir — só 034 tem essa dependência (dela
-- própria vir antes de 018), documentada no cabeçalho de 034.

BEGIN;

-- ---- audit_log
DROP POLICY IF EXISTS restrict_audit_admin_only ON public.audit_log;
CREATE POLICY restrict_audit_admin_only ON public.audit_log AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- conversas
DROP POLICY IF EXISTS restrict_conversas_active_team ON public.conversas;
CREATE POLICY restrict_conversas_active_team ON public.conversas AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)))
  WITH CHECK ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)));

-- ---- mensagens
DROP POLICY IF EXISTS restrict_mensagens_active_team ON public.mensagens;
CREATE POLICY restrict_mensagens_active_team ON public.mensagens AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)));
DROP POLICY IF EXISTS restrict_mensagens_delete_admin ON public.mensagens;
CREATE POLICY restrict_mensagens_delete_admin ON public.mensagens AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master));
DROP POLICY IF EXISTS restrict_mensagens_update_team ON public.mensagens;
CREATE POLICY restrict_mensagens_update_team ON public.mensagens AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)))
  WITH CHECK ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)));
DROP POLICY IF EXISTS restrict_mensagens_write_team ON public.mensagens;
CREATE POLICY restrict_mensagens_write_team ON public.mensagens AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT is_admin_master() AS is_admin_master) OR ( SELECT is_colaborador() AS is_colaborador)));

-- ---- recuperacoes_senha
DROP POLICY IF EXISTS restrict_recuperacoes_admin_only ON public.recuperacoes_senha;
CREATE POLICY restrict_recuperacoes_admin_only ON public.recuperacoes_senha AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- serena_configuracao
DROP POLICY IF EXISTS restrict_serena_config_admin_only ON public.serena_configuracao;
CREATE POLICY restrict_serena_config_admin_only ON public.serena_configuracao AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- serena_prompts
DROP POLICY IF EXISTS restrict_serena_prompts_admin_only ON public.serena_prompts;
CREATE POLICY restrict_serena_prompts_admin_only ON public.serena_prompts AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- serena_regras
DROP POLICY IF EXISTS restrict_serena_regras_admin_only ON public.serena_regras;
CREATE POLICY restrict_serena_regras_admin_only ON public.serena_regras AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- sessoes
DROP POLICY IF EXISTS restrict_sessoes_admin_only ON public.sessoes;
CREATE POLICY restrict_sessoes_admin_only ON public.sessoes AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- tentativas_autenticacao
DROP POLICY IF EXISTS restrict_tentativas_admin_only ON public.tentativas_autenticacao;
CREATE POLICY restrict_tentativas_admin_only ON public.tentativas_autenticacao AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

-- ---- usuarios
DROP POLICY IF EXISTS restrict_usuarios_admin_only ON public.usuarios;
CREATE POLICY restrict_usuarios_admin_only ON public.usuarios AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT is_admin_master() AS is_admin_master))
  WITH CHECK (( SELECT is_admin_master() AS is_admin_master));

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT count(*) FROM pg_policies WHERE policyname LIKE 'restrict_%';
--   -- esperado: 13
--
-- Rollback: db/036_reconstrucao_policies_restrict_legado_rollback.sql
