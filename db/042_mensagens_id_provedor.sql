-- 042 — Rastreia o ID nativo do WhatsApp para mensagens de SAÍDA.
--
-- Contexto (achado do incidente de 2026-08-17, seguido do pedido do Dr.
-- Edson): a tela precisa mostrar toda mensagem de saída — da Serena, da
-- equipe pelo painel, E da equipe respondendo direto pelo WhatsApp — não só
-- o que passou pelo CRM. Hoje,
-- `src/integracoes/evolution-webhook.js` descarta TODO evento `fromMe:true`
-- como "eco do próprio envio" — mas isso só é verdade quando o envio saiu
-- PELO CRM. Quando a equipe responde direto pelo WhatsApp Web/app (o mesmo
-- número, outro dispositivo — WhatsApp sincroniza entre os dois), o evento
-- também chega como `fromMe:true`, e o CRM descartava exatamente essa
-- mensagem: a resposta real da equipe nunca aparecia na tela.
--
-- `id_externo` já existe e já é a chave de dedupe do lado de ENTRADA
-- (mensagem do paciente, mesmo ID nativo podendo chegar pelas duas portas
-- de ingresso). Para o lado de SAÍDA, `id_externo` já está ocupado por uma
-- chave determinística própria (só para as respostas da Serena, evita
-- envio duplicado sob concorrência — ver atendimento.js) — não dá para
-- reaproveitar sem colidir os dois propósitos.
--
-- `id_provedor` é a peça que falta: o ID nativo que a Evolution devolve
-- depois de um envio bem-sucedido (`entregarAoPaciente`, marcado à parte,
-- sem mexer em `id_externo`), no mesmo formato `whatsapp:<telefone>:<id>`
-- que `evolution-webhook.js` já usa do lado de entrada. Quando o eco
-- `fromMe:true` chega, o CRM compara por ESTE campo: já existe → é o eco do
-- que o próprio CRM acabou de mandar, ignora; não existe → é uma mensagem
-- que saiu por fora (WhatsApp Web/app direto), grava como enviada pela
-- equipe.
--
-- Aditiva e reversível: nenhuma coluna existente muda, nenhum dado se perde.
-- Rollback em 042_mensagens_id_provedor_rollback.sql.

BEGIN;

ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS id_provedor text;

COMMENT ON COLUMN mensagens.id_provedor IS
  'ID nativo do provedor (WhatsApp/Evolution) para mensagens de SAÍDA — formato whatsapp:<telefone>:<id>. Distinto de id_externo (entrada + chave determinística da Serena). Usado para reconhecer eco de fromMe:true e não duplicar, e para gravar resposta enviada fora do CRM (WhatsApp Web/app direto).';

-- Mesmo padrão do índice único parcial de id_externo (db/001_inbox.sql):
-- só protege quando o valor existe — a maioria das mensagens (todo o
-- histórico até esta migration, e toda mensagem de ENTRADA) nunca vai ter
-- id_provedor, e um índice único sem o WHERE trataria todo NULL como
-- colisão entre si (não é o caso — Postgres já trata NULL como distinto em
-- índice único comum, mas o WHERE aqui evita indexar linha nenhuma à toa).
CREATE UNIQUE INDEX IF NOT EXISTS mensagens_id_provedor_uk
  ON mensagens (id_provedor) WHERE id_provedor IS NOT NULL;

COMMIT;
