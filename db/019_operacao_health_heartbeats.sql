-- 019 — prova de vida dos processos que operam fora da Vercel.
--
-- O worker é quem mantém a fila, a sincronia da Serena e a coleta do
-- WhatsApp. Uma fila momentaneamente vazia não prova que ele está vivo.

BEGIN;

CREATE TABLE IF NOT EXISTS public.operacao_heartbeats (
  componente text PRIMARY KEY CHECK (componente IN ('lembretes_worker')),
  visto_em timestamptz NOT NULL DEFAULT now(),
  instancia text NOT NULL CHECK (length(instancia) <= 100),
  versao text NULL CHECK (length(versao) <= 80)
);

ALTER TABLE public.operacao_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operacao_heartbeats FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.operacao_heartbeats TO crmclinica_app;
  END IF;
END
$$;

DROP POLICY IF EXISTS app_operacao_heartbeats ON public.operacao_heartbeats;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    CREATE POLICY app_operacao_heartbeats ON public.operacao_heartbeats
      FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
  END IF;
END
$$;

COMMIT;
