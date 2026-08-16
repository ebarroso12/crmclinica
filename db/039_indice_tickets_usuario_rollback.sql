-- Rollback de 039 — remove só o índice, nada de dado.
-- Uso: banco descartável de teste. Nunca em produção sem autorização.

BEGIN;

DROP INDEX IF EXISTS idx_conversas_eventos_tickets_usuario_criado;

COMMIT;
