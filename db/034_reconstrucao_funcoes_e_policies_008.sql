-- 034 — Reconstrução versionada das funções e policies da migration
-- `008_crmclinica_security_hardening`, aplicada em produção FORA do Git
-- (documentado em db/010, linhas 3-8; ver também docs/PLANO-RECONSTRUCAO-008-009.md).
--
-- NÃO REUSA O NÚMERO 008. db/010 já registrou, deliberadamente, por que: o
-- banco tem uma migration "008_crmclinica_security_hardening" real em
-- `supabase_migrations.schema_migrations`, com conteúdo desconhecido em git.
-- Dar o mesmo nome a um arquivo diferente faria duas coisas atenderem pelo
-- mesmo identificador — exatamente o que 010 evitou. Este arquivo é uma
-- RECONSTRUÇÃO, não uma cópia do original: nasce do CATÁLOGO ATUAL do banco,
-- não de nenhum arquivo `.sql` perdido.
--
-- MÉTODO — nada aqui foi digitado de memória ou suposto:
--   1. `ferramentas/extrair-definicoes-008.js` (somente leitura: pg_proc,
--      pg_get_functiondef, pg_policies, information_schema — nunca tabela
--      clínica) rodou contra `CRMCLINICA_DATABASE_URL` em 2026-08-14.
--   2. As definições de função abaixo são `pg_get_functiondef()` textual,
--      sem edição.
--   3. As policies abaixo são geradas mecanicamente de `pg_policies`
--      (schemaname, tablename, policyname, permissive, cmd, roles, qual,
--      with_check) — um script monta o `CREATE POLICY`, ninguém transcreve.
--
-- ORDEM DE APLICAÇÃO — ATENÇÃO, ISTO É UM BLOQUEIO ESTRUTURAL REAL:
--
--   `db/018_restringir_funcoes_security_definer.sql` faz
--   `REVOKE ALL ON FUNCTION public.is_admin_master() FROM ...` e
--   `GRANT EXECUTE ON FUNCTION public.current_usuario_id() TO ...` — comandos
--   que EXIGEM que a função já exista, ou falham com "function does not
--   exist". Numericamente, 018 vem ANTES de 034. Se alguém aplicar `db/`
--   inteiro em ordem numérica estrita, do zero, 018 FALHA porque as funções
--   que ele revoga/concede ainda não existem.
--
--   Isto não é um defeito desta migration — é um defeito de ORDENAÇÃO
--   pré-existente, só agora comprovável porque agora existe uma migration
--   que de fato cria essas funções. A correção aditiva correta (não decidida
--   aqui, decisão do dono) é uma de duas:
--     (a) aplicar 034 IMEDIATAMENTE APÓS 007 e ANTES de continuar para
--         010 em diante (pular numericamente 008-033 na hora de aplicar,
--         não na hora de nomear os arquivos); ou
--     (b) esperar a autorização para RENUMERAR 034 para um número < 018 —
--         o que exigiria decidir se isso conta como "reescrever a história
--         git" dos arquivos já commitados entre 018 e 033 (não conta: nenhum
--         desses arquivos muda de conteúdo, só o índice de 034 mudaria — mas
--         é uma decisão do dono, não uma tomada aqui).
--   `ferramentas/exigir-banco-de-teste.js` e `scripts/*recriar-teste*` desta
--   sessão NÃO aplicam 018 (não está na lista de migrations do banco de
--   teste local) — por isso este bloqueio não aparece nos testes atuais.
--
-- ACHADOS DA COMPARAÇÃO (marcados aqui, não corrigidos — não inventar
-- comportamento novo sem decisão do dono):
--
--   1. A alegação em docs/PLANO-RECONSTRUCAO-008-009.md (seção 2.1) de que
--      `current_usuario_id()` referencia `u.ativo`, "coluna que não existe no
--      esquema versionado", é FALSA. `usuarios.ativo` existe desde
--      db/001_inbox.sql linha 24 (`ativo boolean NOT NULL DEFAULT true`).
--      Não há discrepância nenhuma a decidir aqui — o texto do plano estava
--      errado, e este comentário corrige o registro.
--
--   2. `is_colaborador()` verifica `u.papel IN ('atendente', 'colaborador')`.
--      A CHECK constraint de `usuarios.papel` (db/001, nunca alterada) só
--      permite `('admin', 'gestor', 'atendente')` — `'colaborador'` NUNCA é
--      um valor possível na coluna. O segundo braço do `IN` é morto por
--      construção; `is_colaborador()` equivale, na prática, a
--      `is_atendente()` avaliado por um caminho diferente (ver achado 4).
--
--   3. `is_admin_master()`, `is_colaborador()` e as 13 policies `restrict_*`
--      (ver db/036) formam uma camada LEGADA, de uma geração de RLS anterior
--      à atual: dependem de `current_usuario_id()`, que por sua vez depende
--      de `auth.jwt()->>'email'` — a autenticação NATIVA do Supabase
--      (PostgREST + GoTrue). As 13 `restrict_*` são `AS RESTRICTIVE` e
--      têm `roles={authenticated}` — nunca `crmclinica_app`. Comprovado
--      nesta sessão (consulta a `pg_roles`): `authenticated` teve
--      `REVOKE USAGE ON SCHEMA public` em `db/007_hardening.sql` (linha 290,
--      já commitada). Ou seja: mesmo que uma policy RESTRICTIVE para
--      `authenticated` avaliasse `is_admin_master()` como verdadeiro, a
--      role nem alcança o schema para a policy ser avaliada. **A camada
--      is_admin_master/is_colaborador/restrict_* está INERTE hoje — não
--      é a fronteira de segurança viva do produto.** A fronteira viva é a
--      camada `crm008_*` (53 policies, role `crmclinica_app`, funções
--      `is_backend`/`is_gestor_or_admin`/`is_atendente`/`is_admin`/
--      `current_app_role`), que É reconstruída por este arquivo.
--
--   4. ACHADO MAIS SÉRIO, fora do escopo de correção deste programa (só
--      registro — corrigir exigiria decisão do dono e mudança de
--      comportamento de RLS em produção): `current_usuario_id()` também é
--      usada DENTRO da camada ATIVA (`crm008_*`) — em `can_access_conversa`,
--      `can_access_agendamento`, e diretamente nas policies de `sessoes`,
--      `usuarios`, `notas_internas`, `contatos`, `conversas`. Como
--      `current_usuario_id()` depende de `auth.jwt()->>'email'`, e o backend
--      (`repositorio.js`, `comUsuario()`) declara identidade via
--      `request.jwt.claims = {usuario_id, app_role}` — SEM a chave `email`
--      — `current_usuario_id()` devolve `NULL` para TODA requisição vinda do
--      backend. Toda cláusula de policy do tipo
--      `usuario_id = current_usuario_id()` ou
--      `atribuido_a = current_usuario_id()` nunca casa por essa via; o
--      acesso só passa pelos ramos `is_backend()`/`is_gestor_or_admin()`/
--      `is_admin()`, ou por `atribuido_a IS NULL` (conversa/registro ainda
--      sem dono). Um atendente comum, dono de uma conversa JÁ atribuída a
--      ele, não bate em nenhum ramo dessas policies — nem
--      `is_backend`/`is_gestor_or_admin` (não é), nem
--      `atribuido_a = current_usuario_id()` (NULL nunca compara igual).
--      Verificado por leitura de código (`src/dados/repositorio.js`,
--      `comUsuario`) e por comparação com o texto da função extraída — não
--      testado end-to-end contra produção (fora do escopo autorizado: nenhum
--      teste desta tarefa toca tabela clínica). Registrado aqui para decisão
--      do dono; nenhuma mudança de comportamento foi feita.
--
-- Aplicar depois de 007 (funcionalmente — ver bloqueio de ordem acima).

BEGIN;

-- ============================================================ 1. Funções
--
-- Ordem de criação respeita as dependências internas (current_app_role antes
-- de is_backend/is_gestor_or_admin/is_atendente/is_admin; current_usuario_id
-- e is_backend/is_gestor_or_admin/is_atendente antes de can_access_conversa;
-- can_access_conversa antes de can_access_agendamento).

CREATE OR REPLACE FUNCTION public.current_app_role()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(NULLIF((current_setting('request.jwt.claims',true)::jsonb->>'app_role'),''),
                 'deny')
$function$;

CREATE OR REPLACE FUNCTION public.current_usuario_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select u.id
  from public.usuarios u
  where lower(u.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
    and u.ativo = true
  limit 1
$function$;

CREATE OR REPLACE FUNCTION public.is_backend()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='backend' $function$;

CREATE OR REPLACE FUNCTION public.is_gestor_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role() IN ('gestor','admin') $function$;

CREATE OR REPLACE FUNCTION public.is_atendente()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='atendente' $function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='admin' $function$;

CREATE OR REPLACE FUNCTION public.can_access_conversa(p_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT p_id IS NOT NULL AND (
   public.is_backend() OR public.is_gestor_or_admin() OR EXISTS(
     SELECT 1 FROM public.conversas c WHERE c.id=p_id
     AND (c.atribuido_a IS NULL OR c.atribuido_a=public.current_usuario_id())))
$function$;

CREATE OR REPLACE FUNCTION public.can_access_agendamento(p_prof bigint, p_conv bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.is_backend() OR public.is_gestor_or_admin() OR
 (public.is_atendente() AND (
   public.can_access_conversa(p_conv) OR EXISTS(
     SELECT 1 FROM public.profissionais p
     WHERE p.id=p_prof AND p.usuario_id=public.current_usuario_id())))
$function$;

-- is_admin_master/is_colaborador pertencem à camada LEGADA/INERTE (achado 3
-- acima) — criadas aqui porque db/018 (já commitada) faz REVOKE/GRANT sobre
-- elas e precisa que existam. Não são chamadas por nenhuma policy crm008_*.
CREATE OR REPLACE FUNCTION public.is_admin_master()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.usuarios u
    where u.id = (select public.current_usuario_id())
      and u.ativo = true
      and (
        u.master = true
        or u.papel in ('admin', 'gestor')
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.is_colaborador()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.usuarios u
    where u.id = (select public.current_usuario_id())
      and u.ativo = true
      and u.papel in ('atendente', 'colaborador')
  )
$function$;

-- ============================================================ 2. Policies crm008_*
--
-- 53 policies em 18 tabelas. RLS já está ENABLE/FORCE nessas tabelas desde
-- db/002 e db/007 (conferido: nenhuma tabela desta lista precisa de
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY aqui). `DROP POLICY IF EXISTS`
-- antes de cada `CREATE POLICY` torna o arquivo reaplicável.

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

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT count(*) FROM pg_policies WHERE policyname LIKE 'crm008%';
--   -- esperado: 53
--
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND proname IN (
--      'current_app_role','current_usuario_id','is_backend','is_gestor_or_admin',
--      'is_atendente','is_admin','can_access_conversa','can_access_agendamento',
--      'is_admin_master','is_colaborador');
--   -- esperado: 10 linhas
--
-- Rollback: db/034_reconstrucao_funcoes_e_policies_008_rollback.sql
