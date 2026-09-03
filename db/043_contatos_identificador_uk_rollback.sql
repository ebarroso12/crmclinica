-- Rollback da 043 — remove o índice único de identificador (Instagram).
-- Reversão simples: dropar o índice não perde nenhum contato nem coluna.

BEGIN;

DROP INDEX IF EXISTS contatos_identificador_uk;

COMMIT;
