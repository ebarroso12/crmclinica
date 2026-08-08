-- 029 — mínimo privilégio nas tabelas de operação (019/020).
--
-- Na aplicação em produção, a validação pós-migration encontrou
-- `crmclinica_app` com DELETE em `operacao_heartbeats` e
-- `auditoria_exportacoes` — privilégio que NENHUM dos dois arquivos concedeu.
-- Ele veio de DEFAULT PRIVILEGES da instância: tabela nova nasce com mais do
-- que o script pediu. Este arquivo revoga o excedente de forma versionada —
-- nunca por SQL avulso — e repete as revogações defensivas de PUBLIC/anon/
-- authenticated para as duas tabelas.
--
-- O que cada tabela realmente precisa:
--
--   • `operacao_heartbeats` — o worker faz UPSERT da própria linha e o
--     diagnóstico lê. SELECT, INSERT, UPDATE. Apagar prova de vida não é
--     operação do produto.
--   • `auditoria_exportacoes` — trilha de quem exportou o quê. Nasce, é lida,
--     e o fechamento da exportação a atualiza. Trilha não se apaga: DELETE
--     fora, no mesmo espírito do audit_log.
--
-- Escopo estrito: SOMENTE estas duas tabelas. Idempotente: revogar o que já
-- não existe é no-op; aplicar duas vezes não muda nada.

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operacao_heartbeats', 'auditoria_exportacoes'] LOOP
    -- Guard de existência: em ambiente restaurado sem as 019/020, esta
    -- migration não inventa nada — simplesmente passa.
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM crmclinica_app', t);
      -- Reafirma o mínimo necessário — a migration fica legível sozinha:
      -- o estado final é SELECT, INSERT, UPDATE, e nada além.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO crmclinica_app', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['operacao_heartbeats', 'auditoria_exportacoes'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMIT;
