-- Rollback da 046 — remove conversas.agente_id e as cinco tabelas de agentes.
--
-- ANTES de rodar: o código que usa agentes precisa já ter saído do ar (deploy
-- da versão anterior). Com o código novo no ar, este rollback derruba o inbox.
--
-- Recusa rodar se ainda existe conversa de agente. Apagar a coluna com essas
-- conversas abertas as transformaria em conversas da clínica: a próxima
-- mensagem do cliente iria para a Serena e sairia pelo número da clínica.
-- Resolva ou exporte essas conversas primeiro, e só então rode o rollback.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversas' AND column_name = 'agente_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM conversas WHERE agente_id IS NOT NULL) THEN
      RAISE EXCEPTION 'rollback da 046 recusado: existem conversas de agente (conversas.agente_id preenchido). Resolva-as antes: sem a coluna elas virariam conversas da clínica.';
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS conversas_agente_idx;
ALTER TABLE conversas DROP COLUMN IF EXISTS agente_id;

DROP TABLE IF EXISTS agente_canais;
DROP TABLE IF EXISTS agente_acoes_inatividade;
DROP TABLE IF EXISTS agente_treinamentos;
DROP TABLE IF EXISTS agente_comportamentos;
DROP TABLE IF EXISTS agentes;

COMMIT;
