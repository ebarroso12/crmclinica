-- 037 — Chat ao vivo durável: log de eventos em Postgres + tickets de SSE.
--
-- Pendência 4 do comando mestre. Problema que isto resolve: o chat ao vivo
-- (`/api/conversas/eventos`, SSE) hoje vive só em memória do processo
-- (`src/servidor/eventos-conversas.js`) — sem persistência, sem cursor, sem
-- replay. Uma aba que cai e reconecta perde tudo que aconteceu no intervalo;
-- reiniciar o processo apaga o histórico inteiro; não há como distinguir
-- "nada aconteceu" de "perdi eventos".
--
-- Duas tabelas:
--
--   1. `conversas_eventos` — log append-only, `id bigserial` como CURSOR
--      MONOTÔNICO. Nunca UPDATE, nunca DELETE de linha individual (só
--      retenção por idade, se algum dia for necessária — não implementada
--      aqui, fora do escopo desta pendência).
--
--   2. `conversas_eventos_tickets` — a rota SSE não pode carregar o token de
--      sessão na querystring (EventSource não manda Authorization; o jeito
--      antigo de contornar isso, `?token=`, expõe o JWT de sessão inteiro em
--      log de acesso, histórico do navegador, Referer). Em vez disso: uma
--      chamada POST autenticada (Authorization normal) pede um TICKET —
--      opaco, de uso único, validade curta (30s) — e só o ticket vai na URL
--      do EventSource. Mesmo padrão de `recuperacoes_senha` (hash guardado,
--      nunca o valor bruto; `usado_em` consumido atomicamente com
--      `RETURNING`, mesma correção que `redefinirSenha` recebeu nesta sessão).

BEGIN;

CREATE TABLE IF NOT EXISTS conversas_eventos (
  id            bigserial PRIMARY KEY,
  conversa_id   bigint NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  tipo          text NOT NULL CHECK (tipo IN (
                  'mensagem_recebida', 'mensagem_enviada', 'status_entrega',
                  'conversa_assumida', 'conversa_devolvida', 'conversa_resolvida',
                  'erro'
                )),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- Índice composto para o replay: "eventos desta conversa acima deste cursor".
-- A PK já cobre "acima deste cursor" sozinha; este índice existe para quando
-- o replay filtra por conversa_id também (várias conversas de uma vez, no
-- caso comum de reconectar com a tela de Conversas mostrando várias linhas).
CREATE INDEX IF NOT EXISTS idx_conversas_eventos_conversa_id
  ON conversas_eventos (conversa_id, id);

ALTER TABLE conversas_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversas_eventos FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_conversas_eventos_insere ON conversas_eventos;
CREATE POLICY app_conversas_eventos_insere ON conversas_eventos
  FOR INSERT TO crmclinica_app WITH CHECK (true);

DROP POLICY IF EXISTS app_conversas_eventos_le ON conversas_eventos;
CREATE POLICY app_conversas_eventos_le ON conversas_eventos
  FOR SELECT TO crmclinica_app USING (true);

-- Sem UPDATE nem DELETE concedidos: log append-only de verdade, não só por
-- convenção de código. Uma tentativa de alterar/apagar uma LINHA falha no
-- privilégio, antes mesmo de qualquer policy.
--
-- TRUNCATE é concedido — mesmo raciocínio já registrado em db/007_hardening
-- (linha ~30-37): TRUNCATE é privilégio de TABELA, não passa pelo RLS, e é
-- uma operação diferente de DELETE linha a linha. Sem TRUNCATE aqui, o
-- padrão já usado por toda a suíte de testes (`TRUNCATE conversas ...
-- CASCADE`, que precisa alcançar `conversas_eventos` por causa da FK)
-- quebra com "permission denied" — comprovado ao rodar `npm run test:pg`
-- contra este arquivo antes desta correção.
GRANT SELECT, INSERT, TRUNCATE ON conversas_eventos TO crmclinica_app;
GRANT USAGE, SELECT ON SEQUENCE conversas_eventos_id_seq TO crmclinica_app;

CREATE TABLE IF NOT EXISTS conversas_eventos_tickets (
  id            bigserial PRIMARY KEY,
  hash_ticket   text NOT NULL UNIQUE,
  usuario_id    bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel         text NOT NULL,
  expira_em     timestamptz NOT NULL,
  usado_em      timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversas_eventos_tickets_hash
  ON conversas_eventos_tickets (hash_ticket);

ALTER TABLE conversas_eventos_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversas_eventos_tickets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_conversas_eventos_tickets ON conversas_eventos_tickets;
CREATE POLICY app_conversas_eventos_tickets ON conversas_eventos_tickets
  FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);

-- TRUNCATE pelo mesmo motivo de conversas_eventos acima — a FK para
-- usuarios(id) alcança esta tabela quando os testes truncam usuarios em cascata.
GRANT SELECT, INSERT, UPDATE, TRUNCATE ON conversas_eventos_tickets TO crmclinica_app;
GRANT USAGE, SELECT ON SEQUENCE conversas_eventos_tickets_id_seq TO crmclinica_app;

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name IN ('conversas_eventos','conversas_eventos_tickets');
--   -- esperado: 2
--
-- Retenção: NÃO implementada nesta migration. `conversas_eventos` cresce sem
-- limite; `conversas_eventos_tickets` também (linhas usadas/expiradas nunca
-- são removidas). Ambas seguem o mesmo padrão de `limpar_sessoes_vencidas`/
-- `limpar_recuperacoes_vencidas` (db/007) — uma função de limpeza análoga é
-- trabalho futuro, fora do escopo desta pendência (que pede durabilidade e
-- replay, não política de retenção).
--
-- Rollback: db/037_conversas_eventos_duraveis_rollback.sql
