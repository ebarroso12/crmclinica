-- crmclinica — autenticação, sessões e Row Level Security
--
-- Duas coisas acontecem aqui, e a segunda é a mais importante:
--
--  1. `sessoes` guarda os refresh tokens **em hash**, para que possam ser revogados
--     sem que a tabela vire uma lista de sessões sequestráveis;
--
--  2. RLS é ligado em **todas** as tabelas. Sem isto, qualquer chave anônima do
--     Supabase leria conversas de pacientes pela API REST automática — mesmo que a
--     aplicação nunca use essa API. A porta existe; RLS é o que a tranca.
--
-- O backend do crmclinica conecta como dono do banco (connection string direta),
-- e o dono contorna RLS por padrão. Portanto as políticas aqui não atrapalham a
-- aplicação: elas fecham a porta lateral da API REST/anon.

-- ---------------------------------------------------------------- usuários

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login_em timestamptz;

-- E-mail é a identidade de login: sem ele não há como entrar.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_uk ON usuarios (lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------- sessões

CREATE TABLE IF NOT EXISTS sessoes (
  id            bigserial PRIMARY KEY,
  usuario_id    bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  -- Nunca o token em claro: só o SHA-256 dele.
  hash_refresh  text NOT NULL UNIQUE,
  expira_em     timestamptz NOT NULL,
  revogada_em   timestamptz,
  agente        text,
  ip            inet,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessoes_usuario_idx ON sessoes (usuario_id, criado_em DESC);
-- Busca do caminho quente do refresh: só sessões que ainda valem.
CREATE INDEX IF NOT EXISTS sessoes_vivas_idx ON sessoes (hash_refresh) WHERE revogada_em IS NULL;

-- ---------------------------------------------------------------- Row Level Security

-- Ligar RLS sem política nenhuma nega tudo para quem não é dono da tabela.
-- É exatamente o que se quer: `anon` e `authenticated`, que chegariam pela API
-- REST automática do Supabase, deixam de enxergar qualquer linha.
--
-- Sem FORCE de propósito: o backend conecta com a connection string do projeto,
-- cujo papel é dono das tabelas, e dono ignora RLS. Usar FORCE aqui trancaria a
-- própria aplicação para fora — a segurança viraria indisponibilidade.
-- Para endurecer além disto, veja "Endurecimento opcional" no fim do arquivo.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas',
    'conversa_etiquetas', 'leads', 'notas_internas', 'audit_log',
    'eventos_recebidos', 'sessoes'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- O papel da aplicação: é ele que o backend usa, e só ele atravessa as políticas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    CREATE ROLE crmclinica_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crmclinica_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crmclinica_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crmclinica_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crmclinica_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crmclinica_app;

-- Uma política por tabela, para o papel da aplicação. Quem não é `crmclinica_app`
-- — inclusive `anon` e `authenticated` — não casa com nenhuma política e não lê nada.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas',
    'conversa_etiquetas', 'leads', 'notas_internas', 'audit_log',
    'eventos_recebidos', 'sessoes'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_total_' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)',
        'app_total_' || t, t);
    END IF;
  END LOOP;
END $$;

-- Revoga explicitamente o acesso dos papéis da API automática do Supabase.
-- RLS já bloquearia a leitura; tirar o GRANT faz a porta nem abrir.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- higiene

-- Sessão expirada não precisa ficar guardada para sempre.
CREATE OR REPLACE FUNCTION limpar_sessoes_vencidas() RETURNS integer AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM sessoes
  WHERE expira_em < now() - interval '30 days'
     OR (revogada_em IS NOT NULL AND revogada_em < now() - interval '30 days');
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- endurecimento opcional
--
-- O passo acima já fecha a API REST do Supabase. Para ir além e fazer a própria
-- aplicação rodar sob RLS — de modo que um erro de código não consiga varrer o
-- banco inteiro — dê **LOGIN** ao papel da aplicação e use-o na connection string:
--
--   ALTER ROLE crmclinica_app LOGIN PASSWORD 'senha-forte-gerada';
--   -- e aponte CRMCLINICA_DATABASE_URL para esse papel, em vez do dono do banco
--
-- E só então force RLS, agora com segurança, porque a aplicação deixa de ser dona:
--
--   ALTER TABLE public.conversas FORCE ROW LEVEL SECURITY;  -- e demais tabelas
--
-- Não está ativado aqui porque exige gerar e guardar mais uma credencial; é uma
-- decisão de operação, não de esquema.
