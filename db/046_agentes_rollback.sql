-- Rollback da 046 — remove conversas.agente_id e as cinco tabelas de agentes.
--
-- ANTES de rodar (ver "Voltar atrás" em docs/AGENTES.md):
--   1. desligue o webhook e a instância do agente na Evolution — o código
--      antigo não conhece agente e a Serena responderia pelo número da clínica;
--   2. reverta o deploy (o código com agentes precisa estar fora do ar — com ele
--      no ar, este rollback derruba o inbox).
--
-- Recusa rodar se existir QUALQUER conversa com agente_id — inclusive
-- resolvida. Apagar a coluna com essas conversas as transformaria em conversas
-- da clínica: a próxima mensagem do cliente iria para a Serena e sairia pelo
-- número da clínica, e o resumo automático mandaria conversa de cliente do
-- agente para a equipe da clínica. RESOLVER NÃO BASTA (não zera agente_id):
-- exporte e remova essas conversas, ou mantenha a 046 aplicada — ela é
-- compatível com o código antigo enquanto nenhuma conversa de agente existir.

BEGIN;

-- Não segurar o inbox esperando lock: sem o lock em 5 s, falha sem mudar nada.
SET LOCAL lock_timeout = '5s';
-- Quem roda precisa enxergar TODAS as linhas: com row_security off, uma
-- política que esconderia conversa de agente dá erro em vez de filtrar em
-- silêncio e deixar a checagem abaixo passar.
SET LOCAL row_security = off;

-- Entre a checagem e o DROP COLUMN, ninguém grava conversa nova (achado B1).
LOCK TABLE conversas IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversas' AND column_name = 'agente_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM conversas WHERE agente_id IS NOT NULL) THEN
      RAISE EXCEPTION 'rollback da 046 recusado: existem conversas de agente (conversas.agente_id preenchido, inclusive resolvidas). Resolver não basta: exporte e remova essas conversas, ou mantenha a 046 aplicada.';
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
