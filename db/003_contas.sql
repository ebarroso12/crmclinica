-- crmclinica — contas da equipe: aprovação, Google, segundo fator e recuperação
--
-- Três ideias governam este arquivo:
--
--  1. **Ninguém entra sozinho.** Conta nova nasce `pendente` e só atende depois
--     que o admin master libera. Cadastro não é autorização.
--
--  2. **Nada reversível é guardado.** Senha, segredo do segundo fator e token de
--     recuperação são hash ou cifra — nunca texto que alguém possa ler no banco.
--
--  3. **Senha provisória é provisória.** Quem recebe senha de terceiros troca no
--     primeiro acesso, sem escolha.

-- ---------------------------------------------------------------- usuários

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS situacao text NOT NULL DEFAULT 'pendente'
  CHECK (situacao IN ('pendente', 'ativo', 'recusado', 'desativado'));

-- O admin master é único e não pode ser desativado nem recusado por ninguém.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS master boolean NOT NULL DEFAULT false;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS precisa_trocar_senha boolean NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url text;

-- Vínculo com a conta Google. `sub` é o identificador estável do Google;
-- o e-mail pode mudar, o `sub` não.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_google_sub_uk ON usuarios (google_sub) WHERE google_sub IS NOT NULL;

-- Segundo fator (TOTP). O segredo fica **cifrado**, não em claro: quem lê a
-- tabela não pode gerar códigos válidos.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_segredo_cifrado text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_ativo boolean NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_confirmado_em timestamptz;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aprovado_por bigint REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aprovado_em timestamptz;

CREATE INDEX IF NOT EXISTS usuarios_situacao_idx ON usuarios (situacao, criado_em DESC);

-- Só pode existir um admin master.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_master_uk ON usuarios (master) WHERE master;

-- Contas anteriores a esta migration já estavam em uso: ficam ativas.
UPDATE usuarios SET situacao = 'ativo' WHERE situacao = 'pendente' AND ativo;

-- ---------------------------------------------------------------- recuperação de senha

CREATE TABLE IF NOT EXISTS recuperacoes_senha (
  id           bigserial PRIMARY KEY,
  usuario_id   bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  -- Como no refresh token: guarda-se o SHA-256, nunca o token enviado por e-mail.
  hash_token   text NOT NULL UNIQUE,
  expira_em    timestamptz NOT NULL,
  usado_em     timestamptz,
  solicitado_ip inet,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recuperacoes_usuario_idx ON recuperacoes_senha (usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS recuperacoes_vivas_idx ON recuperacoes_senha (hash_token) WHERE usado_em IS NULL;

-- ---------------------------------------------------------------- RLS das tabelas novas

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'recuperacoes_senha') THEN
    EXECUTE 'ALTER TABLE public.recuperacoes_senha ENABLE ROW LEVEL SECURITY';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE 'DROP POLICY IF EXISTS app_total_recuperacoes_senha ON public.recuperacoes_senha';
      EXECUTE 'CREATE POLICY app_total_recuperacoes_senha ON public.recuperacoes_senha
                 FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)';
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.recuperacoes_senha TO crmclinica_app';
      EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE recuperacoes_senha_id_seq TO crmclinica_app';
    END IF;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.recuperacoes_senha FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- higiene

CREATE OR REPLACE FUNCTION limpar_recuperacoes_vencidas() RETURNS integer AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM recuperacoes_senha
  WHERE expira_em < now() - interval '7 days'
     OR (usado_em IS NOT NULL AND usado_em < now() - interval '7 days');
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$ LANGUAGE plpgsql;
