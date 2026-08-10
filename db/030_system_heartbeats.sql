-- 030_system_heartbeats.sql
--
-- Batimento de saúde dos componentes vivos do sistema.
--
-- O painel roda numa hospedagem externa (Vercel) e NUNCA alcança os serviços
-- que rodam na rede interna do servidor (OpenClaw em ws://172.17.0.1, ponte,
-- workers). Tentar checar saúde batendo direto nesses serviços fazia o
-- `/api/resumo` estourar o tempo e o painel pintar tudo de "indisponível".
--
-- A regra aqui é uma só: **quem enxerga o componente é quem grava o batimento**.
-- O servidor (que alcança tudo) faz UPSERT nesta tabela; o painel apenas LÊ.
-- Assim o status é real, em tempo quase real, sem expor nada da rede interna.
--
-- Frescor: o leitor decide verde/amarelo/vermelho pela idade de `updated_at`
-- (até 90s ok, até 5min degradado, acima disso indisponível).

CREATE TABLE IF NOT EXISTS public.system_heartbeats (
  componente  text PRIMARY KEY,          -- 'openclaw', 'serena', 'inbox', 'worker_calendar', 'banco'
  status      text NOT NULL DEFAULT 'ok',
  detalhe     jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS efetiva para o papel do app (crmclinica_app), como no resto do schema.
-- Status de sistema não é dado por-usuário: liberamos leitura/escrita ao papel
-- do app (o servidor e o painel conectam com ele). Nada sensível trafega aqui.
ALTER TABLE public.system_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_heartbeats_rw ON public.system_heartbeats;
CREATE POLICY system_heartbeats_rw
  ON public.system_heartbeats
  FOR ALL
  TO crmclinica_app
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.system_heartbeats TO crmclinica_app;
