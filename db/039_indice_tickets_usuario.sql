-- 039 — Índice de suporte para contagem de bilhetes de SSE por usuário.
--
-- Achado da auditoria adversarial (protocolo SRE, 2026-08-16), item P3:
-- `conversas_eventos_tickets.usuario_id` é FK com ON DELETE CASCADE
-- (db/037) sem índice na coluna — Postgres não cria índice automático em
-- FK. Um DELETE FROM usuarios dispara seq scan nesta tabela pra achar as
-- linhas do CASCADE, e piora conforme a tabela cresce.
--
-- Fica ainda mais necessário agora: item P2 (rate-limit de emissão de
-- bilhete, mesma sessão) passa a rodar, a cada emissão,
-- `SELECT count(*) ... WHERE usuario_id = $1 AND criado_em > $2` — sem
-- índice composto, essa consulta também seria seq scan, no caminho mais
-- quente da rota (toda conexão SSE passa por aqui).
--
-- Aditiva: só cria índice, não toca dado nem estrutura existente.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_conversas_eventos_tickets_usuario_criado
  ON conversas_eventos_tickets (usuario_id, criado_em);

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'conversas_eventos_tickets'
--      AND indexname = 'idx_conversas_eventos_tickets_usuario_criado';
--   -- esperado: 1 linha
--
-- Rollback: db/039_indice_tickets_usuario_rollback.sql
