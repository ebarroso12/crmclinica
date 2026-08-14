-- Rollback de 034_reconstrucao_funcoes_e_policies_008.sql
--
-- CUIDADO: isto não "desfaz" a migration 008 original de produção — essa
-- migration já está aplicada há muito tempo e este arquivo nunca a tocou.
-- Este rollback só desfaz o que 034 fez NESTA reconstrução: remove as 53
-- policies crm008_* e as 10 funções, deixando as tabelas SEM policy
-- nenhuma para a role crmclinica_app.
--
-- Com RLS ligado (ENABLE ROW LEVEL SECURITY, de db/002/db/007) e ZERO
-- policies para crmclinica_app, o resultado é NEGAR TUDO — a aplicação para
-- de conseguir ler ou escrever qualquer uma destas 18 tabelas. Rodar isto
-- num banco em uso real é um incidente, não uma correção. Só faz sentido
-- num banco descartável de teste, para provar que 034 é reversível.
--
-- db/018 (já commitada) depende de is_admin_master/is_colaborador/
-- current_usuario_id existirem — rodar este rollback ANTES de reverter 018
-- deixaria os GRANT/REVOKE de 018 "soltos" (não quebram, mas passam a
-- apontar para funções inexistentes na próxima vez que 018 for reaplicada).

BEGIN;

-- ---- policies crm008_* (as mesmas 18 tabelas de 034, mesma ordem)
DROP POLICY IF EXISTS crm008_b_s ON public.agenda_bloqueios;
DROP POLICY IF EXISTS crm008_b_w ON public.agenda_bloqueios;

DROP POLICY IF EXISTS crm008_a_d ON public.agendamentos;
DROP POLICY IF EXISTS crm008_a_i ON public.agendamentos;
DROP POLICY IF EXISTS crm008_a_s ON public.agendamentos;
DROP POLICY IF EXISTS crm008_a_u ON public.agendamentos;

DROP POLICY IF EXISTS crm008_al_i ON public.audit_log;
DROP POLICY IF EXISTS crm008_al_s ON public.audit_log;

DROP POLICY IF EXISTS crm008_c_d ON public.contatos;
DROP POLICY IF EXISTS crm008_c_i ON public.contatos;
DROP POLICY IF EXISTS crm008_c_s ON public.contatos;
DROP POLICY IF EXISTS crm008_c_u ON public.contatos;

DROP POLICY IF EXISTS crm008_ce_d ON public.conversa_etiquetas;
DROP POLICY IF EXISTS crm008_ce_i ON public.conversa_etiquetas;
DROP POLICY IF EXISTS crm008_ce_s ON public.conversa_etiquetas;
DROP POLICY IF EXISTS crm008_ce_u ON public.conversa_etiquetas;

DROP POLICY IF EXISTS crm008_v_d ON public.conversas;
DROP POLICY IF EXISTS crm008_v_i ON public.conversas;
DROP POLICY IF EXISTS crm008_v_s ON public.conversas;
DROP POLICY IF EXISTS crm008_v_u ON public.conversas;

DROP POLICY IF EXISTS crm008_d_s ON public.disponibilidades;
DROP POLICY IF EXISTS crm008_d_w ON public.disponibilidades;

DROP POLICY IF EXISTS crm008_e_s ON public.etiquetas;
DROP POLICY IF EXISTS crm008_e_w ON public.etiquetas;

DROP POLICY IF EXISTS crm008_er ON public.eventos_recebidos;

DROP POLICY IF EXISTS crm008_le_d ON public.lead_eventos;
DROP POLICY IF EXISTS crm008_le_i ON public.lead_eventos;
DROP POLICY IF EXISTS crm008_le_s ON public.lead_eventos;
DROP POLICY IF EXISTS crm008_le_u ON public.lead_eventos;

DROP POLICY IF EXISTS crm008_l_d ON public.leads;
DROP POLICY IF EXISTS crm008_l_i ON public.leads;
DROP POLICY IF EXISTS crm008_l_s ON public.leads;
DROP POLICY IF EXISTS crm008_l_u ON public.leads;

DROP POLICY IF EXISTS crm008_m_d ON public.mensagens;
DROP POLICY IF EXISTS crm008_m_i ON public.mensagens;
DROP POLICY IF EXISTS crm008_m_s ON public.mensagens;
DROP POLICY IF EXISTS crm008_m_u ON public.mensagens;

DROP POLICY IF EXISTS crm008_n_d ON public.notas_internas;
DROP POLICY IF EXISTS crm008_n_i ON public.notas_internas;
DROP POLICY IF EXISTS crm008_n_s ON public.notas_internas;
DROP POLICY IF EXISTS crm008_n_u ON public.notas_internas;

DROP POLICY IF EXISTS crm008_p_s ON public.profissionais;
DROP POLICY IF EXISTS crm008_p_w ON public.profissionais;

DROP POLICY IF EXISTS crm008_rs ON public.recuperacoes_senha;

DROP POLICY IF EXISTS crm008_se_d ON public.sessoes;
DROP POLICY IF EXISTS crm008_se_i ON public.sessoes;
DROP POLICY IF EXISTS crm008_se_s ON public.sessoes;
DROP POLICY IF EXISTS crm008_se_u ON public.sessoes;

DROP POLICY IF EXISTS crm008_ta ON public.tentativas_autenticacao;

DROP POLICY IF EXISTS crm008_u_d ON public.usuarios;
DROP POLICY IF EXISTS crm008_u_i ON public.usuarios;
DROP POLICY IF EXISTS crm008_u_s ON public.usuarios;
DROP POLICY IF EXISTS crm008_u_u ON public.usuarios;

-- ---- funções (ordem inversa das dependências)
DROP FUNCTION IF EXISTS public.is_colaborador();
DROP FUNCTION IF EXISTS public.is_admin_master();
DROP FUNCTION IF EXISTS public.can_access_agendamento(bigint, bigint);
DROP FUNCTION IF EXISTS public.can_access_conversa(bigint);
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.is_atendente();
DROP FUNCTION IF EXISTS public.is_gestor_or_admin();
DROP FUNCTION IF EXISTS public.is_backend();
DROP FUNCTION IF EXISTS public.current_usuario_id();
DROP FUNCTION IF EXISTS public.current_app_role();

COMMIT;
