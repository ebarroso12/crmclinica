-- Verificação rápida do estado do banco.
--
-- Cole no SQL Editor do Supabase e rode. Responde três perguntas:
--   1. quais tabelas existem;
--   2. onde o RLS está ligado;
--   3. o que `anon` e `authenticated` conseguem alcançar.
--
-- Equivalente ao `npm run verificar-banco`, para quando não há a connection
-- string à mão.

-- ---------------------------------------------------------------- 1. tabelas e RLS

SELECT
  t.tablename                                   AS tabela,
  CASE WHEN t.rowsecurity THEN 'ligado' ELSE 'DESLIGADO' END AS rls,
  COALESCE(p.politicas, 0)                      AS politicas
FROM pg_tables t
LEFT JOIN (
  SELECT tablename, count(*) AS politicas
  FROM pg_policies WHERE schemaname = 'public'
  GROUP BY tablename
) p ON p.tablename = t.tablename
WHERE t.schemaname = 'public'
ORDER BY t.rowsecurity, t.tablename;

-- ---------------------------------------------------------------- 2. migrations aplicadas
--
-- Cada linha "presente" confirma que a migration correspondente rodou.

SELECT '001_inbox' AS migration,
       to_regclass('public.conversas')  IS NOT NULL AS presente
UNION ALL SELECT '002_autenticacao_e_rls',
       to_regclass('public.sessoes')    IS NOT NULL
UNION ALL SELECT '003_contas',
       to_regclass('public.recuperacoes_senha') IS NOT NULL
UNION ALL SELECT '004_rate_limit',
       to_regclass('public.tentativas_autenticacao') IS NOT NULL
UNION ALL SELECT '005_qualificacao_jornada',
       to_regclass('public.lead_eventos') IS NOT NULL;

-- ---------------------------------------------------------------- 3. exposição pela API
--
-- Nenhuma linha aqui é o resultado desejado: significa que `anon` e
-- `authenticated` não alcançam tabela nenhuma pela API REST automática.

SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ', ') AS privilegios
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;

-- ---------------------------------------------------------------- 4. papel da aplicação

SELECT rolname AS papel, rolcanlogin AS pode_logar
FROM pg_roles WHERE rolname = 'crmclinica_app';
