-- Rollback de 037_conversas_eventos_duraveis.sql
--
-- Remove as duas tabelas novas. Nenhuma tabela pré-existente é tocada.
-- Perde o histórico de eventos (aceitável: é um log de apoio ao chat ao
-- vivo, não a fonte de verdade — `mensagens` continua íntegra).
--
-- ORDEM OBRIGATÓRIA (BLOQUEADOR 2 da auditoria do PR #34 — leia antes de
-- rodar isto):
--
--   1. Rollback do CÓDIGO primeiro. Desde este hotfix, a ausência de
--      `conversas_eventos` (SQLSTATE 42P01, undefined_table) é um caso
--      ESPERADO em dois lugares: GET /api/conversas/:id/mensagens
--      (src/servidor/rotas-conversas.js#listarMensagens) degrada para só
--      as mensagens, e o replay do SSE (src/servidor/http.js, rota
--      /api/conversas/eventos) degrada para "sem histórico, mas segue ao
--      vivo". Uma versão do código ANTERIOR a este hotfix não tem esse
--      tratamento — rodar este rollback com o código velho ainda no ar
--      reintroduz o HTTP 500 que o hotfix corrigiu (a thread INTEIRA
--      sumia, não só os eventos operacionais).
--   2. Confirmar que o código revertido está de fato no ar (deploy
--      publicado, respondendo, sem erro novo no log) ANTES do passo 3.
--   3. SÓ ENTÃO decidir sobre o rollback do BANCO (este arquivo) — e mesmo
--      assim, avalie em qual dos três cenários abaixo a produção está.
--
-- TRÊS CENÁRIOS, TRÊS RISCOS DIFERENTES:
--
--   (a) ANTES do deploy da 037 (a tabela acabou de ser criada, nunca
--       recebeu escrita real): seguro, nada a perder.
--   (b) DEPOIS do deploy do código da 037, mas os passos 1-2 acima já
--       foram cumpridos (código antigo confirmado de volta): seguro quanto
--       ao HTTP 500; ainda assim PERDE o log de eventos gravado até aqui
--       (cenário c, abaixo, explica o alcance da perda).
--   (c) Já existem eventos gravados em `conversas_eventos` (produção
--       rodando por um tempo com a 037 aplicada): este DROP TABLE os
--       apaga IRREVERSIVELMENTE. `mensagens` continua intacta (é a fonte
--       de verdade), mas: (i) quem reconectar ao chat ao vivo perde a
--       possibilidade de replay do que aconteceu antes do DROP; (ii) o
--       histórico de "conversa assumida/devolvida/resolvida" que só vive
--       nesta tabela (Bug B, item 2 — ver rotas-conversas.js) some da
--       thread de qualquer conversa antiga. Isto é uma DECISÃO DO DONO do
--       sistema, não uma operação automática — não rode este arquivo no
--       cenário (c) sem confirmar explicitamente que essa perda é
--       aceitável.
--
-- Se a conclusão for "não vale o risco enquanto o hotfix estiver ativo em
-- produção", a alternativa correta é NÃO rodar este rollback — o schema
-- aditivo (037 sozinha) é inofensivo para o código antigo continuar
-- rodando (ele simplesmente nunca lê as tabelas novas).

BEGIN;

DROP TABLE IF EXISTS conversas_eventos_tickets;
DROP TABLE IF EXISTS conversas_eventos;

COMMIT;
