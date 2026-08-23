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

