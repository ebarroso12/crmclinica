-- ---- agenda_bloqueios
DROP POLICY IF EXISTS crm008_b_s ON public.agenda_bloqueios;
CREATE POLICY crm008_b_s ON public.agenda_bloqueios
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR is_atendente()));
DROP POLICY IF EXISTS crm008_b_w ON public.agenda_bloqueios;
CREATE POLICY crm008_b_w ON public.agenda_bloqueios
  FOR ALL
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- agendamentos
DROP POLICY IF EXISTS crm008_a_d ON public.agendamentos;
CREATE POLICY crm008_a_d ON public.agendamentos
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_a_i ON public.agendamentos;
CREATE POLICY crm008_a_i ON public.agendamentos
  FOR INSERT
  TO crmclinica_app
  WITH CHECK (can_access_agendamento(profissional_id, conversa_id));
DROP POLICY IF EXISTS crm008_a_s ON public.agendamentos;
CREATE POLICY crm008_a_s ON public.agendamentos
  FOR SELECT
  TO crmclinica_app
  USING (can_access_agendamento(profissional_id, conversa_id));
DROP POLICY IF EXISTS crm008_a_u ON public.agendamentos;
CREATE POLICY crm008_a_u ON public.agendamentos
  FOR UPDATE
  TO crmclinica_app
  USING (can_access_agendamento(profissional_id, conversa_id))
  WITH CHECK (can_access_agendamento(profissional_id, conversa_id));

-- ---- audit_log
DROP POLICY IF EXISTS crm008_al_i ON public.audit_log;
CREATE POLICY crm008_al_i ON public.audit_log
  FOR INSERT
  TO crmclinica_app
  WITH CHECK (is_backend());
DROP POLICY IF EXISTS crm008_al_s ON public.audit_log;
CREATE POLICY crm008_al_s ON public.audit_log
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));

-- ---- contatos
DROP POLICY IF EXISTS crm008_c_d ON public.contatos;
CREATE POLICY crm008_c_d ON public.contatos
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_c_i ON public.contatos;
CREATE POLICY crm008_c_i ON public.contatos
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR is_atendente()));
DROP POLICY IF EXISTS crm008_c_s ON public.contatos;
CREATE POLICY crm008_c_s ON public.contatos
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR (EXISTS ( SELECT 1
   FROM conversas c
  WHERE ((c.contato_id = contatos.id) AND ((c.atribuido_a IS NULL) OR (c.atribuido_a = current_usuario_id())))))));
DROP POLICY IF EXISTS crm008_c_u ON public.contatos;
CREATE POLICY crm008_c_u ON public.contatos
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR (EXISTS ( SELECT 1
   FROM conversas c
  WHERE ((c.contato_id = contatos.id) AND ((c.atribuido_a IS NULL) OR (c.atribuido_a = current_usuario_id())))))))
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR (EXISTS ( SELECT 1
   FROM conversas c
  WHERE ((c.contato_id = contatos.id) AND ((c.atribuido_a IS NULL) OR (c.atribuido_a = current_usuario_id())))))));

-- ---- conversa_etiquetas
DROP POLICY IF EXISTS crm008_ce_d ON public.conversa_etiquetas;
CREATE POLICY crm008_ce_d ON public.conversa_etiquetas
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_ce_i ON public.conversa_etiquetas;
CREATE POLICY crm008_ce_i ON public.conversa_etiquetas
  FOR INSERT
  TO crmclinica_app
  WITH CHECK (can_access_conversa(conversa_id));
DROP POLICY IF EXISTS crm008_ce_s ON public.conversa_etiquetas;
CREATE POLICY crm008_ce_s ON public.conversa_etiquetas
  FOR SELECT
  TO crmclinica_app
  USING (can_access_conversa(conversa_id));
DROP POLICY IF EXISTS crm008_ce_u ON public.conversa_etiquetas;
CREATE POLICY crm008_ce_u ON public.conversa_etiquetas
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- conversas
DROP POLICY IF EXISTS crm008_v_d ON public.conversas;
CREATE POLICY crm008_v_d ON public.conversas
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_v_i ON public.conversas;
CREATE POLICY crm008_v_i ON public.conversas
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR (is_atendente() AND ((atribuido_a IS NULL) OR (atribuido_a = current_usuario_id())))));
DROP POLICY IF EXISTS crm008_v_s ON public.conversas;
CREATE POLICY crm008_v_s ON public.conversas
  FOR SELECT
  TO crmclinica_app
  USING (can_access_conversa(id));
DROP POLICY IF EXISTS crm008_v_u ON public.conversas;
CREATE POLICY crm008_v_u ON public.conversas
  FOR UPDATE
  TO crmclinica_app
  USING (can_access_conversa(id))
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR (is_atendente() AND ((atribuido_a IS NULL) OR (atribuido_a = current_usuario_id())))));

-- ---- disponibilidades
DROP POLICY IF EXISTS crm008_d_s ON public.disponibilidades;
CREATE POLICY crm008_d_s ON public.disponibilidades
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR is_atendente()));
DROP POLICY IF EXISTS crm008_d_w ON public.disponibilidades;
CREATE POLICY crm008_d_w ON public.disponibilidades
  FOR ALL
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- etiquetas
DROP POLICY IF EXISTS crm008_e_s ON public.etiquetas;
CREATE POLICY crm008_e_s ON public.etiquetas
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR is_atendente()));
DROP POLICY IF EXISTS crm008_e_w ON public.etiquetas;
CREATE POLICY crm008_e_w ON public.etiquetas
  FOR ALL
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- eventos_recebidos
DROP POLICY IF EXISTS crm008_er ON public.eventos_recebidos;
CREATE POLICY crm008_er ON public.eventos_recebidos
  FOR ALL
  TO crmclinica_app
  USING (is_backend())
  WITH CHECK (is_backend());

-- ---- lead_eventos
DROP POLICY IF EXISTS crm008_le_d ON public.lead_eventos;
CREATE POLICY crm008_le_d ON public.lead_eventos
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_le_i ON public.lead_eventos;
CREATE POLICY crm008_le_i ON public.lead_eventos
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)));
DROP POLICY IF EXISTS crm008_le_s ON public.lead_eventos;
CREATE POLICY crm008_le_s ON public.lead_eventos
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)));
DROP POLICY IF EXISTS crm008_le_u ON public.lead_eventos;
CREATE POLICY crm008_le_u ON public.lead_eventos
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- leads
DROP POLICY IF EXISTS crm008_l_d ON public.leads;
CREATE POLICY crm008_l_d ON public.leads
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_l_i ON public.leads;
CREATE POLICY crm008_l_i ON public.leads
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)));
DROP POLICY IF EXISTS crm008_l_s ON public.leads;
CREATE POLICY crm008_l_s ON public.leads
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)));
DROP POLICY IF EXISTS crm008_l_u ON public.leads;
CREATE POLICY crm008_l_u ON public.leads
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)))
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR can_access_conversa(conversa_id)));

-- ---- mensagens
DROP POLICY IF EXISTS crm008_m_d ON public.mensagens;
CREATE POLICY crm008_m_d ON public.mensagens
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_m_i ON public.mensagens;
CREATE POLICY crm008_m_i ON public.mensagens
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR (can_access_conversa(conversa_id) AND (direcao = 'saida'::text) AND (autor_tipo = 'equipe'::text) AND (privada = false))));
DROP POLICY IF EXISTS crm008_m_s ON public.mensagens;
CREATE POLICY crm008_m_s ON public.mensagens
  FOR SELECT
  TO crmclinica_app
  USING (can_access_conversa(conversa_id));
DROP POLICY IF EXISTS crm008_m_u ON public.mensagens;
CREATE POLICY crm008_m_u ON public.mensagens
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- notas_internas
DROP POLICY IF EXISTS crm008_n_d ON public.notas_internas;
CREATE POLICY crm008_n_d ON public.notas_internas
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()));
DROP POLICY IF EXISTS crm008_n_i ON public.notas_internas;
CREATE POLICY crm008_n_i ON public.notas_internas
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR ((usuario_id = current_usuario_id()) AND (EXISTS ( SELECT 1
   FROM conversas c
  WHERE ((c.contato_id = notas_internas.contato_id) AND ((c.atribuido_a IS NULL) OR (c.atribuido_a = current_usuario_id()))))))));
DROP POLICY IF EXISTS crm008_n_s ON public.notas_internas;
CREATE POLICY crm008_n_s ON public.notas_internas
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR (EXISTS ( SELECT 1
   FROM conversas c
  WHERE ((c.contato_id = notas_internas.contato_id) AND ((c.atribuido_a IS NULL) OR (c.atribuido_a = current_usuario_id())))))));
DROP POLICY IF EXISTS crm008_n_u ON public.notas_internas;
CREATE POLICY crm008_n_u ON public.notas_internas
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR (usuario_id = current_usuario_id())))
  WITH CHECK ((is_backend() OR is_gestor_or_admin() OR (usuario_id = current_usuario_id())));

-- ---- profissionais
DROP POLICY IF EXISTS crm008_p_s ON public.profissionais;
CREATE POLICY crm008_p_s ON public.profissionais
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR is_atendente()));
DROP POLICY IF EXISTS crm008_p_w ON public.profissionais;
CREATE POLICY crm008_p_w ON public.profissionais
  FOR ALL
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin()))
  WITH CHECK ((is_backend() OR is_gestor_or_admin()));

-- ---- recuperacoes_senha
DROP POLICY IF EXISTS crm008_rs ON public.recuperacoes_senha;
CREATE POLICY crm008_rs ON public.recuperacoes_senha
  FOR ALL
  TO crmclinica_app
  USING (is_backend())
  WITH CHECK (is_backend());

-- ---- sessoes
DROP POLICY IF EXISTS crm008_se_d ON public.sessoes;
CREATE POLICY crm008_se_d ON public.sessoes
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR (usuario_id = current_usuario_id())));
DROP POLICY IF EXISTS crm008_se_i ON public.sessoes;
CREATE POLICY crm008_se_i ON public.sessoes
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR (usuario_id = current_usuario_id())));
DROP POLICY IF EXISTS crm008_se_s ON public.sessoes;
CREATE POLICY crm008_se_s ON public.sessoes
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR (usuario_id = current_usuario_id())));
DROP POLICY IF EXISTS crm008_se_u ON public.sessoes;
CREATE POLICY crm008_se_u ON public.sessoes
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR (usuario_id = current_usuario_id())))
  WITH CHECK ((is_backend() OR (usuario_id = current_usuario_id())));

-- ---- tentativas_autenticacao
DROP POLICY IF EXISTS crm008_ta ON public.tentativas_autenticacao;
CREATE POLICY crm008_ta ON public.tentativas_autenticacao
  FOR ALL
  TO crmclinica_app
  USING (is_backend())
  WITH CHECK (is_backend());

-- ---- usuarios
DROP POLICY IF EXISTS crm008_u_d ON public.usuarios;
CREATE POLICY crm008_u_d ON public.usuarios
  FOR DELETE
  TO crmclinica_app
  USING ((is_backend() OR is_admin()));
DROP POLICY IF EXISTS crm008_u_i ON public.usuarios;
CREATE POLICY crm008_u_i ON public.usuarios
  FOR INSERT
  TO crmclinica_app
  WITH CHECK ((is_backend() OR is_admin()));
DROP POLICY IF EXISTS crm008_u_s ON public.usuarios;
CREATE POLICY crm008_u_s ON public.usuarios
  FOR SELECT
  TO crmclinica_app
  USING ((is_backend() OR is_gestor_or_admin() OR (id = current_usuario_id())));
DROP POLICY IF EXISTS crm008_u_u ON public.usuarios;
CREATE POLICY crm008_u_u ON public.usuarios
  FOR UPDATE
  TO crmclinica_app
  USING ((is_backend() OR is_admin() OR (id = current_usuario_id())))
  WITH CHECK ((is_backend() OR is_admin() OR (id = current_usuario_id())));

