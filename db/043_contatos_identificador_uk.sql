-- 043 — Dedupe de contato por identificador, para canais sem telefone (Instagram).
--
-- Contexto: a integração de Instagram (em construção) identifica quem
-- escreveu pelo PSID (Instagram-Scoped ID), guardado em `contatos.identificador`
-- — o Instagram não fornece telefone. Hoje `encontrarOuCriarContato`
-- (src/dados/repositorio.js) só sabe deduplicar por `telefone`
-- (`contatos_telefone_uk`, db/001_inbox.sql): o `INSERT ... ON CONFLICT
-- (telefone) WHERE telefone IS NOT NULL` nunca dispara quando `telefone` é
-- NULL, então cada mensagem nova do mesmo seguidor do Instagram criaria um
-- contato novo, em vez de reaproveitar o existente — sem este índice, todo
-- lead do Instagram nasceria fragmentado em N fichas para a mesma pessoa.
--
-- Escopo do índice restrito a `telefone IS NULL`: protege só o caso
-- "identificador é a única forma de reconhecer esta pessoa" (Instagram hoje).
-- Um contato de WhatsApp que eventualmente também tenha `identificador`
-- preenchido não entra nesta unicidade — telefone continua sendo a chave
-- dele, sem risco de colisão cruzada entre os dois canais.
--
-- Aditiva e reversível: nenhuma coluna muda, nenhum dado se perde.
-- Rollback em 043_contatos_identificador_uk_rollback.sql.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS contatos_identificador_uk
  ON contatos (identificador) WHERE identificador IS NOT NULL AND telefone IS NULL;

COMMIT;
