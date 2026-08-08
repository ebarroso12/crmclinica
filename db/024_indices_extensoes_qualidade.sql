-- 024 — Índices justificados, extensões no schema próprio e visão de
-- qualidade cadastral (P2-01, P2-02, P2-10).
--
-- **Índice sem consulta nomeada é peso morto.** Como o EXPLAIN não roda contra
-- o banco de produção daqui, cada índice abaixo declara a consulta exata que
-- atende — a justificativa fica no arquivo, não na memória de quem escreveu.
--
-- **Extensão no schema `public` é convenção quebrada do Supabase**: o correto
-- é `extensions`. O move é guardado: só acontece se a extensão existir e já
-- não estiver lá.

BEGIN;

-- ---------------------------------------------------------------- P2-02 extensões

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
DECLARE e text;
BEGIN
  FOREACH e IN ARRAY ARRAY['btree_gist', 'pg_trgm'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_extension x JOIN pg_namespace n ON n.oid = x.extnamespace
      WHERE x.extname = e AND n.nspname = 'public'
    ) THEN
      EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', e);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- P2-01 índices

-- Consulta: o painel de sincronia conta e lista o que não está `ok`
-- (`WHERE sync_status <> 'ok'` em `contarPorStatusDeSincronia` e na aba de
-- pendências do painel).
CREATE INDEX IF NOT EXISTS agendamentos_sync_pendente_idx
  ON agendamentos (sync_status, last_synced_at)
  WHERE sync_status <> 'ok';

-- Consulta: a reconciliação varre os agendamentos vinculados ao Google
-- (`listarVinculadosParaReconciliar`: `WHERE google_evento_id IS NOT NULL`
-- ordenado por `last_synced_at`).
CREATE INDEX IF NOT EXISTS agendamentos_last_synced_idx
  ON agendamentos (last_synced_at)
  WHERE google_evento_id IS NOT NULL;

-- Consulta: "quem assinou esta versão?" e "esta pessoa assinou o vigente?"
-- (`listarAssinaturas`, `obterAssinaturaDoUsuario`, `obterAssinaturaDoContato`).
CREATE INDEX IF NOT EXISTS termo_assinaturas_usuario_idx
  ON termo_assinaturas (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS termo_assinaturas_contato_idx
  ON termo_assinaturas (contato_id) WHERE contato_id IS NOT NULL;

-- Consulta: a deduplicação procura pares pelo WhatsApp estruturado
-- (`buscarCandidatosADuplicata`: igualdade em ddd+numero entre ativos).
CREATE INDEX IF NOT EXISTS contatos_whatsapp_idx
  ON contatos (whatsapp_ddd, whatsapp_numero)
  WHERE whatsapp_numero IS NOT NULL AND excluido_em IS NULL;

-- ---------------------------------------------------------------- P2-10 qualidade

-- Grupos de telefone duplicado entre contatos ativos: a fila visível da
-- deduplicação (P1-09). É visão, não tabela: a verdade continua nas fichas.
CREATE OR REPLACE VIEW qualidade_cadastral_duplicidades AS
  SELECT telefone, count(*) AS fichas
  FROM contatos
  WHERE telefone IS NOT NULL AND excluido_em IS NULL
  GROUP BY telefone
  HAVING count(*) > 1;

GRANT SELECT ON qualidade_cadastral_duplicidades TO crmclinica_app;

COMMIT;
