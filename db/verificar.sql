-- Verificação rápida do estado do banco.
--
-- Cole no SQL Editor do Supabase e rode. Responde as perguntas que só o banco
-- pode responder:
--   1. quais tabelas existem e onde o RLS está ligado;
--   2. quais migrations deixaram rastro;
--   3. o que `anon` e `authenticated` alcançam em public;
--   4. o que alcançam no Storage — inclusive TRUNCATE, que o RLS não filtra;
--   5. se as funções têm search_path fixo;
--   6. quem está conectado, e se o RLS sequer é avaliado para essa conexão.
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
-- Verifica o OBJETO, não o registro. O ledger `supabase_migrations` só recebe
-- entrada quando a migration passa pela CLI; SQL aplicado por outro caminho
-- deixa o schema correto e o ledger desatualizado. Quem manda é o objeto.

SELECT '001_inbox' AS migration,
       to_regclass('public.conversas')  IS NOT NULL AS presente
UNION ALL SELECT '002_autenticacao_e_rls',
       to_regclass('public.sessoes')    IS NOT NULL
UNION ALL SELECT '003_contas',
       to_regclass('public.recuperacoes_senha') IS NOT NULL
UNION ALL SELECT '004_rate_limit',
       to_regclass('public.tentativas_autenticacao') IS NOT NULL
UNION ALL SELECT '005_qualificacao_jornada',
       to_regclass('public.lead_eventos') IS NOT NULL
UNION ALL SELECT '006_agenda',
       to_regclass('public.agendamentos') IS NOT NULL
UNION ALL SELECT '007_hardening',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname='app_usuario_atual');

-- ---------------------------------------------------------------- 3. exposição em public
--
-- Nenhuma linha aqui é o resultado desejado.

SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ', ') AS privilegios
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;

-- ---------------------------------------------------------------- 4. exposição no Storage
--
-- `truncate = true` é risco ATIVO, não latente: TRUNCATE é privilégio de tabela
-- e não passa pelo RLS. Não existe linha para o RLS filtrar quando o comando
-- apaga tudo de uma vez — RLS ligado com zero policies não protege disso.
--
-- Correção (precisa de privilégio que a role `postgres` não tem via API):
--   REVOKE ALL ON storage.objects, storage.buckets FROM anon, authenticated;
--
-- Sem tocar em s3_multipart_uploads*: são internas do Storage.

SELECT r.papel, t.tabela,
       has_table_privilege(r.papel, 'storage.' || t.tabela, 'SELECT')   AS sel,
       has_table_privilege(r.papel, 'storage.' || t.tabela, 'INSERT')   AS ins,
       has_table_privilege(r.papel, 'storage.' || t.tabela, 'DELETE')   AS del,
       has_table_privilege(r.papel, 'storage.' || t.tabela, 'TRUNCATE') AS truncate_ignora_rls
FROM unnest(ARRAY['objects','buckets']) AS t(tabela)
CROSS JOIN unnest(ARRAY['anon','authenticated']) AS r(papel)
WHERE to_regclass('storage.' || t.tabela) IS NOT NULL
ORDER BY r.papel, t.tabela;

-- ---------------------------------------------------------------- 5. search_path
--
-- Só as funções do produto. As centenas de `gbt_*` e `gtrgm_*` pertencem às
-- extensões btree_gist e pg_trgm e não devem ser alteradas: a correção delas é
-- mover as extensões para um schema próprio, o que recria os índices GiST.

SELECT p.proname AS funcao,
       COALESCE(array_to_string(p.proconfig, ','), 'MUTÁVEL') AS config
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('set_atualizado_em', 'limpar_sessoes_vencidas',
                    'limpar_recuperacoes_vencidas', 'limpar_tentativas_vencidas',
                    'app_usuario_atual')
ORDER BY p.proname;

-- ---------------------------------------------------------------- 6. quem conecta
--
-- A pergunta que reordena todas as outras. Enquanto a aplicação conectar como
-- dono das tabelas (ou com BYPASSRLS), o RLS não é avaliado para ela e nenhuma
-- policy vale — por mais bem escrita que seja.

SELECT current_user AS conectado_como,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS ignora_rls,
       (SELECT count(*) FROM pg_tables
         WHERE schemaname = 'public' AND tableowner = current_user) AS tabelas_proprias,
       (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'crmclinica_app') AS app_pode_conectar;
