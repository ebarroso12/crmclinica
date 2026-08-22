# Alinhamento do registro de migrações (supabase_migrations)

**Diagnóstico (auditoria 2026-08):** o banco de produção tem tabelas criadas
até a migration `042`, mas o registro `supabase_migrations.schema_migrations`
só conhece até a `018`. As migrations `008` e `009` existem só no banco
(plano de reconstrução em `PLANO-RECONSTRUCAO-008-009.md`). Sintoma prático:
qualquer `supabase db push` futuro tentaria reaplicar dezenas de migrations
já aplicadas e quebraria nas `CREATE TABLE`/`CREATE POLICY` duplicadas.

**Princípio:** alinhar o REGISTRO à realidade — nunca reaplicar SQL que já
está no banco.

## Passo a passo (somente leitura até o último comando)

### 1. Conferir o que o banco acha que está aplicado

```bash
supabase migration list --linked
```

### 2. Conferir o que o repositório tem

```bash
ls db/ supabase/migrations/ 2>/dev/null | sort
```

### 3. Marcar como aplicadas as migrations que já estão no banco

Para cada versão presente em `db/` e ausente do registro, sem rodar o SQL
de novo:

```bash
supabase migration repair <versão> --status applied --linked
```

### 4. Verificar que o próximo push não faria nada

```bash
supabase db push --dry-run --linked
```

Saída esperada: nada a aplicar. Se aparecer SQL, PARE — significa que uma
migration do repositório nunca foi aplicada de verdade, e isso se resolve
lendo o SQL e conferindo objeto a objeto no banco, não com `--force`.

## O que NÃO fazer

- **Não** rodar `supabase db push` "para ver no que dá": cada `CREATE TABLE`
  duplicada aborta a transação no meio e deixa o registro pior do que estava.
- **Não** apagar linhas do registro para "forçar reaplicação".
- **Não** recriar 008/009 à mão fora do processo do
  `PLANO-RECONSTRUCAO-008-009.md` (extração pelo catálogo, nunca SQL
  adivinhado).
