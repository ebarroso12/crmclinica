-- 039 — Posse verificável e entrega indeterminada para os lembretes.
--
-- Gate 4 da auditoria (2026-08-15): "não aceite como prova apenas o
-- comentário do código ou idempotencyKey". Investigado e confirmado:
--
--   1. `concluirLembrete` (src/dados/repositorio.js) fechava o lembrete com
--      `UPDATE lembretes SET ... WHERE id = $1` — só pelo id, sem conferir
--      quem reivindicou. É EXATAMENTE o defeito que a migration 033 já
--      corrigiu em `automacao_outbox` (posse_token): o lease de um worker
--      vence, outro retoma o lembrete, e o primeiro — que ainda estava
--      esperando resposta do gateway, alheio a tudo — volta e sobrescreve o
--      desfecho do dono atual. Paciente pode receber o lembrete duas vezes.
--
--   2. `openclaw-lembretes.js`, no timeout do gateway ("a mensagem pode ter
--      saído"), só tinha comentário — nenhum código impedia retentativa
--      automática além da `idempotencyKey` do PRÓPRIO GATEWAY (sistema
--      externo, sem garantia documental de dedup durável através de toda a
--      janela de recuperação). Sem marca própria, "incerto" virava
--      "pendente" e era retentado como qualquer falha comum.
--
-- Esta migration só abre espaço no schema; a lógica (fencing na conclusão,
-- estado 'incerto' sem retry automático) é código, corrigida junto no mesmo
-- commit.
--
-- Aditiva por construção, mesmo padrão de 033 (posse_token) e 023 (extensão
-- de CHECK via DROP/ADD idempotente). Aplicar depois de 010.

BEGIN;

ALTER TABLE public.lembretes
  ADD COLUMN IF NOT EXISTS posse_token bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.lembretes.posse_token IS
  'Contador monotônico da posse do lembrete (mesmo desenho de automacao_outbox.posse_token, migration 033). Sobe a cada reivindicação; concluir precisa apresentar o token da posse corrente. Token divergente = posse perdida = o worker antigo não pode concluir por cima do dono atual.';

DO $$
BEGIN
  ALTER TABLE public.lembretes DROP CONSTRAINT IF EXISTS lembretes_estado_check;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lembretes_estado_check'
  ) THEN
    ALTER TABLE public.lembretes ADD CONSTRAINT lembretes_estado_check
      CHECK (estado IN ('pendente', 'processando', 'enviado', 'ignorado', 'falhou', 'incerto'));
  END IF;
END $$;

COMMENT ON COLUMN public.lembretes.estado IS
  'incerto: o gateway não respondeu a tempo (timeout) — a mensagem pode ter saído, ninguém sabe. Nunca retentado automaticamente (mesma regra de automacao_outbox para o job, e de mensagens.entrega_indeterminada — migration 038 — para a mensagem); precisa de decisão humana.';

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'lembretes' AND column_name = 'posse_token';
--   -- esperado: 1 linha
--
--   SELECT conname FROM pg_constraint WHERE conname = 'lembretes_estado_check';
--   -- esperado: 1 linha
--
-- Rollback: db/039_lembretes_posse_e_incerto_rollback.sql
