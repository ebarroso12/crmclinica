-- Rollback de 038_mensagens_confirmacao_de_entrega.sql
--
-- Remove as duas colunas. Volta ao estado em que o sistema não distingue
-- "não enviei" de "já enviei" — reintroduz o bug que 038 existe para fechar.
-- Só faz sentido em banco descartável de teste, para provar reversibilidade.
--
-- RISCO CLÍNICO REAL se isto rodar em produção com dados de verdade
-- (BLOQUEADOR 2 da auditoria do PR #34): sem `entregue_em`, a automação da
-- outbox (src/dominio/automacao-outbox.js) perde a marca que impede
-- reenviar uma resposta já entregue — o job seguinte relê
-- `respostaAnterior` (src/dominio/atendimento.js) e REENVIA ao paciente
-- algo que ele já recebeu. É exatamente o achado real que motivou a 038
-- (ver o cabeçalho de 038_mensagens_confirmacao_de_entrega.sql). Este DROP
-- COLUMN apaga as confirmações já gravadas IRREVERSIVELMENTE — depois de
-- rodar, não há como recuperar "isto já foi entregue".
--
-- Mesma ordem do rollback da 037 (ver o cabeçalho de
-- 037_conversas_eventos_duraveis_rollback.sql para o raciocínio completo):
--   1. rollback do CÓDIGO primeiro, confirmado no ar;
--   2. só então decidir sobre o rollback do BANCO;
--   3. se já existe alguma linha com `entregue_em` preenchido (produção
--      rodando com a 038 aplicada), isto é uma DECISÃO DO DONO do sistema
--      — não uma operação automática. Confirme explicitamente antes de
--      rodar.

BEGIN;

ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entregue_em;
ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entrega_indeterminada;

COMMIT;
