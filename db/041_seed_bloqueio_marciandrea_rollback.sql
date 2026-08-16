-- Rollback da 041 — remove só o registro de seed, nunca a tabela inteira.
BEGIN;
DELETE FROM contatos_bloqueados WHERE telefone = regexp_replace('+55 11 99602-6888', '\D', '', 'g');
COMMIT;
