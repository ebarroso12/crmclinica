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
GRANT SELECT, INSERT, UPDATE ON TABLE public.operacao_heartbeats TO crmclinica_app;

DROP POLICY IF EXISTS app_operacao_heartbeats ON public.operacao_heartbeats;
CREATE POLICY app_operacao_heartbeats ON public.operacao_heartbeats
  FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);

COMMIT;
