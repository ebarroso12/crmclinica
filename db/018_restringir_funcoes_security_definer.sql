-- 018 — Fecha a superfície RPC das funções internas SECURITY DEFINER.
--
-- As quatro funções são usadas internamente por triggers, policies e pelo
-- backend conectado como crmclinica_app. Elas não são uma API pública. Em
-- PostgreSQL, funções novas recebem EXECUTE para PUBLIC por padrão, o que as
-- expunha por /rest/v1/rpc apesar de o produto não ter rota para isso.

BEGIN;

REVOKE ALL ON FUNCTION public.audit_user_changes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_usuario_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_admin_master() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_colaborador() FROM PUBLIC, anon, authenticated;

-- Policies e triggers continuam a resolver as funções; o backend conserva
-- apenas o mínimo necessário para as consultas que avaliam RBAC no banco.
GRANT EXECUTE ON FUNCTION public.current_usuario_id() TO crmclinica_app;
GRANT EXECUTE ON FUNCTION public.is_admin_master() TO crmclinica_app;
GRANT EXECUTE ON FUNCTION public.is_colaborador() TO crmclinica_app;

COMMIT;

-- Verificação pós-aplicação (somente leitura):
-- SELECT has_function_privilege('anon', 'public.audit_user_changes()', 'EXECUTE');
-- SELECT has_function_privilege('authenticated', 'public.current_usuario_id()', 'EXECUTE');
-- SELECT has_function_privilege('crmclinica_app', 'public.is_colaborador()', 'EXECUTE');
