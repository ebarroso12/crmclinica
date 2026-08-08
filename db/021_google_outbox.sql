-- 021 — Outbox transacional da sincronia CRM → Google (P0-09, P0-10).
--
-- O agendamento e a intenção de sincronizar nascem na mesma transação: ou os
-- dois existem, ou nenhum existe. Sem isso, um agendamento gravado com o
-- Google fora do ar simplesmente não apareceria no calendário do médico, e
-- ninguém saberia.
--
-- Três ideias atravessam o arquivo:
--
--  1. **Vínculo completo.** Além do `google_evento_id` (014), o agendamento
--     guarda etag, estado de sincronia, versão local e origem da alteração.
--     O etag é o que permite detectar edição concorrente (412) em vez de
--     sobrescrever em silêncio.
--
--  2. **A fila é tabela, não memória.** Worker que reinicia retoma de onde
--     parou; duas cópias do worker dividem o trabalho com
--     `FOR UPDATE SKIP LOCKED` na reivindicação.
--
--  3. **Idempotência nomeada.** Cada entrada tem `chave_idempotencia` única
--     (agendamento + operação + versão): reenfileirar a mesma mudança não
--     duplica trabalho.

BEGIN;

-- ------------------------------------------------------------- agendamentos

ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS google_calendar_id text;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS google_etag text;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'pendente';
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS sync_version integer NOT NULL DEFAULT 0;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS last_sync_error text;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS origem_alteracao text NOT NULL DEFAULT 'crm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agendamentos_sync_status_check'
  ) THEN
    ALTER TABLE agendamentos
      ADD CONSTRAINT agendamentos_sync_status_check
      CHECK (sync_status IN ('ok', 'pendente', 'falhou', 'conflito'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agendamentos_origem_alteracao_check'
  ) THEN
    ALTER TABLE agendamentos
      ADD CONSTRAINT agendamentos_origem_alteracao_check
      CHECK (origem_alteracao IN ('crm', 'google'));
  END IF;
END $$;

-- Quem já tem evento no Google (014) já está espelhado: nasce `ok`, não
-- `pendente` — senão a primeira rodada do worker reescreveria tudo à toa.
UPDATE agendamentos SET sync_status = 'ok' WHERE google_evento_id IS NOT NULL;

-- ------------------------------------------------------------- google_outbox

CREATE TABLE IF NOT EXISTS google_outbox (
  id                  bigserial PRIMARY KEY,
  agendamento_id      bigint NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  operacao            text NOT NULL CHECK (operacao IN ('criar', 'atualizar', 'cancelar')),
  -- A versão do agendamento no momento do enfileiramento. Uma mudança mais
  -- nova torna esta entrada obsoleta: escrever estado velho por cima de
  -- estado novo é como a sincronização ressuscitaria horário já remarcado.
  versao              integer NOT NULL,
  chave_idempotencia  text NOT NULL UNIQUE,
  estado              text NOT NULL DEFAULT 'pendente'
                      CHECK (estado IN ('pendente', 'processando', 'ok', 'falhou', 'obsoleto')),
  tentativas          integer NOT NULL DEFAULT 0,
  proximo_retry_em    timestamptz,
  ultimo_erro         text,
  -- Marca de posse do worker: entrada "presa" (processando há tempo demais)
  -- denuncia worker morto no meio do lote.
  processando_desde   timestamptz,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  processado_em       timestamptz
);

-- O worker pergunta "o que está na hora de tentar?": o índice parcial cobre
-- exatamente essa pergunta, e só ela.
CREATE INDEX IF NOT EXISTS google_outbox_pendentes_idx
  ON google_outbox (proximo_retry_em)
  WHERE estado = 'pendente';

CREATE INDEX IF NOT EXISTS google_outbox_agendamento_idx
  ON google_outbox (agendamento_id);

-- ------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_outbox'] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_total_' || t, t);
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)',
          'app_total_' || t, t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO crmclinica_app', t || '_id_seq');
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_outbox'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
