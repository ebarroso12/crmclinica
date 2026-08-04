-- 012 — sessões e transcrições do laboratório interno de voz da Serena.
-- Áudio bruto não é armazenado. A sessão registra consentimento, autoria e prazo.

BEGIN;

CREATE TABLE IF NOT EXISTS serena_voz_sessoes (
  id               text PRIMARY KEY CHECK (id ~ '^sv_[0-9a-f-]{36}$'),
  usuario_id       bigint NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  conversa_id      bigint REFERENCES conversas(id) ON DELETE SET NULL,
  perfil           text NOT NULL CHECK (length(perfil) BETWEEN 1 AND 80),
  estado           text NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa', 'encerrada', 'expirada', 'falhou')),
  consentimento_em timestamptz NOT NULL,
  expira_em        timestamptz NOT NULL,
  encerrado_em     timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  CHECK (expira_em > consentimento_em)
);

CREATE INDEX IF NOT EXISTS serena_voz_sessoes_usuario_idx
  ON serena_voz_sessoes (usuario_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS serena_voz_turnos (
  id                 bigserial PRIMARY KEY,
  chave_idempotencia text NOT NULL UNIQUE CHECK (length(chave_idempotencia) BETWEEN 8 AND 160),
  sessao_id          text NOT NULL REFERENCES serena_voz_sessoes(id) ON DELETE CASCADE,
  papel              text NOT NULL CHECK (papel IN ('usuario', 'serena')),
  transcricao        text NOT NULL CHECK (length(transcricao) BETWEEN 1 AND 8000),
  ocorrido_em        timestamptz NOT NULL,
  criado_em          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS serena_voz_turnos_sessao_idx
  ON serena_voz_turnos (sessao_id, ocorrido_em, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['serena_voz_sessoes', 'serena_voz_turnos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format('CREATE POLICY app_trabalho ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE serena_voz_turnos_id_seq TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['serena_voz_sessoes', 'serena_voz_turnos'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
