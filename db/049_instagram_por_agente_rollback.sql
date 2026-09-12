-- Rollback da 049.
--
-- ATENÇÃO ao efeito operacional: sem `agente_id`, TODA regra de gatilho volta
-- a valer para qualquer perfil. Se a loja Alpins tiver regras próprias, elas
-- passam a responder também nos posts da clínica — e as da clínica, nos posts
-- da loja.
--
-- Antes de rodar: desative as regras do perfil que não é o da clínica
-- (tela Instagram → desligar a regra), ou apague-as.

BEGIN;

DROP INDEX IF EXISTS instagram_comentarios_por_agente;
DROP INDEX IF EXISTS instagram_regras_por_agente;

ALTER TABLE instagram_comentarios_processados
  DROP COLUMN IF EXISTS conta_comercial_id;

ALTER TABLE instagram_comentarios_processados
  DROP COLUMN IF EXISTS agente_id;

ALTER TABLE instagram_regras_gatilho
  DROP COLUMN IF EXISTS agente_id;

COMMIT;
