-- 045 — Regras de palavra-gatilho do Instagram (comentário -> DM + resposta pública).
--
-- Pedido do Dr. Edson (23/08): quando alguém comenta uma palavra-gatilho num
-- post do Instagram, o sistema responde publicamente E manda DM privada (as
-- duas, sempre) — e, se a palavra bater, a DM é mais empática e inicia o
-- fluxo de qualificação de lead do consultório. A palavra-gatilho precisa
-- ser editável pelo admin a qualquer momento (não hardcoded no código).
--
-- Nada disso existia — não é extensão de `serena_regras` (que é biblioteca
-- de texto injetado sempre no prompt, sem condição nem ação, achado confirmado
-- na investigação de 23/08) — é tabela nova, com condição (palavra) e duas
-- ações (mensagem pública, mensagem de DM).
--
-- `instagram_comentarios_processados` é a idempotência/auditoria do lado do
-- webhook de comentário: evita reprocessar o mesmo comentário numa reentrega
-- do provedor, e registra qual regra bateu (ou nenhuma) para o admin
-- conseguir conferir depois "por que esse comentário não recebeu resposta".
--
-- Mesmo desenho de RLS/GRANT de `serena_regras` (db/011_serena.sql): a
-- aplicação lê e escreve, RBAC decide quem pode o quê no código.
--
-- Aditiva e reversível: nenhuma tabela existente muda.
-- Rollback em 045_instagram_gatilhos_rollback.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instagram_regras_gatilho (
  id               bigserial PRIMARY KEY,
  nome             text NOT NULL UNIQUE,
  palavra_gatilho  text NOT NULL CHECK (length(palavra_gatilho) BETWEEN 2 AND 100),
  mensagem_dm      text NOT NULL CHECK (length(mensagem_dm) BETWEEN 3 AND 2000),
  mensagem_publica text NOT NULL CHECK (length(mensagem_publica) BETWEEN 3 AND 500),
  cta_whatsapp     boolean NOT NULL DEFAULT true,
  ativa            boolean NOT NULL DEFAULT true,
  criado_por       bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_regras_gatilho_ativas_idx ON instagram_regras_gatilho (ativa);

CREATE TABLE IF NOT EXISTS instagram_comentarios_processados (
  id                       bigserial PRIMARY KEY,
  comentario_id_externo    text NOT NULL,
  post_id                  text,
  autor_ig_id              text NOT NULL,
  regra_id                 bigint REFERENCES instagram_regras_gatilho(id) ON DELETE SET NULL,
  resposta_publica_enviada boolean NOT NULL DEFAULT false,
  dm_enviada               boolean NOT NULL DEFAULT false,
  criado_em                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_comentarios_id_externo_uk
  ON instagram_comentarios_processados (comentario_id_externo);

-- ---------------------------------------------------------------- RLS/GRANT

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instagram_regras_gatilho', 'instagram_comentarios_processados'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format($p$
        CREATE POLICY app_trabalho ON public.%I
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)
      $p$, t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE instagram_regras_gatilho_id_seq TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE instagram_comentarios_processados_id_seq TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instagram_regras_gatilho', 'instagram_comentarios_processados'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
