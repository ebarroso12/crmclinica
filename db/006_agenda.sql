-- crmclinica — agenda assistida
--
-- A regra central deste arquivo é uma só: **o conflito é impedido pelo banco**,
-- não pela aplicação.
--
-- Checar disponibilidade em JavaScript e depois inserir tem uma janela entre a
-- leitura e a escrita. Duas pessoas marcando o mesmo horário ao mesmo tempo —
-- a recepção pelo painel e o paciente pelo WhatsApp — passam pela checagem juntas
-- e gravam as duas. A constraint de exclusão fecha essa janela: a segunda
-- transação falha, sempre, sem depender de ordem, de lock manual ou de sorte.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- profissionais

CREATE TABLE IF NOT EXISTS profissionais (
  id             bigserial PRIMARY KEY,
  nome           text NOT NULL,
  especialidade  text,
  registro       text,
  cor            text NOT NULL DEFAULT '#0e8fa1',
  -- Duração padrão do atendimento, usada para sugerir horários.
  duracao_min    int NOT NULL DEFAULT 30 CHECK (duracao_min BETWEEN 5 AND 480),
  usuario_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profissionais_ativo_idx ON profissionais (ativo, nome);

-- ---------------------------------------------------------------- disponibilidade
--
-- Janelas recorrentes por dia da semana. `0` = domingo, seguindo `EXTRACT(DOW)`
-- do PostgreSQL, para a comparação não precisar de conversão.

CREATE TABLE IF NOT EXISTS disponibilidades (
  id               bigserial PRIMARY KEY,
  profissional_id  bigint NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  dia_semana       int NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio      time NOT NULL,
  hora_fim         time NOT NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),

  -- Uma janela que termina antes de começar não é janela.
  CONSTRAINT disponibilidade_ordem CHECK (hora_fim > hora_inicio)
);

CREATE INDEX IF NOT EXISTS disponibilidades_prof_idx ON disponibilidades (profissional_id, dia_semana);

-- ---------------------------------------------------------------- bloqueios
--
-- Férias, feriado, almoço, reunião: períodos em que o profissional não atende
-- mesmo dentro da janela recorrente.

CREATE TABLE IF NOT EXISTS agenda_bloqueios (
  id               bigserial PRIMARY KEY,
  -- Sem profissional, o bloqueio vale para a clínica inteira (feriado).
  profissional_id  bigint REFERENCES profissionais(id) ON DELETE CASCADE,
  inicio           timestamptz NOT NULL,
  fim              timestamptz NOT NULL,
  motivo           text,
  criado_por       bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bloqueio_ordem CHECK (fim > inicio)
);

CREATE INDEX IF NOT EXISTS bloqueios_periodo_idx ON agenda_bloqueios (profissional_id, inicio, fim);

-- ---------------------------------------------------------------- agendamentos

CREATE TABLE IF NOT EXISTS agendamentos (
  id               bigserial PRIMARY KEY,
  profissional_id  bigint NOT NULL REFERENCES profissionais(id) ON DELETE RESTRICT,
  contato_id       bigint NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,
  -- Vínculo com o lead e a conversa que originaram o agendamento: é o que faz
  -- a agenda abrir a conversa certa, e a conversa abrir a agenda certa.
  lead_id          bigint REFERENCES leads(id) ON DELETE SET NULL,
  conversa_id      bigint REFERENCES conversas(id) ON DELETE SET NULL,

  inicio           timestamptz NOT NULL,
  fim              timestamptz NOT NULL,

  status           text NOT NULL DEFAULT 'agendado'
                     CHECK (status IN ('agendado', 'confirmado', 'compareceu', 'faltou', 'cancelado')),
  tipo             text NOT NULL DEFAULT 'consulta'
                     CHECK (tipo IN ('consulta', 'retorno', 'avaliacao', 'procedimento', 'bloqueio')),
  observacoes      text,
  local            text,

  -- Confirmação e comparecimento, para a régua de lembretes e as métricas de falta.
  confirmado_em    timestamptz,
  cancelado_em     timestamptz,
  cancelado_motivo text,

  criado_por       bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agendamento_ordem CHECK (fim > inicio),

  -- **O coração da agenda.** Dois agendamentos do mesmo profissional não podem
  -- ter horários que se sobrepõem. `&&` é sobreposição de intervalo; `'[)'` faz
  -- 14:00–15:00 e 15:00–16:00 serem vizinhos, não conflito.
  --
  -- Cancelado sai da regra: o horário volta a ficar livre.
  CONSTRAINT agendamentos_sem_conflito EXCLUDE USING gist (
    profissional_id WITH =,
    tstzrange(inicio, fim, '[)') WITH &&
  ) WHERE (status <> 'cancelado')
);

CREATE INDEX IF NOT EXISTS agendamentos_periodo_idx ON agendamentos (inicio, fim);
CREATE INDEX IF NOT EXISTS agendamentos_profissional_idx ON agendamentos (profissional_id, inicio);
CREATE INDEX IF NOT EXISTS agendamentos_contato_idx ON agendamentos (contato_id, inicio DESC);
CREATE INDEX IF NOT EXISTS agendamentos_conversa_idx ON agendamentos (conversa_id) WHERE conversa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agendamentos_status_idx ON agendamentos (status, inicio);

-- ---------------------------------------------------------------- triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profissionais', 'agendamentos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_upd ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_upd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION set_atualizado_em()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profissionais', 'disponibilidades', 'agenda_bloqueios', 'agendamentos'] LOOP
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
  FOREACH t IN ARRAY ARRAY['profissionais', 'disponibilidades', 'agenda_bloqueios', 'agendamentos'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
