-- 027 — Gateway multi-IA: catálogo de modelos e telemetria de chamadas.
--
-- O catálogo e a allowlist são MANTIDOS PELO BACKEND: o navegador escolhe
-- entre o que esta tabela oferece, nunca digita nome de modelo livre. As
-- chaves de API não aparecem em lugar nenhum do banco — vivem no ambiente do
-- servidor.
--
-- A telemetria registra o que a operação precisa para responder "quanto
-- custou, quão rápido foi, o que falhou e quem assumiu no fallback" — e NUNCA
-- registra raciocínio interno de modelo. A coluna `resposta` guarda somente o
-- texto final entregue (necessário para o retry idempotente devolver o mesmo
-- resultado sem pagar nova chamada).

BEGIN;

-- ---------------------------------------------------------------- catálogo

CREATE TABLE IF NOT EXISTS ia_modelos (
  id          bigserial PRIMARY KEY,
  provedor    text NOT NULL CHECK (provedor IN ('openai', 'anthropic', 'google', 'deepseek', 'kimi')),
  modelo      text NOT NULL,
  rotulo      text NOT NULL,
  ativo       boolean NOT NULL DEFAULT true,
  padrao      boolean NOT NULL DEFAULT false,
  -- Custo por milhão de tokens, para a estimativa de custo da telemetria.
  custo_entrada_usd_mi numeric(10, 4),
  custo_saida_usd_mi   numeric(10, 4),
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ia_modelos_unicos UNIQUE (provedor, modelo)
);

COMMENT ON TABLE ia_modelos IS
  'Catálogo/allowlist de modelos por provedor, mantido pelo backend. O navegador escolhe daqui; modelo fora da lista é recusado.';

-- No máximo um modelo padrão.
CREATE UNIQUE INDEX IF NOT EXISTS ia_modelos_um_padrao
  ON ia_modelos ((true)) WHERE padrao;

-- Catálogo inicial. Idempotente: reaplicar não duplica nem sobrescreve o que
-- a equipe mudou pelo painel.
INSERT INTO ia_modelos (provedor, modelo, rotulo, padrao, custo_entrada_usd_mi, custo_saida_usd_mi) VALUES
  ('openai',    'gpt-4o-mini',                'GPT-4o Mini',            false, 0.15,  0.60),
  ('openai',    'gpt-4o',                     'GPT-4o',                 false, 2.50, 10.00),
  ('anthropic', 'claude-haiku-4-5-20251001',  'Claude Haiku 4.5',       true,  1.00,  5.00),
  ('anthropic', 'claude-sonnet-5',            'Claude Sonnet 5',        false, 3.00, 15.00),
  ('google',    'gemini-2.5-flash',           'Gemini 2.5 Flash',       false, 0.30,  2.50),
  ('deepseek',  'deepseek-chat',              'DeepSeek Chat',          false, 0.27,  1.10),
  ('kimi',      'kimi-latest',                'Kimi (Moonshot)',        false, 0.60,  2.50)
ON CONFLICT (provedor, modelo) DO NOTHING;

-- ---------------------------------------------------------------- telemetria

CREATE TABLE IF NOT EXISTS ia_chamadas (
  id                  bigserial PRIMARY KEY,

  -- Retry reutiliza a chave e recebe o MESMO resultado, sem nova cobrança.
  chave_idempotencia  text NOT NULL,

  finalidade          text NOT NULL,
  provedor            text NOT NULL,
  modelo              text NOT NULL,
  prompt_version      text,

  latencia_ms         int,
  tokens_entrada      int,
  tokens_saida        int,
  custo_estimado_usd  numeric(12, 6),

  -- O texto final entregue. Nunca raciocínio interno, nunca prompt completo.
  resposta            text,

  erro                text,
  -- Provedor que falhou antes deste assumir. Nulo = primeira opção atendeu.
  fallback_de         text,

  criado_em           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ia_chamadas_chave_unica UNIQUE (chave_idempotencia)
);

COMMENT ON TABLE ia_chamadas IS
  'Telemetria do gateway multi-IA: modelo, prompt_version, latência, tokens, custo, erro e fallback. Chave única = retry idempotente.';

CREATE INDEX IF NOT EXISTS ia_chamadas_periodo_idx ON ia_chamadas (criado_em);
CREATE INDEX IF NOT EXISTS ia_chamadas_finalidade_idx ON ia_chamadas (finalidade, criado_em);

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    FOREACH t IN ARRAY ARRAY['ia_modelos', 'ia_chamadas'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format('CREATE POLICY app_trabalho ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I_id_seq TO crmclinica_app', t);
    END LOOP;
    -- O catálogo a aplicação administra; a telemetria não se apaga nem se edita.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.ia_modelos TO crmclinica_app;
    GRANT SELECT, INSERT ON public.ia_chamadas TO crmclinica_app;
    REVOKE UPDATE, DELETE ON public.ia_chamadas FROM crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['ia_modelos', 'ia_chamadas'] LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMIT;
