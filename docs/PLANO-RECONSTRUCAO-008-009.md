# Plano de reconstrução versionada — migrations 008 e 009

**Problema:** as migrations `008_crmclinica_security_hardening` e
`009_storage_privilege_revoke` foram aplicadas fora do Git (documentado em
`db/010_lembretes.sql`). O repositório **depende** do que elas criaram —
`current_app_role()`, `current_usuario_id()`, `audit_user_changes()`, as
funções `is_*` e as 53 policies `crm008_*` — mas não as define. Uma restauração
a partir só de `db/` produz um banco quebrado.

**Princípio deste plano:** nenhum SQL é adivinhado. Tudo sai do catálogo do
banco (`pg_get_functiondef`, `pg_policies`, `information_schema`), extraído por
ferramenta versionada e conferido antes de virar migration.

## 1. Ferramenta de extração (versionada nesta branch)

`ferramentas/extrair-definicoes-008.js` — somente leitura; imprime JSON com as
definições reais das 6 funções, as policies `crm008_*` e os privilégios de
storage. É reprodutível por qualquer pessoa com a URL do banco:

```bash
node ferramentas/extrair-definicoes-008.js > extracao.json
```

## 2. Snapshot verificado (extraído de produção em 2026-08-08 00:48 UTC)

### 2.1 As seis funções da 008 — definições REAIS (via `pg_get_functiondef`)

```sql
CREATE OR REPLACE FUNCTION public.current_app_role()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(NULLIF((current_setting('request.jwt.claims',true)::jsonb->>'app_role'),''),
                 'deny')
$function$;

CREATE OR REPLACE FUNCTION public.is_backend()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='backend' $function$;

CREATE OR REPLACE FUNCTION public.is_gestor_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role() IN ('gestor','admin') $function$;

CREATE OR REPLACE FUNCTION public.is_atendente()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='atendente' $function$;

CREATE OR REPLACE FUNCTION public.current_usuario_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select u.id
  from public.usuarios u
  where lower(u.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
    and u.ativo = true
  limit 1
$function$;
```

`audit_user_changes()` também foi extraída na íntegra; sua definição vigente
é a da **migration 017** (que a redefiniu removendo `senha_hash` e
`totp_segredo_cifrado` do snapshot) — ou seja, a versão do Git já é a
autoridade para ela, e a reconstrução deve usar `db/017_...` como fonte.

**Achados da extração, a resolver na reconstrução (não são invenção — estão no
banco):**

- `current_usuario_id()` referencia `u.ativo`, coluna que **não existe** no
  esquema versionado (`usuarios` usa `situacao`). A função funciona hoje porque
  nada mais consulta esse caminho com JWT de e-mail; a reconstrução deve
  registrar essa discrepância e decidir com o dono se corrige (`situacao =
  'ativo'`) ou preserva o texto atual.
- `current_app_role()` usa `search_path TO 'public', 'pg_temp'`, diferente do
  padrão `''` do hardening da 007 — preservar como está, mudança é decisão
  separada.

### 2.2 As policies `crm008_*`

53 policies em 18 tabelas (inventário completo na saída da ferramenta):

`agenda_bloqueios` 2 · `agendamentos` 4 · `audit_log` 2 · `contatos` 4 ·
`conversa_etiquetas` 4 · `conversas` 4 · `disponibilidades` 2 · `etiquetas` 2 ·
`eventos_recebidos` 1 · `lead_eventos` 4 · `leads` 4 · `mensagens` 4 ·
`notas_internas` 4 · `profissionais` 2 · `recuperacoes_senha` 1 · `sessoes` 4 ·
`tentativas_autenticacao` 1 · `usuarios` 4.

Padrão (exemplo real): `crm008_b_s` em `agenda_bloqueios`, `SELECT` para
`{crmclinica_app}` com `qual = (is_backend() OR is_gestor_or_admin() OR
is_atendente())`. O `pg_policies` fornece `cmd`, `roles`, `qual` e `with_check`
de todas — o SQL de recriação é mecânico a partir da extração.

### 2.3 Evidência da 009 (storage)

Consulta a `information_schema.role_table_grants` com `table_schema='storage'`
para `anon`/`authenticated`/`PUBLIC`: **zero linhas** em 2026-08-08. A revogação
da 009 está efetiva; a reconstrução dela é um script de revogação idempotente
(revogar o que já não existe é no-op) + esta mesma consulta como verificação.

## 3. Passos para a reconstrução (exige autorização do dono)

1. Rodar a ferramenta e guardar o JSON como artefato da tarefa.
2. Gerar `db/0XX_reconstrucao_008.sql` (número a reservar com o dono; 018–024
   estão livres) contendo: as 6 funções exatamente como extraídas (com as duas
   discrepâncias do item 2.1 decididas e comentadas), e as 53 policies gerado
   a partir de `pg_policies` (`DROP POLICY IF EXISTS` + `CREATE POLICY`).
3. Gerar `db/0XX+1_reconstrucao_009.sql`: revogações de storage idempotentes,
   com o aviso de que `storage.*` pertence a `supabase_storage_admin` e partes
   podem exigir o SQL Editor do painel (mesma nota da 007).
4. Adicionar as funções e uma amostra das policies a `ESPERADO` e
   `FUNCOES_COM_SEARCH_PATH` em `bin/verificar-banco.js`.
5. Validar em banco DESCARTÁVEL: aplicar `db/` completo do zero e rodar
   `npm run verificar-banco` — é o teste de que a restauração ficou inteira.
6. Só então marcar as novas migrations como "espelho do aplicado" (nunca
   reaplicar em produção sem diff prévio: `pg_get_functiondef` de novo e
   comparar).

## 4. O que este plano NÃO faz

- Não aplica nada em produção (as migrations de reconstrução nascem para
  restauração e ambientes novos; produção já as tem).
- Não altera o comportamento das funções sem decisão registrada do dono
  (as discrepâncias do item 2.1 são decisão, não correção silenciosa).
