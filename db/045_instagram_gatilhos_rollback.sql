-- Rollback da 045 — apaga as duas tabelas novas (instagram_regras_gatilho,
-- instagram_comentarios_processados). Nenhuma tabela existente é afetada.

BEGIN;

DROP TABLE IF EXISTS instagram_comentarios_processados;
DROP TABLE IF EXISTS instagram_regras_gatilho;

COMMIT;
