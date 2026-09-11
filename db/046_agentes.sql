-- 046 — Agentes de atendimento configuráveis (docs/AGENTES.md).
--
-- O CRM passa a hospedar agentes completos montados pela tela — perfil,
-- trabalho, treinamentos, configurações, ações de inatividade e canais —, no
-- formato do construtor de agentes que a equipe usava fora. O primeiro é o
-- Agente Alpins (configuracao/agentes/alpins.json), que nasce desativado.
--
-- O que cada peça garante:
--
--   agentes                    — o agente. Enumerações e limites espelham
--                                src/dominio/agentes/regras.js (há teste que
--                                compara os dois). `configuracoes` é objeto
--                                jsonb; a aplicação mescla com os padrões.
--   agente_comportamentos      — histórico do comportamento (restaurar versão).
--   agente_treinamentos        — o conhecimento do agente.
--   agente_acoes_inatividade   — "se o cliente não responder em N min, faça X".
--   agente_canais              — qual instância da Evolution é de qual agente.
--                                Único por (canal, lower(instancia)): a busca do
--                                dono não diferencia maiúsculas, então a
--                                unicidade também não pode diferenciar.
--   conversas.agente_id        — de quem é a conversa. NULL = clínica, e o
--                                caminho da clínica não muda em nada.
--
-- ON DELETE RESTRICT em conversas.agente_id, NÃO SET NULL: apagar um agente
-- com SET NULL transformaria as conversas dele em conversas da clínica, e a
-- mensagem seguinte do cliente iria para a Serena e sairia pelo NÚMERO DA
-- CLÍNICA. Agente sai de uso por status = 'desativado', nunca por DELETE.
--
-- Nenhum conteúdo de conversa entra nestas tabelas: treinamento e
-- comportamento são texto escrito pela equipe, não pelo cliente.
--
-- ORDEM OBRIGATÓRIA: aplicar esta migration ANTES de publicar o código que a
-- usa. O código novo lê conversas.agente_id em toda leitura de conversa;
-- publicado antes, derruba o inbox da clínica.
--
-- Bloqueio: o ADD COLUMN em `conversas` pega um lock exclusivo curto (coluna
-- nula, sem default: só metadado, e a validação da FK percorre uma coluna
-- toda nula). Aplicar fora do pico.
--
-- Mesmo desenho de RLS/GRANT de db/045: a aplicação (crmclinica_app) lê e
-- escreve, o RBAC no código decide quem pode o quê; anon e authenticated não
-- enxergam nada. Atômica e aditiva: nenhuma tabela ou coluna existente é
-- alterada ou removida. Rollback em 046_agentes_rollback.sql.

BEGIN;

-- ---------------------------------------------------------------- agentes

CREATE TABLE IF NOT EXISTS agentes (
  id                bigserial PRIMARY KEY,
  slug              text NOT NULL CONSTRAINT agentes_slug_uk UNIQUE
                      CONSTRAINT agentes_slug_formato CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  nome              text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 80),
  descricao         text CHECK (char_length(descricao) <= 160),
  status            text NOT NULL DEFAULT 'desativado'
                      CHECK (status IN ('ativo', 'treinamento', 'desativado')),
  comunicacao       text NOT NULL DEFAULT 'normal'
                      CHECK (comunicacao IN ('formal', 'normal', 'descontraida')),
  comportamento     text NOT NULL DEFAULT '' CHECK (char_length(comportamento) <= 20000),
  finalidade        text NOT NULL DEFAULT 'suporte'
                      CHECK (finalidade IN ('suporte', 'vendas', 'pessoal')),
  empresa_nome      text CHECK (char_length(empresa_nome) <= 120),
  empresa_site      text CHECK (char_length(empresa_site) <= 300),
  empresa_descricao text CHECK (char_length(empresa_descricao) <= 2000),
  -- NULL = modelo padrão do catálogo (ia_modelos).
  provedor          text CHECK (char_length(provedor) <= 40),
  modelo            text CHECK (char_length(modelo) <= 120),
  configuracoes     jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(configuracoes) = 'object'),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------ agente_comportamentos

CREATE TABLE IF NOT EXISTS agente_comportamentos (
  id            bigserial PRIMARY KEY,
  agente_id     bigint NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  comportamento text NOT NULL CHECK (char_length(comportamento) <= 20000),
  criado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agente_comportamentos_agente_idx
  ON agente_comportamentos (agente_id, criado_em DESC, id DESC);

-- -------------------------------------------------- agente_treinamentos

CREATE TABLE IF NOT EXISTS agente_treinamentos (
  id            bigserial PRIMARY KEY,
  agente_id     bigint NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  tipo          text NOT NULL DEFAULT 'texto'
                  CHECK (tipo IN ('texto', 'website', 'documento', 'video')),
  titulo        text CHECK (char_length(titulo) <= 200),
  conteudo      text NOT NULL CHECK (char_length(conteudo) BETWEEN 1 AND 50000),
  origem        text CHECK (char_length(origem) <= 500),
  status        text NOT NULL DEFAULT 'treinado' CHECK (status IN ('treinado', 'erro')),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agente_treinamentos_agente_idx ON agente_treinamentos (agente_id, id);

-- --------------------------------------------- agente_acoes_inatividade

CREATE TABLE IF NOT EXISTS agente_acoes_inatividade (
  id           bigserial PRIMARY KEY,
  agente_id    bigint NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  apos_minutos integer NOT NULL CHECK (apos_minutos BETWEEN 1 AND 10080),
  acao         text NOT NULL CHECK (acao IN ('interagir', 'finalizar')),
  instrucao    text CHECK (char_length(instrucao) <= 512),
  ordem        integer NOT NULL DEFAULT 0,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  -- "Interagir" sem instrução deixaria o modelo inventar o que dizer a um
  -- cliente que parou de responder.
  CONSTRAINT agente_acoes_inatividade_instrucao
    CHECK (acao <> 'interagir' OR char_length(coalesce(instrucao, '')) > 0),
  CONSTRAINT agente_acoes_inatividade_minutos_uk UNIQUE (agente_id, apos_minutos)
);

-- -------------------------------------------------------- agente_canais

CREATE TABLE IF NOT EXISTS agente_canais (
  id        bigserial PRIMARY KEY,
  agente_id bigint NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  canal     text NOT NULL CHECK (canal IN ('whatsapp', 'instagram')),
  instancia text NOT NULL CHECK (char_length(instancia) BETWEEN 1 AND 100),
  ativo     boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agente_canais_instancia_uk
  ON agente_canais (canal, lower(instancia));
CREATE INDEX IF NOT EXISTS agente_canais_agente_idx ON agente_canais (agente_id);

-- --------------------------------------------------- conversas.agente_id

ALTER TABLE conversas
  ADD COLUMN IF NOT EXISTS agente_id bigint REFERENCES agentes(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS conversas_agente_idx
  ON conversas (agente_id) WHERE agente_id IS NOT NULL;

COMMENT ON COLUMN conversas.agente_id IS
  'Agente dono da conversa (docs/AGENTES.md). NULL = conversa da clínica. RESTRICT: apagar agente nunca devolve conversas à clínica.';

-- ------------------------------------------------------ atualizado_em

DROP TRIGGER IF EXISTS trg_agentes_upd ON agentes;
CREATE TRIGGER trg_agentes_upd BEFORE UPDATE ON agentes
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

DROP TRIGGER IF EXISTS trg_agente_treinamentos_upd ON agente_treinamentos;
CREATE TRIGGER trg_agente_treinamentos_upd BEFORE UPDATE ON agente_treinamentos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ---------------------------------------------------------------- RLS/GRANT

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format($p$
        CREATE POLICY app_trabalho ON public.%I
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)
      $p$, t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO crmclinica_app', t || '_id_seq');
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
