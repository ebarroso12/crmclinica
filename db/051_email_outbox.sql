-- 051 — fila de e-mail.
--
-- Por que existe: o e-mail de recuperação de senha era enviado direto pelo
-- servidor HTTP, que na produção é uma função serverless na Vercel. Três
-- problemas nisso, e o terceiro foi o que travou a entrega em 12/09/2026:
--
--   1. o processo morre em segundos — uma entrega lenta vira timeout na cara
--      de quem clicou em "Esqueci minha senha";
--   2. o IP muda a cada execução, e IP novo sem reputação cai em spam;
--   3. a senha do e-mail precisaria estar lá, e só o dono da conta consegue
--      colocá-la no painel.
--
-- Com a fila, a rota grava e responde na hora; quem entrega é o worker no VPS,
-- que tem IP fixo, vive o tempo que precisar e já guarda as credenciais dos
-- outros serviços. Se o envio falhar, ele tenta de novo — coisa que o caminho
-- direto nunca pôde fazer.
--
-- O CONTEÚDO AQUI É SENSÍVEL de um jeito específico: o corpo do e-mail de
-- recuperação carrega o LINK com o token que redefine a senha. Quem lê esta
-- tabela consegue tomar a conta de alguém. Por isso:
--
--   • o texto é apagado assim que o e-mail sai (`apagarConteudoEnviado`), e o
--     registro fica só como rastro (para quem, quando, quantas tentativas);
--   • RLS ligada, e nenhum papel além do `crmclinica_app` recebe permissão;
--   • o token em si já expira em 1 hora e só serve uma vez (contas.js).
--
-- Idempotente: pode rodar duas vezes.

BEGIN;

CREATE TABLE IF NOT EXISTS email_outbox (
  id            bigserial PRIMARY KEY,
  para          text NOT NULL,
  assunto       text NOT NULL,
  -- Apagado depois do envio: ver o comentário acima.
  texto         text,
  estado        text NOT NULL DEFAULT 'pendente'
                CHECK (estado IN ('pendente', 'enviando', 'enviado', 'falhou')),
  tentativas    int NOT NULL DEFAULT 0,
  max_tentativas int NOT NULL DEFAULT 5,
  ultimo_erro   text,
  disponivel_em timestamptz NOT NULL DEFAULT now(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  enviado_em    timestamptz
);

-- O worker busca "o que está pendente e já pode sair", em ordem de chegada.
CREATE INDEX IF NOT EXISTS email_outbox_fila_idx
  ON email_outbox (estado, disponivel_em)
  WHERE estado IN ('pendente', 'enviando');

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE email_outbox_id_seq TO crmclinica_app;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'email_outbox' AND policyname = 'email_outbox_app'
    ) THEN
      CREATE POLICY email_outbox_app ON email_outbox
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

COMMIT;
