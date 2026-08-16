-- 038 — Confirmação de entrega em `mensagens`.
--
-- Achado real (auditoria desta sessão, não hipótese): quando o trabalho da
-- outbox que gerou uma resposta automática volta para a fila DEPOIS de a
-- resposta já ter saído ao paciente — banco pisca entre enviar e concluir,
-- ou o processo morre sem desligamento gracioso — o próximo ciclo relê a
-- resposta gravada (`respostaAnterior`, em `src/dominio/atendimento.js`) e a
-- REENVIA, porque `entrega_falhou` (db/032) só registra FALHA. Não existe
-- hoje nenhuma marca positiva de "isto já foi entregue" nem de "isto ficou
-- indeterminado" — o sistema sabe distinguir "não enviei" de "não sei se
-- enviei", mas não distingue "não enviei" de "já enviei".
--
-- Aditiva: duas colunas novas, sem tocar nada existente.

BEGIN;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS entregue_em timestamptz;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS entrega_indeterminada boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.mensagens.entregue_em IS
  'Quando o canal confirmou o envio (resposta bem-sucedida de canal.enviar). NULL = ainda não confirmado. Uma retentativa da automação para a MESMA resposta consulta esta coluna antes de enviar de novo — nunca reenvia o que já está marcado aqui.';

COMMENT ON COLUMN public.mensagens.entrega_indeterminada IS
  'true quando o canal estourou o tempo ou a conexão caiu DEPOIS de possivelmente ter aceitado a mensagem — não se sabe se chegou. Nunca reenviado automaticamente (mesma regra de automacao-outbox.js para o job); a tela precisa mostrar isto ao invés de "enviada" ou "falhou".';

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'mensagens' AND column_name IN ('entregue_em', 'entrega_indeterminada');
--   -- esperado: 2 linhas
--
-- Aplicar depois de 032 (mensagens.entrega_falhou já precisa existir para o
-- código que lê as duas colunas juntas fazer sentido, embora tecnicamente
-- esta migration não dependa de 032 no SQL em si).
--
-- Rollback: db/038_mensagens_confirmacao_de_entrega_rollback.sql
