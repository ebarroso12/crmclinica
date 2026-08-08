-- 022 — Sincronia Google → CRM: cursor incremental, sombra de eventos
-- externos e conflitos (P0-11, P0-12).
--
-- Três tabelas, três respostas:
--
--  1. `google_sincronia_estado` — "até onde já li?". O syncToken do Google é
--     o cursor da leitura incremental; ele só avança quando a ÚLTIMA página
--     chega — gravar no meio perderia as páginas restantes num crash. O 410
--     (cursor velho demais) marca `precisa_full_sync` e a próxima leitura
--     refaz a janela inteira.
--
--  2. `google_eventos_externos` — "o que existe lá que não é meu?". Eventos
--     que o médico cria no celular viram sombra aqui: a agenda os considera
--     na hora de oferecer horário, sem nunca importá-los como agendamento
--     (um churrasco do médico não é consulta).
--
--  3. `google_sincronia_conflitos` — "onde os dois lados mudaram juntos?".
--     Conflito é decidido por gente: o registro guarda os dois lados e a
--     resolução, e o índice único parcial impede conflito duplicado aberto.

BEGIN;

CREATE TABLE IF NOT EXISTS google_sincronia_estado (
  id                    bigserial PRIMARY KEY,
  calendario            text NOT NULL UNIQUE,
  next_sync_token       text,
  precisa_full_sync     boolean NOT NULL DEFAULT true,
  ultimo_full_sync_em   timestamptz,
  ultimo_incremental_em timestamptz,
  ultimo_erro           text,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS google_eventos_externos (
  id                     bigserial PRIMARY KEY,
  calendario             text NOT NULL,
  google_evento_id       text NOT NULL,
  status                 text NOT NULL DEFAULT 'confirmado'
                         CHECK (status IN ('confirmado', 'cancelado')),
  inicio                 timestamptz,
  fim                    timestamptz,
  etag                   text,
  titulo                 text,
  atualizado_no_google_em timestamptz,
  visto_em               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calendario, google_evento_id)
);

-- A agenda pergunta "quais sombras ocupam este período?": o índice parcial
-- cobre a pergunta e ignora as canceladas.
CREATE INDEX IF NOT EXISTS google_eventos_externos_periodo_idx
  ON google_eventos_externos (inicio, fim)
  WHERE status = 'confirmado';

CREATE TABLE IF NOT EXISTS google_sincronia_conflitos (
  id               bigserial PRIMARY KEY,
  agendamento_id   bigint REFERENCES agendamentos(id) ON DELETE SET NULL,
  google_evento_id text,
  tipo             text NOT NULL CHECK (tipo IN (
                     'edicao_concorrente', 'cancelado_no_google',
                     'recriado_no_google', 'evento_sem_dono',
                     'divergencia_reconciliacao')),
  detalhe_crm      jsonb,
  detalhe_google   jsonb,
  estado           text NOT NULL DEFAULT 'aberto'
                   CHECK (estado IN ('aberto', 'resolvido', 'ignorado')),
  resolucao        text CHECK (resolucao IN ('crm_vence', 'google_vence', 'manual')),
  resolvido_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  resolvido_em     timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now()
);

-- Um conflito aberto por (agendamento, evento, tipo): a reconciliação roda
-- várias vezes, e cada rodada atualiza o registro em vez de empilhar cópias.
CREATE UNIQUE INDEX IF NOT EXISTS google_sincronia_conflitos_aberto_uk
  ON google_sincronia_conflitos (agendamento_id, google_evento_id, tipo)
  WHERE estado = 'aberto';

CREATE INDEX IF NOT EXISTS google_sincronia_conflitos_estado_idx
  ON google_sincronia_conflitos (estado, criado_em);

-- ------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_sincronia_estado', 'google_eventos_externos', 'google_sincronia_conflitos'] LOOP
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
  FOREACH t IN ARRAY ARRAY['google_sincronia_estado', 'google_eventos_externos', 'google_sincronia_conflitos'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
