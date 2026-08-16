-- 040 — Bloqueio de contato: lista gerenciável de telefones que não recebem
-- resposta automática da Serena.
--
-- Pedido do Edson: alguns contatos (ex.: paciente insatisfeito ameaçando
-- denúncia) precisam ser desviados do atendimento automático e direcionados,
-- de forma discreta e gentil, à secretária humana — sem que a automação
-- tente responder normalmente e sem que o bloqueio apareça para o contato.
--
-- Tabela simples e gerenciável pela própria equipe (aba "Bloqueio de
-- Contato" no app): nome, telefone, motivo. Hard delete de verdade quando
-- removido — ao contrário de `contatos` (soft delete), aqui não há
-- histórico de paciente para preservar; é só a lista de quem está bloqueado
-- agora. Editável e removível a qualquer momento (ver rotas-bloqueios.js).

BEGIN;

CREATE TABLE IF NOT EXISTS contatos_bloqueados (
  id            bigserial PRIMARY KEY,
  telefone      text NOT NULL UNIQUE,
  nome          text NOT NULL,
  motivo        text NOT NULL,
  criado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contatos_bloqueados ENABLE ROW LEVEL SECURITY;
ALTER TABLE contatos_bloqueados FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_contatos_bloqueados ON contatos_bloqueados;
CREATE POLICY app_contatos_bloqueados ON contatos_bloqueados
  FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON contatos_bloqueados TO crmclinica_app;
GRANT USAGE, SELECT ON SEQUENCE contatos_bloqueados_id_seq TO crmclinica_app;

COMMIT;

-- Verificação pós-aplicação (somente leitura):
--
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name = 'contatos_bloqueados';
--   -- esperado: 1
--
-- Rollback: db/040_contatos_bloqueados_rollback.sql
