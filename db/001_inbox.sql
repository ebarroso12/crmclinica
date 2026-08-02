-- crmclinica — inbox local
--
-- O inbox é o próprio produto: contato, conversa e mensagem vivem aqui, e este
-- banco é a fonte de verdade. Não há serviço externo de conversas.
--
-- Duas colunas em `conversas` carregam a regra central do atendimento:
--   assumida_por_humano — alguém da equipe tomou a conversa; a IA cala.
--   ia_pausada_ate      — pausa temporária, sem transferir a conversa.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_atualizado_em() RETURNS trigger AS $$
BEGIN NEW.atualizado_em = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- usuários

CREATE TABLE IF NOT EXISTS usuarios (
  id            bigserial PRIMARY KEY,
  nome          text NOT NULL,
  email         text UNIQUE,
  senha_hash    text,
  papel         text NOT NULL DEFAULT 'atendente' CHECK (papel IN ('admin', 'gestor', 'atendente')),
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- contatos

CREATE TABLE IF NOT EXISTS contatos (
  id             bigserial PRIMARY KEY,
  nome           text,
  telefone       text,
  email          text,
  identificador  text,
  origem         text NOT NULL DEFAULT 'whatsapp',
  -- Campos livres da ficha. Fica em jsonb porque cada clínica quer os seus.
  atributos      jsonb NOT NULL DEFAULT '{}'::jsonb,
  observacoes    text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- O telefone identifica a pessoa entre canais; por isso é único quando existe.
CREATE UNIQUE INDEX IF NOT EXISTS contatos_telefone_uk ON contatos (telefone) WHERE telefone IS NOT NULL;
CREATE INDEX IF NOT EXISTS contatos_nome_trgm ON contatos USING gin (nome gin_trgm_ops);

-- ---------------------------------------------------------------- conversas

CREATE TABLE IF NOT EXISTS conversas (
  id                  bigserial PRIMARY KEY,
  contato_id          bigint NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,
  canal               text NOT NULL DEFAULT 'whatsapp'
                        CHECK (canal IN ('whatsapp', 'instagram', 'site', 'formulario', 'interno')),
  status              text NOT NULL DEFAULT 'aberta'
                        CHECK (status IN ('aberta', 'pendente', 'resolvida')),
  prioridade          text CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente')),
  atribuido_a         bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  assumida_por_humano boolean NOT NULL DEFAULT false,
  ia_pausada_ate      timestamptz,
  ultima_msg_em       timestamptz,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversas_contato_idx ON conversas (contato_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS conversas_status_idx ON conversas (status, ultima_msg_em DESC);

-- ---------------------------------------------------------------- mensagens

CREATE TABLE IF NOT EXISTS mensagens (
  id           bigserial PRIMARY KEY,
  conversa_id  bigint NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  direcao      text NOT NULL CHECK (direcao IN ('entrada', 'saida')),
  tipo         text NOT NULL DEFAULT 'texto'
                 CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'video', 'sistema')),
  conteudo     text,
  media_url    text,
  -- Quem falou: o contato, alguém da equipe ou a automação.
  autor_tipo   text NOT NULL DEFAULT 'contato' CHECK (autor_tipo IN ('contato', 'equipe', 'automacao', 'sistema')),
  autor_nome   text,
  privada      boolean NOT NULL DEFAULT false,
  -- Identificador do evento na origem: sustenta a idempotência da entrada.
  id_externo   text,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mensagens_conversa_idx ON mensagens (conversa_id, criado_em);
-- A mesma mensagem reentregue pelo canal não pode virar duas linhas.
CREATE UNIQUE INDEX IF NOT EXISTS mensagens_id_externo_uk ON mensagens (id_externo) WHERE id_externo IS NOT NULL;

-- ---------------------------------------------------------------- etiquetas

CREATE TABLE IF NOT EXISTS etiquetas (
  id         bigserial PRIMARY KEY,
  nome       text NOT NULL UNIQUE,
  descricao  text,
  cor        text NOT NULL DEFAULT '#64748b',
  -- Etiqueta de sistema é aplicada por automação; a pessoa não apaga sem querer.
  do_sistema boolean NOT NULL DEFAULT false,
  ativa      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversa_etiquetas (
  conversa_id  bigint NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  etiqueta_id  bigint NOT NULL REFERENCES etiquetas(id) ON DELETE CASCADE,
  aplicada_em  timestamptz NOT NULL DEFAULT now(),
  aplicada_por bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  PRIMARY KEY (conversa_id, etiqueta_id)
);

CREATE INDEX IF NOT EXISTS conversa_etiquetas_etiqueta_idx ON conversa_etiquetas (etiqueta_id);

-- ---------------------------------------------------------------- leads

CREATE TABLE IF NOT EXISTS leads (
  id            bigserial PRIMARY KEY,
  contato_id    bigint NOT NULL UNIQUE REFERENCES contatos(id) ON DELETE CASCADE,
  -- A conversa que originou o lead: é o que faz o card do kanban abrir a conversa certa.
  conversa_id   bigint REFERENCES conversas(id) ON DELETE SET NULL,
  temperatura   text NOT NULL DEFAULT 'frio' CHECK (temperatura IN ('frio', 'morno', 'quente')),
  estagio       text NOT NULL DEFAULT 'novo'
                  CHECK (estagio IN ('novo', 'qualificando', 'agendado', 'convertido', 'perdido')),
  origem        text NOT NULL DEFAULT 'WHATSAPP',
  proximo_passo text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_estagio_idx ON leads (estagio, atualizado_em DESC);

-- ---------------------------------------------------------------- notas e auditoria

CREATE TABLE IF NOT EXISTS notas_internas (
  id         bigserial PRIMARY KEY,
  contato_id bigint NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,
  usuario_id bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  texto      text NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notas_contato_idx ON notas_internas (contato_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  usuario_id  bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  entidade    text NOT NULL,
  entidade_id bigint,
  acao        text NOT NULL,
  detalhe     jsonb,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_entidade_idx ON audit_log (entidade, entidade_id, criado_em DESC);

-- Idempotência dos eventos recebidos, para sobreviver a reinício do processo.
CREATE TABLE IF NOT EXISTS eventos_recebidos (
  chave       text PRIMARY KEY,
  recibo      jsonb NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eventos_recebidos_criado_idx ON eventos_recebidos (criado_em);

-- ---------------------------------------------------------------- triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios', 'contatos', 'conversas', 'leads'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_upd ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_upd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION set_atualizado_em()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- etiquetas iniciais

-- Temperatura do lead. São de sistema porque a automação também as aplica.
INSERT INTO etiquetas (nome, descricao, cor, do_sistema) VALUES
  ('lead_quente', 'Lead quente — interesse recente e claro', '#dc2626', true),
  ('lead_morno',  'Lead morno — interesse em avaliação',     '#d97706', true),
  ('lead_frio',   'Lead frio — sem atividade recente',       '#0891b2', true)
ON CONFLICT (nome) DO NOTHING;

-- Etiquetas operacionais que a equipe já usa no dia a dia.
INSERT INTO etiquetas (nome, descricao, cor, do_sistema) VALUES
  ('pagou_sinal',        'Pagou o sinal da consulta',                '#059669', false),
  ('falta_pagar',        'Ainda não efetuou o pagamento',            '#d97706', false),
  ('em_protocolo',       'Em protocolo de tratamento',               '#7c3aed', false),
  ('pos_consulta',       'Já passou pela consulta',                  '#1d4ed8', false),
  ('avaliacao',          'Em avaliação de satisfação',               '#64748b', false),
  ('positiva',           'Avaliação positiva',                       '#059669', false),
  ('negativa',           'Avaliação negativa',                       '#dc2626', false),
  ('pacientes_antigos',  'Paciente antigo — retomar contato',        '#0891b2', false)
ON CONFLICT (nome) DO NOTHING;
