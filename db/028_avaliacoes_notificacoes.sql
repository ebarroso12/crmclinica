-- 028 — Avaliações de IA, central de notificações e ativação gradual da Serena.
--
-- Três peças que fecham a frente de IA:
--
--   1. **Avaliações** — cada resposta da automação pode ser avaliada em três
--      eixos (empatia, segurança, aderência), por heurística, por outro modelo
--      ou por humano. O resultado é trilha, não veto: quem decide desligar é
--      gente, olhando os números.
--   2. **Notificações** — a central que o sino da interface lê. A chave única
--      torna a geração idempotente, como as tarefas.
--   3. **Ativação gradual** — religar a Serena não precisa ser tudo-ou-nada:
--      `percentual` atende uma fração determinística dos contatos, `lista`
--      atende só quem foi explicitamente incluído. O desligado global continua
--      soberano sobre qualquer modo.

BEGIN;

-- ---------------------------------------------------------------- avaliações

CREATE TABLE IF NOT EXISTS ia_avaliacoes (
  id           bigserial PRIMARY KEY,
  conversa_id  bigint REFERENCES public.conversas(id) ON DELETE CASCADE,
  mensagem_id  bigint NOT NULL REFERENCES public.mensagens(id) ON DELETE CASCADE,
  avaliador    text NOT NULL CHECK (avaliador IN ('heuristica', 'ia', 'humano')),

  empatia      int NOT NULL CHECK (empatia BETWEEN 0 AND 100),
  seguranca    int NOT NULL CHECK (seguranca BETWEEN 0 AND 100),
  aderencia    int NOT NULL CHECK (aderencia BETWEEN 0 AND 100),

  veredito     text NOT NULL CHECK (veredito IN ('aprovada', 'atencao', 'reprovada')),
  motivos      jsonb NOT NULL DEFAULT '[]'::jsonb,

  criado_em    timestamptz NOT NULL DEFAULT now(),

  -- Uma avaliação por mensagem e avaliador: reavaliar não duplica.
  CONSTRAINT ia_avaliacoes_unicas UNIQUE (mensagem_id, avaliador)
);

COMMENT ON TABLE ia_avaliacoes IS
  'Avaliação de respostas da automação: empatia, segurança e aderência (0-100) com veredito e motivos. Idempotente por (mensagem, avaliador).';

CREATE INDEX IF NOT EXISTS ia_avaliacoes_veredito_idx ON ia_avaliacoes (veredito, criado_em);

-- ---------------------------------------------------------------- notificações

CREATE TABLE IF NOT EXISTS notificacoes (
  id          bigserial PRIMARY KEY,
  -- Nulo = para toda a equipe.
  usuario_id  bigint REFERENCES public.usuarios(id) ON DELETE CASCADE,
  tipo        text NOT NULL,
  titulo      text NOT NULL,
  corpo       text,
  chave       text NOT NULL,
  lida_em     timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notificacoes_chave_unica UNIQUE (chave)
);

COMMENT ON TABLE notificacoes IS
  'Central de notificações (o sino do topo). Chave única = geração idempotente; reprocessar não duplica aviso.';

CREATE INDEX IF NOT EXISTS notificacoes_nao_lidas_idx
  ON notificacoes (criado_em) WHERE lida_em IS NULL;

-- ------------------------------------------------------ ativação gradual

ALTER TABLE public.serena_configuracao
  ADD COLUMN IF NOT EXISTS modo_ativacao text NOT NULL DEFAULT 'todos'
    CHECK (modo_ativacao IN ('todos', 'percentual', 'lista')),
  ADD COLUMN IF NOT EXISTS ativacao_percentual int NOT NULL DEFAULT 100
    CHECK (ativacao_percentual BETWEEN 0 AND 100);

COMMENT ON COLUMN public.serena_configuracao.modo_ativacao IS
  'Como a Serena atende quando ligada: todos, uma fração determinística (percentual) ou só a lista explícita.';

CREATE TABLE IF NOT EXISTS serena_ativacao_contatos (
  contato_id  bigint PRIMARY KEY REFERENCES public.contatos(id) ON DELETE CASCADE,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  criado_por  bigint REFERENCES public.usuarios(id) ON DELETE SET NULL
);

COMMENT ON TABLE serena_ativacao_contatos IS
  'Allowlist do modo de ativação "lista": contatos que a Serena atende durante o rollout gradual.';

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    FOREACH t IN ARRAY ARRAY['ia_avaliacoes', 'notificacoes', 'serena_ativacao_contatos'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format('CREATE POLICY app_trabalho ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
    END LOOP;
    GRANT USAGE, SELECT ON SEQUENCE ia_avaliacoes_id_seq TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE notificacoes_id_seq TO crmclinica_app;
    -- A avaliação, como a telemetria, não se reescreve.
    REVOKE UPDATE, DELETE ON public.ia_avaliacoes FROM crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['ia_avaliacoes', 'notificacoes', 'serena_ativacao_contatos'] LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMIT;
