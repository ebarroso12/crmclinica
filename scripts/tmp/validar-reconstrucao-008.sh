#!/bin/bash
# Validação estrutural, única, de que a reconstrução (034/035/036) aplica
# em ordem funcional correta contra um banco DESCARTÁVEL — nunca toca
# crmclinica_test (usado por npm run test:pg) nem produção.
set -euo pipefail

readonly RAIZ="/mnt/c/crmclinica"
readonly BANCO="crmclinica_validar_008_descartavel"

cd "$RAIZ"
service postgresql start >/dev/null 2>&1 || true
sleep 2

echo "=== recriando $BANCO ==="
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE IF EXISTS $BANCO;'"
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE $BANCO OWNER postgres;'"

# PostgreSQL local NÃO tem as roles que o Supabase provisiona automaticamente
# (anon/authenticated/service_role/supabase_storage_admin) — sem isto, 007
# falha em "role anon does not exist" antes mesmo de chegar em 034. Criadas
# aqui só para esta base descartável, nunca em crmclinica_test nem produção.
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c \"
  DO \\\$\\\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
      CREATE ROLE supabase_storage_admin NOLOGIN;
    END IF;
  END \\\$\\\$;
\""
# schema storage também não existe localmente — 035 tenta REVOKE nele e
# precisa que ele exista para o teste ser honesto (senão o REVOKE nem roda).
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c 'CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;'"
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c 'CREATE TABLE IF NOT EXISTS storage.objects (id bigint);'"
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c 'CREATE TABLE IF NOT EXISTS storage.buckets (id bigint);'"
# auth.jwt() também é provisionado pelo Supabase, não por um Postgres comum —
# current_usuario_id()/is_admin_master()/is_colaborador() chamam auth.jwt().
# Recriada aqui com a MESMA definição que o Supabase usa (lê a mesma GUC que
# current_app_role() já lê) — não é invenção: é a definição pública e estável
# do próprio Supabase, necessária só para o CREATE FUNCTION não falhar por
# schema ausente.
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c 'CREATE SCHEMA IF NOT EXISTS auth;'"
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d $BANCO -c \"
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS \\\$\\\$
    SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  \\\$\\\$;
\""

# Ordem FUNCIONAL de reconstrução (não numérica estrita) — ver o cabeçalho de
# db/034_reconstrucao_funcoes_e_policies_008.sql para a explicação completa
# do bloqueio de ordem contra 018.
readonly ORDEM=(
  "db/001_inbox.sql"
  "db/002_autenticacao_e_rls.sql"
  "db/003_contas.sql"
  "db/004_rate_limit.sql"
  "db/005_qualificacao_jornada.sql"
  "db/006_agenda.sql"
  "db/007_hardening.sql"
  "db/034_reconstrucao_funcoes_e_policies_008.sql"
  "db/035_reconstrucao_storage_privileges_009.sql"
  "db/010_lembretes.sql"
  "db/011_serena.sql"
  "db/036_reconstrucao_policies_restrict_legado.sql"
  "db/012_serena_voz.sql"
  "db/013_serena_horario.sql"
  "db/014_google_agenda.sql"
  "db/015_resumo_conversa.sql"
  # ACHADO SEPARADO, NAO RELACIONADO A 008/009: 016 cria triggers que chamam
  # audit_user_changes() via EXECUTE FUNCTION, mas só 017 tem o CREATE (OR
  # REPLACE) FUNCTION dela em git. Ordem numerica estrita (016 antes de 017)
  # falha "function audit_user_changes() does not exist". Em producao isso
  # nunca apareceu porque audit_user_changes() ja existia desde a 008
  # original (fora do git). Invertido AQUI só para a validação poder
  # continuar;Reported no relatorio final, nao corrigido (fora do escopo de
  # 008/009, exigiria decisao do dono sobre renumerar 016/017).
  "db/017_redacao_segredos_auditoria.sql"
  "db/016_auditoria_de_exclusao.sql"
  "db/018_restringir_funcoes_security_definer.sql"
  "db/019_operacao_health_heartbeats.sql"
  "db/020_auditoria_exportacao_controlada.sql"
  "db/021_google_outbox.sql"
  "db/022_google_sincronia_inbound.sql"
  "db/023_usuarios_contatos.sql"
  "db/024_indices_extensoes_qualidade.sql"
  "db/025_crm_fluxo.sql"
  "db/026_analitica.sql"
  "db/027_ia_gateway.sql"
  "db/028_avaliacoes_notificacoes.sql"
  "db/029_restringir_delete_operacao.sql"
  "db/030_system_heartbeats.sql"
  "db/031_automacao_outbox.sql"
  "db/032_mensagens_marca_entrega_falhou.sql"
  "db/033_outbox_posse_token.sql"
)

echo "=== aplicando ${#ORDEM[@]} migrations em ordem funcional ==="
aplicadas=0
for arquivo in "${ORDEM[@]}"; do
  if [ ! -f "$RAIZ/$arquivo" ]; then
    echo "ERRO: $arquivo nao existe" >&2
    exit 1
  fi
  echo "--> $arquivo"
  if ! su - postgres -c "psql -v ON_ERROR_STOP=1 --quiet -d $BANCO -f '$RAIZ/$arquivo'"; then
    echo "FALHOU EM: $arquivo (aplicadas antes: $aplicadas de ${#ORDEM[@]})" >&2
    exit 1
  fi
  aplicadas=$((aplicadas + 1))
done
echo "=== APLICADAS: $aplicadas de ${#ORDEM[@]} — SEM ERRO ==="

echo ""
echo "=== VERIFICACOES POS-APLICACAO (somente leitura) ==="
echo -n "funcoes das crm008_* (esperado 10): "
su - postgres -c "psql -v ON_ERROR_STOP=1 -d $BANCO -tAc \"SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('current_app_role','current_usuario_id','is_backend','is_gestor_or_admin','is_atendente','is_admin','can_access_conversa','can_access_agendamento','is_admin_master','is_colaborador');\""
echo -n "policies crm008_* (esperado 53): "
su - postgres -c "psql -v ON_ERROR_STOP=1 -d $BANCO -tAc \"SELECT count(*) FROM pg_policies WHERE policyname LIKE 'crm008%';\""
echo -n "policies restrict_* (esperado 13): "
su - postgres -c "psql -v ON_ERROR_STOP=1 -d $BANCO -tAc \"SELECT count(*) FROM pg_policies WHERE policyname LIKE 'restrict_%';\""
echo -n "grants execute de crmclinica_app em current_usuario_id/is_admin_master/is_colaborador (esperado 3, de db/018): "
su - postgres -c "psql -v ON_ERROR_STOP=1 -d $BANCO -tAc \"SELECT count(*) FROM information_schema.role_routine_grants WHERE grantee='crmclinica_app' AND routine_name IN ('current_usuario_id','is_admin_master','is_colaborador');\""

echo ""
echo "=== limpando banco descartavel ==="
su - postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE $BANCO;'"

echo "=== OK ==="
