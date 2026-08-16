-- Rollback da 040 — remove a tabela de bloqueio de contato por completo.
BEGIN;
DROP TABLE IF EXISTS contatos_bloqueados;
COMMIT;
