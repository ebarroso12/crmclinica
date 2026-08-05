-- Resumo de atendimento enviado à equipe.
--
-- A cada conversa encerrada, a equipe recebe no WhatsApp o que aconteceu: quem
-- era, o que procurava, se marcou. Sem isto, saber como foi o atendimento da
-- noite exige abrir o painel e ler conversa por conversa — o que ninguém faz
-- antes do primeiro café, e aí a informação chega tarde ou não chega.
--
-- A marca existe para o resumo sair uma vez só. Sem ela, o worker reenviaria o
-- mesmo texto a cada ciclo — de minuto em minuto, para os dois telefones.

BEGIN;

ALTER TABLE conversas
  ADD COLUMN IF NOT EXISTS resumo_enviado_em timestamptz;

COMMENT ON COLUMN conversas.resumo_enviado_em IS
  'Quando o resumo do atendimento foi enviado à equipe. Nulo = ainda não saiu.';

-- Índice parcial sobre o que a busca procura: as conversas ainda sem resumo.
-- As já resumidas são a maioria com o tempo, e não interessam à varredura.
CREATE INDEX IF NOT EXISTS conversas_sem_resumo
  ON conversas (ultima_msg_em)
  WHERE resumo_enviado_em IS NULL;

COMMIT;
