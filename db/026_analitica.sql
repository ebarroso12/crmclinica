-- 026 — Camada analítica: eventos de produto e views agregadas.
--
-- Implementa o dicionário oficial de métricas (docs/METRICAS.md). Cada view
-- carrega no comentário o nome da métrica que materializa — número sem
-- definição não é exibido, e view sem definição não existe.
--
-- Decisões:
--
--   1. **Views, não materialized views.** O volume da clínica é de centenas de
--      linhas por dia; recomputar na leitura custa menos que administrar
--      refresh. Se um dia doer, materializar é mudança local.
--   2. **Fuso na view.** O banco grava timestamptz (UTC); "dia" e "hora" são
--      convertidos aqui para America/Sao_Paulo, como o dicionário manda. O
--      navegador nunca converte fuso.
--   3. **Dado sintético fora.** Contatos da faixa reservada de ensaio
--      (5516900000xx) não entram em nenhuma view agregada.
--   4. **`eventos_analiticos` é append-only** para eventos de produto que não
--      têm tabela própria. A chave única deduplica reprocessamento.
--   5. **Toda view é `security_invoker`.** View comum executa com o dono e
--      furaria o RLS das tabelas-base; com security_invoker, quem consulta a
--      view precisa do próprio direito de ler as tabelas. PUBLIC, anon e
--      authenticated são revogados explicitamente; SELECT fica só com
--      crmclinica_app (quando o papel existe).

BEGIN;

-- ------------------------------------------------------ eventos de produto

CREATE TABLE IF NOT EXISTS eventos_analiticos (
  id           bigserial PRIMARY KEY,
  nome         text NOT NULL,
  entidade     text,
  entidade_id  bigint,
  propriedades jsonb,
  -- Dedup de reprocessamento: quem emite pode carimbar uma chave própria.
  chave        text,
  ocorrido_em  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT eventos_analiticos_chave_unica UNIQUE (chave)
);

COMMENT ON TABLE eventos_analiticos IS
  'Eventos de produto para análise. Append-only; chave única deduplica reprocessamento. Nunca carrega conteúdo clínico.';

CREATE INDEX IF NOT EXISTS eventos_analiticos_nome_idx
  ON eventos_analiticos (nome, ocorrido_em);

-- ---------------------------------------------------------------- helpers

-- A condição de dado sintético, repetida nas views. A faixa é a documentada
-- no dicionário: telefones de ensaio começam com 5516900000.
-- (Postgres não tem "macro"; a repetição é o preço da view autocontida.)

-- ---------------------------------------------------------------- leads

-- METRICAS.md: leads_novos / leads_por_origem (fluxo, por dia de São Paulo)
--
-- A tabela `leads` NÃO tem `criado_em` — foi exatamente essa referência que
-- derrubou a primeira aplicação desta migration em produção. O nascimento do
-- lead vem da JORNADA: o primeiro evento de `lead_eventos` é o registro mais
-- antigo que existe sobre ele. Lead sem evento nenhum (criado por caminho que
-- não registra jornada) usa `atualizado_em` como aproximação declarada — sumir
-- do denominador seria pior que aproximar.
CREATE OR REPLACE VIEW vw_leads_por_dia WITH (security_invoker = true) AS
WITH primeiro_evento AS (
  SELECT e.lead_id, min(e.criado_em) AS criado_em
  FROM lead_eventos e
  GROUP BY e.lead_id
)
SELECT
  (coalesce(pe.criado_em, l.atualizado_em) AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  l.origem,
  count(*) AS total
FROM leads l
LEFT JOIN primeiro_evento pe ON pe.lead_id = l.id
JOIN contatos ct ON ct.id = l.contato_id
WHERE ct.telefone NOT LIKE '5516900000%'
GROUP BY 1, 2;

COMMENT ON VIEW vw_leads_por_dia IS 'METRICAS.md: leads_novos e leads_por_origem. Dia do PRIMEIRO evento da jornada (fallback: atualizado_em), America/Sao_Paulo.';

-- METRICAS.md: leads_por_estagio (fotografia — estoque, não fluxo)
CREATE OR REPLACE VIEW vw_funil_estagios WITH (security_invoker = true) AS
SELECT l.estagio, count(*) AS total
FROM leads l
JOIN contatos ct ON ct.id = l.contato_id
WHERE ct.telefone NOT LIKE '5516900000%'
GROUP BY 1;

COMMENT ON VIEW vw_funil_estagios IS 'METRICAS.md: leads_por_estagio. FOTOGRAFIA do momento — não somar com métricas de período.';

-- METRICAS.md: motivo_perda
CREATE OR REPLACE VIEW vw_motivos_perda WITH (security_invoker = true) AS
SELECT
  (e.criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  coalesce(nullif(trim(l.perdido_motivo), ''), 'sem motivo registrado') AS motivo,
  count(*) AS total
FROM lead_eventos e
JOIN leads l ON l.id = e.lead_id
JOIN contatos ct ON ct.id = l.contato_id
WHERE e.tipo = 'estagio' AND e.para = 'perdido'
  AND ct.telefone NOT LIKE '5516900000%'
GROUP BY 1, 2;

COMMENT ON VIEW vw_motivos_perda IS 'METRICAS.md: motivo_perda. Perdas por dia e motivo.';

-- ---------------------------------------------------------------- conversas

-- METRICAS.md: tempo_primeira_resposta (base por conversa; mediana e p90 na aplicação)
CREATE OR REPLACE VIEW vw_primeira_resposta WITH (security_invoker = true) AS
SELECT
  c.id AS conversa_id,
  (min(entrada.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  min(entrada.criado_em) AS primeiro_inbound,
  min(saida.criado_em)   AS primeira_resposta,
  extract(epoch FROM (min(saida.criado_em) - min(entrada.criado_em))) / 60.0 AS minutos
FROM conversas c
JOIN contatos ct ON ct.id = c.contato_id
JOIN mensagens entrada ON entrada.conversa_id = c.id
  AND entrada.direcao = 'entrada' AND NOT entrada.privada
LEFT JOIN mensagens saida ON saida.conversa_id = c.id
  AND saida.direcao = 'saida' AND NOT saida.privada AND saida.tipo <> 'sistema'
  AND saida.criado_em > entrada.criado_em
WHERE ct.telefone NOT LIKE '5516900000%'
GROUP BY c.id;

COMMENT ON VIEW vw_primeira_resposta IS 'METRICAS.md: tempo_primeira_resposta. Base por conversa; minutos nulo = ainda sem resposta (entra em backlog, não na mediana).';

-- METRICAS.md: picos_horario (hora e dia da semana no fuso da clínica)
CREATE OR REPLACE VIEW vw_picos_horario WITH (security_invoker = true) AS
SELECT
  extract(dow  FROM (m.criado_em AT TIME ZONE 'America/Sao_Paulo'))::int AS dia_semana,
  extract(hour FROM (m.criado_em AT TIME ZONE 'America/Sao_Paulo'))::int AS hora,
  count(*) AS entradas
FROM mensagens m
JOIN conversas c ON c.id = m.conversa_id
JOIN contatos ct ON ct.id = c.contato_id
WHERE m.direcao = 'entrada' AND NOT m.privada
  AND ct.telefone NOT LIKE '5516900000%'
GROUP BY 1, 2;

COMMENT ON VIEW vw_picos_horario IS 'METRICAS.md: picos_horario. Entradas por dia da semana (0=domingo) e hora, America/Sao_Paulo.';

-- ---------------------------------------------------------------- agenda

-- METRICAS.md: agendamentos_novos / cancelamentos / faltas / comparecimento
CREATE OR REPLACE VIEW vw_agenda_por_dia WITH (security_invoker = true) AS
SELECT
  (a.inicio AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  a.status,
  count(*) AS total
FROM agendamentos a
JOIN contatos ct ON ct.id = a.contato_id
WHERE ct.telefone NOT LIKE '5516900000%'
GROUP BY 1, 2;

COMMENT ON VIEW vw_agenda_por_dia IS 'METRICAS.md: agendamentos por status e dia da CONSULTA (não da criação).';

-- ---------------------------------------------------------------- Serena

-- METRICAS.md: handoff_serena e silencio_serena, a partir da trilha de auditoria
CREATE OR REPLACE VIEW vw_serena_por_dia WITH (security_invoker = true) AS
SELECT
  (a.criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  a.acao,
  coalesce(a.detalhe->>'motivo', '—') AS motivo,
  count(*) AS total
FROM audit_log a
WHERE a.entidade = 'conversa'
  AND a.acao IN ('assumida_por_humano', 'escalonada', 'automacao_silenciada',
                 'respondida_pela_automacao', 'resposta_nao_entregue')
GROUP BY 1, 2, 3;

COMMENT ON VIEW vw_serena_por_dia IS 'METRICAS.md: handoff_serena, silencio_serena, respostas_automacao, duplicacao_ia (via detalhe).';

-- ---------------------------------------------------------------- RLS

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    ALTER TABLE public.eventos_analiticos ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS app_registro ON public.eventos_analiticos;
    -- Append-only como o audit_log: a aplicação registra e lê; não edita nem apaga.
    CREATE POLICY app_registro ON public.eventos_analiticos
      FOR INSERT TO crmclinica_app WITH CHECK (true);
    DROP POLICY IF EXISTS app_leitura ON public.eventos_analiticos;
    CREATE POLICY app_leitura ON public.eventos_analiticos
      FOR SELECT TO crmclinica_app USING (true);

    GRANT SELECT, INSERT ON public.eventos_analiticos TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE eventos_analiticos_id_seq TO crmclinica_app;

    GRANT SELECT ON vw_leads_por_dia, vw_funil_estagios, vw_motivos_perda,
      vw_primeira_resposta, vw_picos_horario, vw_agenda_por_dia, vw_serena_por_dia
      TO crmclinica_app;
  END IF;
END $$;

-- PUBLIC recebe privilégio implícito em objetos novos em algumas instalações;
-- a revogação é EXPLÍCITA e incondicional. anon/authenticated só se existirem.
REVOKE ALL ON public.eventos_analiticos FROM PUBLIC;
REVOKE ALL ON vw_leads_por_dia, vw_funil_estagios, vw_motivos_perda,
  vw_primeira_resposta, vw_picos_horario, vw_agenda_por_dia, vw_serena_por_dia
  FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.eventos_analiticos FROM %I', r);
      EXECUTE format('REVOKE ALL ON vw_leads_por_dia, vw_funil_estagios, vw_motivos_perda, vw_primeira_resposta, vw_picos_horario, vw_agenda_por_dia, vw_serena_por_dia FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
