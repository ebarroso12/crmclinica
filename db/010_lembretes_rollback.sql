-- Rollback da 010 — lembretes de agendamento
--
-- **Não é para ser rodado por reflexo.** Está aqui porque uma migration sem
-- caminho de volta escrito é uma migration cujo caminho de volta será
-- improvisado às pressas, no pior momento possível.
--
-- O que este arquivo apaga:
--   • a fila inteira de lembretes — inclusive o registro do que já saiu;
--   • o opt-out dos contatos, ou seja, **quem pediu para não receber mais
--     mensagens volta a receber**.
--
-- O segundo item é o que importa. Perder a fila custa reenfileirar
-- (`npm run lembretes -- sincronizar` refaz tudo). Perder o opt-out custa mandar
-- mensagem para quem pediu explicitamente para parar — e isso não se desfaz.
--
-- Antes de rodar, guarde o opt-out:
--
--   COPY (SELECT id, telefone, lembretes_optout_em, lembretes_optout_motivo
--           FROM contatos WHERE lembretes_optout)
--     TO '/tmp/optout.csv' CSV HEADER;
--
-- O que o rollback NÃO apaga: o `audit_log`. A aplicação não tem DELETE nessa
-- tabela e este arquivo não abre exceção — o histórico de quem pediu opt-out e
-- de que lembretes saíram continua lá, e é dele que a recuperação sai.

BEGIN;

DROP TABLE IF EXISTS public.lembretes;

ALTER TABLE public.contatos
  DROP COLUMN IF EXISTS lembretes_optout,
  DROP COLUMN IF EXISTS lembretes_optout_em,
  DROP COLUMN IF EXISTS lembretes_optout_motivo;

COMMIT;
