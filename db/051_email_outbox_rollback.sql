-- Rollback da 051.
--
-- Efeito operacional: o e-mail de recuperação de senha volta a depender de o
-- servidor HTTP ter SMTP configurado. Onde ele não tem (a Vercel), o pedido
-- passa a só registrar no log e ninguém recebe link nenhum — que era o
-- comportamento antes desta migration.
--
-- Antes de rodar: confira se há e-mail pendente na fila. O DROP leva junto.
--   SELECT count(*) FROM email_outbox WHERE estado IN ('pendente', 'enviando');

BEGIN;

DROP TABLE IF EXISTS email_outbox;

COMMIT;
