-- Rollback da 033 — remove a coluna de posse dos trabalhos da outbox.
--
-- Só faz sentido junto com a reversão do código que a lê: uma aplicação que
-- exige `posse_token` na conclusão para de concluir qualquer trabalho se a
-- coluna sumir. Reverter o banco sem reverter o código trava a fila inteira.
-- Ordem correta: primeiro o código volta a não usar a coluna, depois isto.
--
-- O que se perde ao reverter: a capacidade de detectar posse perdida. A fila
-- volta ao comportamento em que um worker com lease vencido consegue concluir
-- por cima do dono atual — o defeito que a 033 existe para permitir corrigir.
-- Nenhum trabalho é apagado; nenhum dado de conversa é tocado.

BEGIN;

ALTER TABLE public.automacao_outbox
  DROP COLUMN IF EXISTS posse_token;

COMMIT;
