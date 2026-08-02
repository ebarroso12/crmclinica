-- crmclinica — limite de tentativas de autenticação
--
-- Sem isto, um atacante testa senhas à vontade contra `/api/auth/login`. O hash
-- scrypt torna cada tentativa cara para ele, mas "caro" não é "impossível", e a
-- conta de uma pessoa com senha fraca cai numa noite.
--
-- O estado mora no banco, não em memória do processo: com duas instâncias atrás
-- de um balanceador, um contador local permitiria o dobro de tentativas — e a
-- proteção viraria teatro.
--
-- Duas decisões de privacidade:
--
--   * o e-mail entra **em hash**, não em claro. A tabela precisa agrupar
--     tentativas da mesma conta, não guardar uma lista de quem tem cadastro.
--   * senha nenhuma, em lugar nenhum — nem tamanho, nem prefixo, nem hash dela.

CREATE TABLE IF NOT EXISTS tentativas_autenticacao (
  id          bigserial PRIMARY KEY,
  -- Endereço de origem. `inet` aceita IPv4 e IPv6 e permite comparação correta.
  ip          inet,
  -- SHA-256 do e-mail normalizado (minúsculas, sem espaços nas pontas).
  hash_conta  text,
  acao        text NOT NULL DEFAULT 'login' CHECK (acao IN ('login', 'recuperacao', 'redefinicao')),
  sucesso     boolean NOT NULL DEFAULT false,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

-- Os dois índices sustentam a janela deslizante: a consulta é sempre
-- "quantas falhas nesta chave desde tal instante".
CREATE INDEX IF NOT EXISTS tentativas_ip_idx
  ON tentativas_autenticacao (ip, acao, criado_em DESC) WHERE NOT sucesso;
CREATE INDEX IF NOT EXISTS tentativas_conta_idx
  ON tentativas_autenticacao (hash_conta, acao, criado_em DESC) WHERE NOT sucesso;
-- Usado pela limpeza periódica.
CREATE INDEX IF NOT EXISTS tentativas_criado_idx ON tentativas_autenticacao (criado_em);

-- ---------------------------------------------------------------- RLS

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tentativas_autenticacao') THEN
    EXECUTE 'ALTER TABLE public.tentativas_autenticacao ENABLE ROW LEVEL SECURITY';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE 'DROP POLICY IF EXISTS app_total_tentativas ON public.tentativas_autenticacao';
      EXECUTE 'CREATE POLICY app_total_tentativas ON public.tentativas_autenticacao
                 FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)';
      EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.tentativas_autenticacao TO crmclinica_app';
      EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tentativas_autenticacao_id_seq TO crmclinica_app';
    END IF;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.tentativas_autenticacao FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- limpeza
--
-- Tentativa fora da janela não serve para limitar nada, e guardá-la para sempre
-- transformaria a tabela num registro de quem tentou entrar e quando.
-- A aplicação chama esta função periodicamente; um `cron` também serve.

CREATE OR REPLACE FUNCTION limpar_tentativas_vencidas(retencao interval DEFAULT interval '24 hours')
RETURNS integer AS $$
DECLARE removidas integer;
BEGIN
  DELETE FROM tentativas_autenticacao WHERE criado_em < now() - retencao;
  GET DIAGNOSTICS removidas = ROW_COUNT;
  RETURN removidas;
END;
$$ LANGUAGE plpgsql;
