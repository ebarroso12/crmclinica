-- Rollback de 037_conversas_eventos_duraveis.sql
--
-- Remove as duas tabelas novas. Nenhuma tabela pré-existente é tocada.
-- Perde o histórico de eventos (aceitável: é um log de apoio ao chat ao
-- vivo, não a fonte de verdade — `mensagens` continua íntegra).

BEGIN;

DROP TABLE IF EXISTS conversas_eventos_tickets;
DROP TABLE IF EXISTS conversas_eventos;

COMMIT;
