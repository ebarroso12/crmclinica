-- 025 — Fluxo comercial do CRM: aging do kanban, dono do lead, tarefas
-- idempotentes, fila de SLA, resumo interno e formulário de pré-consulta.
--
-- Sobre a numeração: a última migration do repositório é a 017. Os números
-- 018–024 estão reservados para as outras frentes de trabalho (segurança/
-- auditoria e agenda/usuários); esta frente recebeu 025–028. O salto é
-- proposital e segue o precedente da 010, que também pulou números e explica
-- o porquê no cabeçalho.
--
-- O que cada bloco resolve:
--
--   1. **Aging** — um card parado 20 dias em "Qualificando" parece igual a um
--      de ontem. `estagio_desde` registra desde quando o lead está na coluna.
--   2. **Dono e próximo passo** — lead sem responsável é lead de ninguém, e
--      "de ninguém" é o estado em que leads morrem. As colunas existem aqui;
--      a obrigatoriedade é regra de serviço, onde a mensagem de erro ensina.
--   3. **Tarefas** — o sino de 15 dias precisa ser idempotente: o worker roda
--      a cada minuto, e sem chave única a mesma inatividade viraria 1440
--      tarefas por dia. A chave é determinística; a segunda inserção não cria.
--   4. **SLA** — `aguardando_resposta_desde` marca desde quando o paciente
--      fala por último. Preenchida na entrada, limpa na saída não-privada.
--   5. **Resumo interno** — ao encerrar, a conversa ganha um resumo que fica
--      NO CRM. Ele nunca é enviado ao paciente; é leitura da equipe.
--   6. **Formulário de pré-consulta** — a FK NOT NULL para `agendamentos` é a
--      garantia estrutural da regra do produto: sem agendamento, não existe
--      formulário. O serviço ainda exige status confirmado por cima.

BEGIN;

-- ---------------------------------------------------------------- 1. aging

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS estagio_desde timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.leads.estagio_desde IS
  'Desde quando o lead está no estágio atual. Atualizada a cada mudança de estágio; é a base do aging do kanban.';

-- ------------------------------------------- 2. dono e próximo passo

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS proprietario_id bigint REFERENCES public.usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proximo_passo text,
  ADD COLUMN IF NOT EXISTS proximo_passo_em timestamptz;

COMMENT ON COLUMN public.leads.proprietario_id IS
  'Quem responde pelo lead. A obrigatoriedade ao avançar de estágio é do serviço, não do banco — aqui só a integridade.';
COMMENT ON COLUMN public.leads.proximo_passo IS
  'A próxima ação combinada, nas palavras da equipe. Card sem próximo passo é card que ninguém sabe tocar.';

CREATE INDEX IF NOT EXISTS leads_proprietario_idx
  ON public.leads (proprietario_id)
  WHERE proprietario_id IS NOT NULL;

-- ---------------------------------------------------------------- 3. tarefas

CREATE TABLE IF NOT EXISTS tarefas (
  id            bigserial PRIMARY KEY,

  -- A chave é o que torna a criação idempotente: `acompanhamento_15d` do lead
  -- 42 no ciclo de 2026-08-20 tem UMA chave possível. Reprocessar não duplica.
  chave         text NOT NULL,

  tipo          text NOT NULL CHECK (tipo IN ('acompanhamento_15d', 'sla_estourado', 'manual')),
  titulo        text NOT NULL,
  detalhe       text,

  lead_id       bigint REFERENCES public.leads(id)     ON DELETE CASCADE,
  conversa_id   bigint REFERENCES public.conversas(id) ON DELETE CASCADE,
  contato_id    bigint REFERENCES public.contatos(id)  ON DELETE CASCADE,

  devida_em     timestamptz NOT NULL DEFAULT now(),
  criado_em     timestamptz NOT NULL DEFAULT now(),

  concluida_em  timestamptz,
  concluida_por bigint REFERENCES public.usuarios(id) ON DELETE SET NULL,

  CONSTRAINT tarefas_chave_unica UNIQUE (chave)
);

COMMENT ON TABLE tarefas IS
  'Tarefas para a equipe (sino). A chave única é a idempotência: o worker pode rodar quantas vezes for — a tarefa nasce uma vez.';

-- O sino mostra o que está aberto; o resto é histórico.
CREATE INDEX IF NOT EXISTS tarefas_abertas_idx
  ON tarefas (devida_em)
  WHERE concluida_em IS NULL;

CREATE INDEX IF NOT EXISTS tarefas_lead_idx ON tarefas (lead_id) WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------- 4. SLA

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS aguardando_resposta_desde timestamptz;

COMMENT ON COLUMN public.conversas.aguardando_resposta_desde IS
  'Desde quando o paciente fala por último sem resposta da clínica. Preenchida na entrada, limpa na saída não-privada. Nula = ninguém esperando.';

CREATE INDEX IF NOT EXISTS conversas_aguardando_idx
  ON public.conversas (aguardando_resposta_desde)
  WHERE aguardando_resposta_desde IS NOT NULL;

-- ------------------------------------------------------ 5. resumo interno

ALTER TABLE public.conversas
  ADD COLUMN IF NOT EXISTS resumo_interno text,
  ADD COLUMN IF NOT EXISTS resumo_interno_em timestamptz;

COMMENT ON COLUMN public.conversas.resumo_interno IS
  'Resumo do atendimento gerado ao encerrar: nome, telefone, síntese, agendou sim/não, pendência. INTERNO — nunca é enviado ao paciente.';

-- ------------------------------------------- 6. formulário de pré-consulta

CREATE TABLE IF NOT EXISTS formularios_pre_consulta (
  id              bigserial PRIMARY KEY,

  -- NOT NULL de propósito: formulário sem agendamento não existe. É a regra
  -- "pré-consulta só depois do agendamento confirmado" gravada na estrutura.
  agendamento_id  bigint NOT NULL REFERENCES public.agendamentos(id) ON DELETE CASCADE,
  contato_id      bigint NOT NULL REFERENCES public.contatos(id)     ON DELETE CASCADE,

  token           text NOT NULL,

  enviado_em      timestamptz,
  respondido_em   timestamptz,
  -- Respostas do paciente. Conteúdo potencialmente clínico: nunca entra em
  -- prompt de IA nem em relatório automático — leitura humana apenas.
  respostas       jsonb,

  criado_em       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT formularios_token_unico UNIQUE (token),
  -- Um formulário por agendamento: reenviar não recria, reaproveita.
  CONSTRAINT formularios_um_por_agendamento UNIQUE (agendamento_id)
);

COMMENT ON TABLE formularios_pre_consulta IS
  'Formulário de pré-consulta, condicionado ao agendamento confirmado. Um por agendamento; o serviço recusa criar sem status confirmado.';

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    FOREACH t IN ARRAY ARRAY['tarefas', 'formularios_pre_consulta'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format('CREATE POLICY app_trabalho ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I_id_seq TO crmclinica_app', t);
    END LOOP;
  END IF;
END $$;

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['tarefas', 'formularios_pre_consulta'] LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMIT;
