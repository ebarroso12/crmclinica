-- Rollback da 031 — outbox transacional do atendimento automático
--
-- **Não é para ser rodado por reflexo.** Está aqui porque uma migration sem
-- caminho de volta escrito é uma migration cujo caminho de volta será
-- improvisado às pressas, no pior momento possível.
--
-- O que este arquivo apaga:
--   • a fila inteira de trabalhos pendentes/em processamento da automação.
--
-- O que isso custa: qualquer mensagem de paciente que já esteja gravada em
-- `mensagens` mas cujo trabalho de resposta ainda não foi processado
-- (`status IN ('pendente', 'processando')`) fica SEM resposta automática
-- pendente — ninguém vai gerar nem entregar a resposta da Serena para ela.
-- A mensagem do paciente não é perdida (ela mora em `mensagens`, que este
-- rollback não toca), mas fica invisível para a automação até alguém notar
-- e responder manualmente pela tela de Conversas.
--
-- Antes de rodar, se houver trabalho pendente, prefira drenar a fila
-- primeiro (deixar o worker esvaziá-la, ou responder manualmente as
-- conversas com trabalho pendente) e só então aplicar o rollback.
--
-- Para ver o que seria perdido antes de decidir:
--
--   SELECT ao.id, ao.conversa_id, ao.status, ao.criado_em, c.contato_id
--     FROM automacao_outbox ao JOIN conversas c ON c.id = ao.conversa_id
--    WHERE ao.status IN ('pendente', 'processando')
--    ORDER BY ao.criado_em;
--
-- Reverter esta migration NÃO desfaz a remoção do `setImmediate` no código
-- (isso é uma mudança de aplicação, não de banco) — reverter só o SQL sem
-- reverter também o deploy do código deixaria o webhook tentando enfileirar
-- numa tabela que não existe mais, e todo POST em
-- /api/canais/whatsapp/eventos passaria a falhar. Reverta os dois juntos.

BEGIN;

DROP TABLE IF EXISTS public.automacao_outbox;

COMMIT;
