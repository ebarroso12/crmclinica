-- Rollback da 039 — remove posse_token e o estado 'incerto' dos lembretes.
--
-- Mesma ordem exigida pelo rollback de 033: primeiro o código volta a não
-- usar `posse_token`/'incerto', depois isto. Reverter o banco antes travaria
-- a fila (qualquer código que ainda exija a coluna deixaria de concluir
-- lembrete nenhum).
--
-- O que se perde ao reverter: detecção de posse perdida (mesmo defeito que a
-- migration 033 corrige em automacao_outbox) e o estado 'incerto' —
-- lembretes com entrega indeterminada voltam a ser tratados como falha comum
-- retentável. Nenhum lembrete é apagado.
--
-- Reverter o estado 'incerto' exige que NENHUMA linha esteja nesse estado no
-- momento — senão a constraint antiga rejeita as linhas existentes. Este
-- rollback falha alto nesse caso, de propósito: silenciosamente perder a
-- distinção de uma entrega já marcada como incerta seria pior que a migration
-- não reverter.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lembretes WHERE estado = 'incerto') THEN
    RAISE EXCEPTION 'rollback recusado: existem lembretes em estado ''incerto'' — resolva-os antes de reverter';
  END IF;

  ALTER TABLE public.lembretes DROP CONSTRAINT IF EXISTS lembretes_estado_check;
  ALTER TABLE public.lembretes ADD CONSTRAINT lembretes_estado_check
    CHECK (estado IN ('pendente', 'processando', 'enviado', 'ignorado', 'falhou'));
END $$;

ALTER TABLE public.lembretes
  DROP COLUMN IF EXISTS posse_token;

COMMIT;
