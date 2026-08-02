-- crmclinica — qualificação e jornada do lead
--
-- Duas ideias governam este arquivo:
--
--  1. **Qualificação é comercial, não clínica.** Interesse, forma de pagamento e
--     preferência de horário ficam no lead. Nada aqui é prontuário, e nada aqui
--     autoriza tratar sintoma, diagnóstico ou histórico de saúde como campo de CRM.
--
--  2. **A jornada é um histórico, não um estado.** Guardar só o estágio atual
--     apagaria a pergunta que a clínica mais faz: "quando esse lead esfriou, e
--     depois do quê?". Cada mudança vira uma linha que não se reescreve.

-- ---------------------------------------------------------------- qualificação

-- O que a pessoa procura. Texto livre porque cada clínica nomeia à sua maneira,
-- e uma lista fechada obrigaria a inventar categoria na hora do atendimento.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interesse text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS especialidade text;

-- Primeira consulta ou retorno. `null` = ainda não perguntado, que é diferente
-- de "não é primeira consulta".
ALTER TABLE leads ADD COLUMN IF NOT EXISTS primeira_consulta boolean;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS pagamento text
  CHECK (pagamento IN ('particular', 'convenio', 'indefinido'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS convenio_nome text;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS urgencia text
  CHECK (urgencia IN ('imediata', 'semanas', 'pesquisando', 'indefinida'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS disponibilidade text
  CHECK (disponibilidade IN ('manha', 'tarde', 'noite', 'qualquer', 'indefinida'));

-- Origem detalhada e UTM. Sem isso não há como responder "de onde vêm os leads
-- que viram consulta" — a pergunta que decide onde investir.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS origem_detalhe text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content text;

-- Score de 0 a 100, calculado do que se sabe. Guardado junto do motivo: um número
-- sozinho não se explica para a equipe nem se audita depois.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score int NOT NULL DEFAULT 0
  CHECK (score BETWEEN 0 AND 100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_motivos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_calculado_em timestamptz;

-- Quando a equipe fixa a temperatura na mão, o cálculo automático para de mexer.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperatura_manual boolean NOT NULL DEFAULT false;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualificado_em timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS perdido_motivo text;

CREATE INDEX IF NOT EXISTS leads_score_idx ON leads (score DESC, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS leads_utm_idx ON leads (utm_source, utm_campaign);

-- ---------------------------------------------------------------- jornada

CREATE TABLE IF NOT EXISTS lead_eventos (
  id           bigserial PRIMARY KEY,
  lead_id      bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversa_id  bigint REFERENCES conversas(id) ON DELETE SET NULL,
  tipo         text NOT NULL CHECK (tipo IN (
                 'primeiro_contato', 'qualificacao', 'estagio', 'temperatura',
                 'proposta', 'agendamento', 'confirmacao', 'comparecimento',
                 'retorno', 'perdido', 'nota'
               )),
  de           text,
  para         text,
  detalhe      jsonb,
  -- Quem causou: uma pessoa da equipe, a automação ou o próprio contato.
  origem       text NOT NULL DEFAULT 'sistema'
                 CHECK (origem IN ('equipe', 'automacao', 'contato', 'sistema')),
  usuario_id   bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_eventos_lead_idx ON lead_eventos (lead_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS lead_eventos_tipo_idx ON lead_eventos (tipo, criado_em DESC);

-- ---------------------------------------------------------------- RLS

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'lead_eventos') THEN
    EXECUTE 'ALTER TABLE public.lead_eventos ENABLE ROW LEVEL SECURITY';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE 'DROP POLICY IF EXISTS app_total_lead_eventos ON public.lead_eventos';
      EXECUTE 'CREATE POLICY app_total_lead_eventos ON public.lead_eventos
                 FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)';
      EXECUTE 'GRANT SELECT, INSERT ON public.lead_eventos TO crmclinica_app';
      EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE lead_eventos_id_seq TO crmclinica_app';
    END IF;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.lead_eventos FROM %I', r);
    END IF;
  END LOOP;
END $$;
