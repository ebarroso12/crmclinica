-- Rollback de 042_mensagens_id_provedor.sql

BEGIN;

DROP INDEX IF EXISTS mensagens_id_provedor_uk;
ALTER TABLE mensagens DROP COLUMN IF EXISTS id_provedor;

COMMIT;
