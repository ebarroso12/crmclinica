-- 041 — Primeiro registro real da lista de bloqueio de contato (pedido
-- explícito do Edson, 2026-08-16).
--
-- Telefone normalizado do mesmo jeito que o resto do sistema normaliza
-- (só dígitos) — consistente com o que `contato.telefone` grava para
-- qualquer contato que chega pelo WhatsApp.

BEGIN;

INSERT INTO contatos_bloqueados (telefone, nome, motivo)
VALUES (
  regexp_replace('+55 11 99602-6888', '\D', '', 'g'),
  'Marciandrea',
  'Solicitou retorno após 3 meses; disse que vai fazer denúncia em USI.'
)
ON CONFLICT (telefone) DO NOTHING;

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT id, nome, telefone FROM contatos_bloqueados WHERE telefone = '5511996026888';
--   -- esperado: 1 linha, nome 'Marciandrea'
--
-- Rollback: db/041_seed_bloqueio_marciandrea_rollback.sql
