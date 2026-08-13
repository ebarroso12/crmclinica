-- 032_mensagens_marca_entrega_falhou.sql
--
-- Comando 7, achado A-3 da auditoria independente: a barreira final
-- (atendimento.js, `podeEntregarAgora`/`entregarAoPaciente`) pode bloquear a
-- entrega de uma resposta que a automação JÁ GRAVOU — a mensagem existe no
-- banco antes da barreira reler o controle. Sem marca nenhuma na própria
-- linha, essa mensagem ficava indistinguível de uma resposta que realmente
-- saiu: a tela de Conversas mostrava as duas do mesmo jeito, e ninguém
-- enxergava que o paciente não recebeu nada.
--
-- Aditiva por construção: só ADD COLUMN, com DEFAULT, sem tocar em nenhuma
-- linha existente além do valor padrão (toda mensagem já gravada nasce como
-- "entregue" — não há como reconstruir o passado, e não faríamos isso às
-- cegas mesmo se houvesse). Não redefine RLS nem GRANT: `mensagens` já tem
-- os dois (ver db/001_inbox.sql); coluna nova herda o que a tabela já tinha.

BEGIN;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS entrega_falhou boolean NOT NULL DEFAULT false;

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS entrega_falhou_motivo text;

COMMENT ON COLUMN public.mensagens.entrega_falhou IS
  'true quando a barreira final (ou uma falha de envio já registrada) impediu esta mensagem de chegar ao paciente. Nunca setado a partir de entrada do paciente.';
COMMENT ON COLUMN public.mensagens.entrega_falhou_motivo IS
  'motivo técnico da falha de entrega (ex.: fora_do_horario, falha_ao_reler_controle, serena_desligada) — nunca conteúdo de conversa.';

COMMIT;
