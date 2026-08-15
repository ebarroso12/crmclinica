-- Rollback de 038_mensagens_confirmacao_de_entrega.sql
--
-- Remove as duas colunas. Volta ao estado em que o sistema não distingue
-- "não enviei" de "já enviei" — reintroduz o bug que 038 existe para fechar.
-- Só faz sentido em banco descartável de teste, para provar reversibilidade.

BEGIN;

ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entregue_em;
ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entrega_indeterminada;

COMMIT;
