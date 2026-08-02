-- 007 — Hardening do banco
--
-- Esta migration nasce de uma auditoria que encontrou quatro coisas. Três são
-- correções diretas. A quarta é a que importa, e é a razão de as outras terem
-- parecido piores do que são.
--
-- O ACHADO CENTRAL
--
--   As tabelas pertencem a `postgres`, e é como `postgres` que a aplicação
--   conecta. Essa role tem BYPASSRLS: **o RLS nunca é avaliado para ela**.
--
--   Isso significa que as policies `app_total_*` (USING true) não eram o furo —
--   eram irrelevantes. Reescrevê-las para serem específicas, sem mudar quem
--   conecta, não muda absolutamente nada em runtime.
--
--   A role `crmclinica_app` existia desde a 002, mas com NOLOGIN e sem senha:
--   ninguém nunca conectou por ela. Esta migration a torna utilizável e lhe dá
--   privilégios precisos. O ganho só se materializa quando
--   `CRMCLINICA_DATABASE_URL` passar a apontar para ela — ver README.
--
-- Aplicar depois de 001 a 006.

BEGIN;

-- ---------------------------------------------------------------- 1. Storage
--
-- ESTA MIGRATION NÃO CONSEGUE CORRIGIR O STORAGE. O aviso fica aqui porque o
-- problema é o mais grave que a auditoria encontrou.
--
-- `anon` e `authenticated` têm SELECT, INSERT, UPDATE, DELETE e **TRUNCATE** em
-- storage.objects e storage.buckets, e USAGE no schema storage.
--
-- Para leitura e escrita linha a linha, o RLS segura: está ligado e não há
-- policy nenhuma, e RLS sem policy nega tudo. Mas **TRUNCATE não passa pelo
-- RLS** — é privilégio de tabela, e o RLS não tem o que filtrar quando o
-- comando apaga tudo de uma vez. Verificado neste projeto: com `SET ROLE anon`,
-- o TRUNCATE é aceito.
--
-- Hoje não há dano porque não existe bucket nem objeto. No dia do primeiro
-- upload, qualquer pessoa com a chave anônima — que é pública por definição, vai
-- no front-end — apaga todos os arquivos da clínica com um comando.
--
-- Por que não corrigimos aqui: `storage.objects` pertence a
-- `supabase_storage_admin`. A role `postgres` do Supabase não é superuser e não
-- pode assumir essa role ("role memberships are reserved"). Um REVOKE daqui
-- emite WARNING e não faz nada — o que é pior que não tentar, porque a migration
-- passaria com a aparência de ter resolvido.
--
-- Caminho real: painel do Supabase (SQL Editor conecta com mais privilégio) ou
-- ticket ao suporte, executando:
--
--   REVOKE ALL ON storage.objects, storage.buckets FROM anon, authenticated;
--
-- Sem tocar em s3_multipart_uploads*: são internas do Storage, e mexer nelas
-- quebra upload grande. Elas só têm SELECT, que o RLS já neutraliza.
--
-- `npm run verificar-banco` falha enquanto isso não for feito.

-- ---------------------------------------------------------------- 2. search_path
--
-- Função sem `search_path` fixo resolve nomes pelo caminho de quem a chama. Um
-- schema no caminho com uma tabela `sessoes` faria a limpeza apagar a tabela
-- errada. Com `search_path = ''` nada resolve por acaso — em troca, todo nome
-- dentro da função precisa vir qualificado, e é por isso que elas são recriadas.

CREATE OR REPLACE FUNCTION public.set_atualizado_em() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN NEW.atualizado_em = now(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public.limpar_sessoes_vencidas() RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM public.sessoes
  WHERE expira_em < now() - interval '30 days'
     OR (revogada_em IS NOT NULL AND revogada_em < now() - interval '30 days');
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$;

CREATE OR REPLACE FUNCTION public.limpar_recuperacoes_vencidas() RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM public.recuperacoes_senha
  WHERE expira_em < now() - interval '7 days'
     OR (usado_em IS NOT NULL AND usado_em < now() - interval '7 days');
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$;

CREATE OR REPLACE FUNCTION public.limpar_tentativas_vencidas(retencao interval DEFAULT interval '24 hours')
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM public.tentativas_autenticacao WHERE criado_em < now() - retencao;
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$;

-- As centenas de funções `gbt_*`, `gtrgm_*` e `*_similarity` que a auditoria
-- também aponta pertencem às extensões btree_gist e pg_trgm, instaladas no
-- schema public. Não são nossas e recriá-las quebraria as extensões. A correção
-- correta é movê-las para um schema `extensions` — operação separada, que
-- derruba e recria os índices GiST da agenda e por isso não entra aqui.

-- ---------------------------------------------------------------- 3. Identidade

-- Lê o usuário da aplicação declarado na sessão. Devolve NULL quando ninguém
-- declarou, e é assim que as policies distinguem "requisição da aplicação com
-- usuário identificado" de "conexão solta".
CREATE OR REPLACE FUNCTION public.app_usuario_atual() RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('app.usuario_id', true), '')::bigint;
$$;

-- ---------------------------------------------------------------- 4. Policies
--
-- Saem as `app_total_*` (USING true em tudo). Entram policies por operação: o
-- que a aplicação nunca deve fazer, ela deixa de poder fazer.
--
-- O critério não é papel de usuário — papel é decidido no código, onde vive o
-- RBAC, e o banco não tem como saber se quem pediu é atendente ou gestor. O
-- critério é a natureza da tabela: registro histórico não se altera, evento
-- recebido não se reescreve, usuário não se apaga.

DO $$
DECLARE
  t text;
  -- Tabelas de trabalho: a aplicação lê, cria, altera e apaga.
  completas text[] := ARRAY[
    'contatos','conversas','mensagens','etiquetas','conversa_etiquetas',
    'leads','notas_internas','sessoes','recuperacoes_senha',
    'tentativas_autenticacao','profissionais','disponibilidades',
    'agenda_bloqueios','agendamentos'
  ];
BEGIN
  -- Fora as antigas, em todas as tabelas do schema.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_total_' || t, t);
  END LOOP;
  EXECUTE 'DROP POLICY IF EXISTS app_total_recuperacoes_senha ON public.recuperacoes_senha';
  EXECUTE 'DROP POLICY IF EXISTS app_total_tentativas ON public.tentativas_autenticacao';

  FOR t IN SELECT unnest(completas)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format($p$
        CREATE POLICY app_trabalho ON public.%I
        FOR ALL TO crmclinica_app
        USING (true) WITH CHECK (true)
      $p$, t);
    END IF;
  END LOOP;
END $$;

-- audit_log: escreve e lê, nunca altera nem apaga.
-- Auditoria que pode ser editada por quem é auditado não é auditoria. Retenção,
-- quando existir, entra por função SECURITY DEFINER — um ato deliberado, não um
-- DELETE solto de dentro de uma rota.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_audit_insere ON public.audit_log;
DROP POLICY IF EXISTS app_audit_le ON public.audit_log;
CREATE POLICY app_audit_insere ON public.audit_log
  FOR INSERT TO crmclinica_app WITH CHECK (true);
CREATE POLICY app_audit_le ON public.audit_log
  FOR SELECT TO crmclinica_app USING (true);

-- lead_eventos: mesma natureza — é o histórico da jornada do lead.
ALTER TABLE public.lead_eventos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_lead_eventos_insere ON public.lead_eventos;
DROP POLICY IF EXISTS app_lead_eventos_le ON public.lead_eventos;
CREATE POLICY app_lead_eventos_insere ON public.lead_eventos
  FOR INSERT TO crmclinica_app WITH CHECK (true);
CREATE POLICY app_lead_eventos_le ON public.lead_eventos
  FOR SELECT TO crmclinica_app USING (true);

-- eventos_recebidos: é o registro de idempotência. Insere, consulta e a limpeza
-- apaga o que envelheceu — mas reescrever um evento recebido apagaria a prova de
-- que ele chegou daquele jeito.
ALTER TABLE public.eventos_recebidos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_eventos_insere ON public.eventos_recebidos;
DROP POLICY IF EXISTS app_eventos_le ON public.eventos_recebidos;
DROP POLICY IF EXISTS app_eventos_limpa ON public.eventos_recebidos;
CREATE POLICY app_eventos_insere ON public.eventos_recebidos
  FOR INSERT TO crmclinica_app WITH CHECK (true);
CREATE POLICY app_eventos_le ON public.eventos_recebidos
  FOR SELECT TO crmclinica_app USING (true);
CREATE POLICY app_eventos_limpa ON public.eventos_recebidos
  FOR DELETE TO crmclinica_app USING (true);

-- usuarios: conta se desativa (`situacao`), não se apaga. Apagar levaria junto o
-- rastro de quem fez o quê nas tabelas que apontam para ela.
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_usuarios_le ON public.usuarios;
DROP POLICY IF EXISTS app_usuarios_cria ON public.usuarios;
DROP POLICY IF EXISTS app_usuarios_altera ON public.usuarios;
CREATE POLICY app_usuarios_le ON public.usuarios
  FOR SELECT TO crmclinica_app USING (true);
CREATE POLICY app_usuarios_cria ON public.usuarios
  FOR INSERT TO crmclinica_app WITH CHECK (true);
CREATE POLICY app_usuarios_altera ON public.usuarios
  FOR UPDATE TO crmclinica_app USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- 5. Privilégios
--
-- Grants precisos: policy só entra em cena depois de o privilégio existir. Sem
-- DELETE em audit_log, lead_eventos e usuarios o banco recusa antes mesmo de
-- olhar a policy — cinto e suspensório de propósito, porque são exatamente as
-- tabelas cuja perda não tem volta.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM crmclinica_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM crmclinica_app;

GRANT USAGE ON SCHEMA public TO crmclinica_app;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'contatos','conversas','mensagens','etiquetas','conversa_etiquetas',
      'leads','notas_internas','sessoes','recuperacoes_senha',
      'tentativas_autenticacao','profissionais','disponibilidades',
      'agenda_bloqueios','agendamentos'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT                 ON public.audit_log         TO crmclinica_app;
GRANT SELECT, INSERT                 ON public.lead_eventos      TO crmclinica_app;
GRANT SELECT, INSERT, DELETE         ON public.eventos_recebidos TO crmclinica_app;
GRANT SELECT, INSERT, UPDATE         ON public.usuarios          TO crmclinica_app;

-- bigserial precisa da sequência; sem isto todo INSERT falha.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crmclinica_app;

GRANT EXECUTE ON FUNCTION public.limpar_sessoes_vencidas()      TO crmclinica_app;
GRANT EXECUTE ON FUNCTION public.limpar_recuperacoes_vencidas() TO crmclinica_app;
GRANT EXECUTE ON FUNCTION public.limpar_tentativas_vencidas(interval) TO crmclinica_app;
GRANT EXECUTE ON FUNCTION public.app_usuario_atual()            TO crmclinica_app;

-- Tabela criada depois desta migration nasce sem acesso para a role, e o INSERT
-- falha na primeira tentativa em vez de a tabela ficar aberta sem ninguém notar.

-- ---------------------------------------------------------------- 6. Login
--
-- A role passa a poder conectar. A senha **não** está aqui: arquivo de migration
-- é versionado, e senha em Git é senha vazada. Defina fora do repositório:
--
--   ALTER ROLE crmclinica_app WITH PASSWORD '<gerada, guardada no cofre>';
--
-- Depois aponte CRMCLINICA_DATABASE_URL para ela. Enquanto a aplicação conectar
-- como `postgres`, tudo acima continua sendo decoração: o owner tem BYPASSRLS e
-- nenhuma policy é avaliada para ele.

ALTER ROLE crmclinica_app WITH LOGIN;

-- E a garantia de que ninguém devolve o acesso sem querer.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMIT;
