-- Rollback de 036_reconstrucao_policies_restrict_legado.sql
--
-- Remove as 13 policies RESTRICTIVE. Como elas são inertes hoje (ver
-- cabeçalho de 036 — role `authenticated` não tem USAGE no schema public
-- desde db/007), remover não muda o comportamento observável do produto.
-- Ainda assim, cada policy removida é uma camada de defesa a menos SE algum
-- dia `authenticated` recuperar acesso ao schema (ex.: alguém reverter
-- db/007 por engano) — por isso este rollback só deve rodar em banco
-- descartável de teste, para provar reversibilidade, não em produção.

BEGIN;

DROP POLICY IF EXISTS restrict_audit_admin_only ON public.audit_log;
DROP POLICY IF EXISTS restrict_conversas_active_team ON public.conversas;
DROP POLICY IF EXISTS restrict_mensagens_active_team ON public.mensagens;
DROP POLICY IF EXISTS restrict_mensagens_delete_admin ON public.mensagens;
DROP POLICY IF EXISTS restrict_mensagens_update_team ON public.mensagens;
DROP POLICY IF EXISTS restrict_mensagens_write_team ON public.mensagens;
DROP POLICY IF EXISTS restrict_recuperacoes_admin_only ON public.recuperacoes_senha;
DROP POLICY IF EXISTS restrict_serena_config_admin_only ON public.serena_configuracao;
DROP POLICY IF EXISTS restrict_serena_prompts_admin_only ON public.serena_prompts;
DROP POLICY IF EXISTS restrict_serena_regras_admin_only ON public.serena_regras;
DROP POLICY IF EXISTS restrict_sessoes_admin_only ON public.sessoes;
DROP POLICY IF EXISTS restrict_tentativas_admin_only ON public.tentativas_autenticacao;
DROP POLICY IF EXISTS restrict_usuarios_admin_only ON public.usuarios;

COMMIT;
