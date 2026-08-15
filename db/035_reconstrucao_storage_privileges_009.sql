-- 035 — Reconstrução versionada da migration `009_storage_privilege_revoke`,
-- aplicada em produção FORA do Git (mesmo achado de db/010; ver
-- docs/PLANO-RECONSTRUCAO-008-009.md, seção 2.3).
--
-- NÃO REUSA O NÚMERO 009, pela mesma razão de 034 não reusar 008 (ver o
-- cabeçalho de 034_reconstrucao_funcoes_e_policies_008.sql).
--
-- EVIDÊNCIA (somente leitura, `ferramentas/extrair-definicoes-008.js`,
-- 2026-08-14): `information_schema.role_table_grants` com
-- `table_schema='storage'` para `anon`/`authenticated`/`PUBLIC` devolve
-- ZERO linhas. A revogação já está efetiva em produção — este arquivo é a
-- prova disso, mais uma revogação IDEMPOTENTE (revogar o que já não existe é
-- no-op) para quem reconstruir do zero.
--
-- `db/007_hardening.sql` (linha 27-57, já commitada) já registrou por que
-- este repositório NÃO CONSEGUE corrigir isto por SQL comum: `storage.*`
-- pertence a `supabase_storage_admin`, e a role `postgres` do projeto Supabase
-- não pode assumir essa role. `REVOKE` daqui, rodado como `postgres` ou
-- `crmclinica_app`, emite WARNING e não faz nada — o que é pior que não
-- tentar, porque a migration passaria com aparência de ter corrigido. Este
-- arquivo documenta essa mesma limitação e tenta mesmo assim, porque:
--   (a) se algum dia a role de conexão mudar para uma com privilégio sobre
--       `storage` (SQL Editor do painel, por exemplo), o mesmo arquivo já
--       serve;
--   (b) a consulta de verificação ao final é o que prova, hoje, que a
--       revogação de produção continua valendo — não depende de o REVOKE
--       ter tido efeito nesta execução.
--
-- Aplicar depois de 007 (mesma nota de ordem funcional de 034 — 009 nunca
-- foi renumerada em produção, então não há dependência de OUTRA migration
-- vindo depois dela que quebre com a ordem numérica atual, ao contrário de
-- 034/018).

BEGIN;

-- Idempotente: revogar privilégio que já não existe é no-op. Se a role de
-- conexão não tiver `GRANT` sobre `storage.*` (owner é `supabase_storage_admin`
-- — ver nota acima), isto pode emitir WARNING sem aplicar nada; não é erro
-- fatal, e a consulta de verificação abaixo é a prova real, não este REVOKE.
DO $$
BEGIN
  BEGIN
    REVOKE ALL ON storage.objects FROM anon, authenticated;
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'sem privilegio para revogar em storage.objects (esperado se a role de conexao nao for dona do schema storage) — a verificacao pos-aplicacao é a prova real';
  END;
  BEGIN
    REVOKE ALL ON storage.buckets FROM anon, authenticated;
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'sem privilegio para revogar em storage.buckets (esperado se a role de conexao nao for dona do schema storage) — a verificacao pos-aplicacao é a prova real';
  END;
END $$;

COMMIT;

-- Verificação pós-aplicação (somente leitura; deve devolver 0 linhas):
--
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'storage' AND grantee IN ('anon', 'authenticated', 'PUBLIC');
--
-- Rollback: não há — revogar privilégio não tem estado anterior conhecido
-- (perdido junto com a migration 009 original) e reconceder privilégio de
-- escrita em storage para anon/authenticated reintroduziria a vulnerabilidade
-- que db/007 documentou. Ver db/035_..._rollback.sql para o registro formal
-- dessa decisão.
