-- Rollback da 044 — volta o índice ao escopo restrito da 043
-- (identificador IS NOT NULL AND telefone IS NULL).
-- Reversão simples: dropar e recriar o índice não perde nenhum contato.

BEGIN;

DROP INDEX IF EXISTS contatos_identificador_uk;

CREATE UNIQUE INDEX IF NOT EXISTS contatos_identificador_uk
  ON contatos (identificador) WHERE identificador IS NOT NULL AND telefone IS NULL;

COMMIT;
