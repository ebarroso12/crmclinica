-- 020 — exportação de auditoria por pedido, dupla aprovação e expiração.
--
-- A aplicação nunca grava o arquivo exportado: ele é montado sob demanda,
-- já redigido, depois da aprovação de outro administrador. Assim não nasce
-- uma segunda cópia persistente da trilha sensível.

BEGIN;

CREATE TABLE IF NOT EXISTS public.auditoria_exportacoes (
  id bigserial PRIMARY KEY,
  solicitado_por bigint NOT NULL REFERENCES public.usuarios(id),
  aprovado_por bigint NULL REFERENCES public.usuarios(id),
  situacao text NOT NULL DEFAULT 'pendente'
    CHECK (situacao IN ('pendente', 'aprovada', 'expirada', 'cancelada')),
  filtros jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  aprovado_em timestamptz NULL,
  expira_em timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CHECK (aprovado_por IS NULL OR aprovado_por <> solicitado_por)
);

CREATE INDEX IF NOT EXISTS auditoria_exportacoes_pendentes_idx
  ON public.auditoria_exportacoes (situacao, expira_em DESC);

ALTER TABLE public.auditoria_exportacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.auditoria_exportacoes FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.auditoria_exportacoes TO crmclinica_app;
  END IF;
END
$$;

DROP POLICY IF EXISTS app_auditoria_exportacoes ON public.auditoria_exportacoes;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    CREATE POLICY app_auditoria_exportacoes ON public.auditoria_exportacoes
      FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
  END IF;
END
$$;

COMMIT;
