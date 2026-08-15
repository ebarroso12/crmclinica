-- 033 — Posse verificável dos trabalhos da outbox da automação.
--
-- O problema que esta migration existe para permitir resolver:
-- `concluirTrabalhoDeOutbox` (src/dados/repositorio.js) fechava o trabalho com
-- `UPDATE automacao_outbox SET ... WHERE id = $1` — apenas pelo id. Não conferia
-- o status, não conferia quem reivindicou, e não usava RETURNING, então o
-- chamador não tinha como saber se afetou zero linhas.
--
-- A consequência é a clássica: o lease de um worker vence, outro worker retoma
-- o trabalho, e o primeiro — que ainda estava no meio da chamada de IA, alheio
-- a tudo — volta e marca `concluido` por cima do dono atual. O paciente pode
-- receber a resposta duas vezes, ou nenhuma. `reivindicado_por` sozinho não
-- basta: o mesmo worker pode reivindicar de novo depois de perder a posse, e o
-- nome bateria.
--
-- `posse_token` é um contador monotônico por linha, incrementado a cada
-- reivindicação bem-sucedida. Quem reivindica leva o número da SUA posse; quem
-- conclui precisa apresentá-lo. Posse perdida deixa de ser ambígua: o token
-- antigo simplesmente não casa, o UPDATE afeta zero linhas, e o worker velho
-- descobre — em vez de sobrescrever em silêncio.
--
-- Por que `bigint DEFAULT 0` e não `uuid`: o valor precisa ser comparável e
-- crescente para que "token menor = posse antiga" seja verdade e possa virar
-- diagnóstico. Um identificador aleatório diria apenas "diferente", sem dizer
-- qual veio antes.
--
-- Aditiva por construção: só ADD COLUMN com DEFAULT, sem tocar em linha
-- existente além do valor padrão, sem DROP, sem alterar RLS ou GRANT — a
-- coluna herda o que `automacao_outbox` já tem (ver db/031). Trabalhos que já
-- estavam na fila continuam com token 0 e funcionam: a primeira reivindicação
-- depois desta migration os leva a 1.
--
-- Idempotente: `IF NOT EXISTS`. Rollback em 033_outbox_posse_token_rollback.sql.
--
-- Aplicar depois de 031.

BEGIN;

ALTER TABLE public.automacao_outbox
  ADD COLUMN IF NOT EXISTS posse_token bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.automacao_outbox.posse_token IS
  'Contador monotônico da posse do trabalho. Sobe a cada reivindicação; quem conclui precisa apresentar o token da posse corrente. Token divergente = posse perdida = o worker antigo não pode concluir, reagendar nem sobrescrever.';

COMMIT;
