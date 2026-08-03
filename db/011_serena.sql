-- 011 — Controle da Serena e ciclo de vida do contato
--
-- Três coisas que a operação precisava e não tinha:
--
-- 1. **Um botão de desligar.** Quando a automação começa a responder errado —
--    e um dia começa — a equipe precisa calá-la em segundos, sem deploy, sem
--    mexer em variável de ambiente, sem reiniciar processo. E precisa que o
--    desligamento não perca mensagem: o paciente continua escrevendo, o inbox
--    continua gravando, só a resposta automática para.
--
-- 2. **Prompt versionado.** O que a Serena diz é política da clínica, não
--    configuração de servidor. Editar direto no arquivo do agente não deixa
--    rastro de quem mudou, quando e por quê — e desfazer vira arqueologia.
--    Aqui cada versão é uma linha, publicar é um ato datado, e voltar atrás é
--    publicar a anterior.
--
-- 3. **Contato que se apaga sem sumir.** Excluir contato de verdade levaria
--    junto conversas, mensagens e agendamentos — o histórico clínico e
--    comercial inteiro daquela pessoa. O `ON DELETE CASCADE` das tabelas que
--    apontam para `contatos` faz isso em silêncio. Soft delete resolve: o
--    contato sai das listas e o histórico continua de pé.
--
-- Aplicar depois de 001 a 010.

BEGIN;

-- ---------------------------------------------------------------- 1. controle global
--
-- Uma linha só, para sempre. `id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)`
-- é a forma de dizer "esta tabela tem exatamente uma linha" para o banco em vez
-- de para a documentação: uma segunda linha é recusada pela constraint.

CREATE TABLE IF NOT EXISTS serena_configuracao (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- O interruptor. `false` = a Serena não responde nada, em conversa nenhuma.
  ativa         boolean NOT NULL DEFAULT true,

  -- Quem mexeu, quando e por quê. O motivo é obrigatório ao desligar (regra da
  -- aplicação): "a automação está fora" sem explicação vira mistério na semana
  -- seguinte, quando ninguém lembra se foi incidente ou teste.
  alterado_por  bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  alterado_em   timestamptz NOT NULL DEFAULT now(),
  motivo        text,

  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Nasce ligada: um sistema que sobe mudo sem ninguém pedir é pior que um que
-- sobe falando — o segundo é percebido na hora.
INSERT INTO serena_configuracao (id, ativa) VALUES (1, true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- 2. prompt versionado

CREATE TABLE IF NOT EXISTS serena_prompts (
  id            bigserial PRIMARY KEY,
  versao        int NOT NULL,
  titulo        text NOT NULL,
  conteudo      text NOT NULL CHECK (length(conteudo) BETWEEN 20 AND 50000),

  publicado     boolean NOT NULL DEFAULT false,
  publicado_em  timestamptz,
  publicado_por bigint REFERENCES usuarios(id) ON DELETE SET NULL,

  criado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT serena_prompt_versao_uk UNIQUE (versao)
);

-- **No máximo um prompt publicado.** Índice único sobre uma constante,
-- filtrado por `publicado`: duas linhas publicadas colidem na mesma chave.
-- Sem isto, "qual prompt está no ar?" passaria a ter mais de uma resposta — e a
-- aplicação teria de escolher por data, que é adivinhar.
CREATE UNIQUE INDEX IF NOT EXISTS serena_prompt_publicado_uk
  ON serena_prompts ((true)) WHERE publicado;

CREATE INDEX IF NOT EXISTS serena_prompts_versao_idx ON serena_prompts (versao DESC);

-- ---------------------------------------------------------------- 3. regras
--
-- Regras são os pedaços que a equipe liga e desliga sem reescrever o prompt
-- inteiro: uma barreira clínica nova, uma orientação de fluxo, um
-- encaminhamento. Ficam separadas porque têm ciclo de vida próprio — a barreira
-- de emergência não muda quando o texto de acolhimento muda.

CREATE TABLE IF NOT EXISTS serena_regras (
  id            bigserial PRIMARY KEY,
  nome          text NOT NULL UNIQUE,
  descricao     text,
  conteudo      text NOT NULL CHECK (length(conteudo) BETWEEN 3 AND 5000),

  categoria     text NOT NULL DEFAULT 'geral'
                  CHECK (categoria IN ('estilo', 'fluxo', 'barreira', 'encaminhamento', 'geral')),
  ativa         boolean NOT NULL DEFAULT true,
  -- Ordem de leitura no prompt montado. Barreira clínica antes de estilo:
  -- o que a Serena não pode fazer vem antes de como ela fala.
  ordem         int NOT NULL DEFAULT 100,

  criado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS serena_regras_ativas_idx ON serena_regras (ativa, categoria, ordem);

-- ---------------------------------------------------------------- 4. soft delete do contato
--
-- `excluido_em` marca a saída. Nenhuma linha é removida: conversas, mensagens,
-- leads e agendamentos daquela pessoa continuam existindo e continuam ligados a
-- ela. O que muda é que ela some das listas e da busca.
--
-- O telefone continua ocupado por um contato excluído — de propósito. O índice
-- `contatos_telefone_uk` não é parcial por `excluido_em`, então uma mensagem
-- daquele número reencontra o mesmo contato em vez de criar um segundo, e a
-- aplicação o reativa. Duas fichas para a mesma pessoa é o erro que nenhum
-- CRM se recupera direito.

ALTER TABLE public.contatos
  ADD COLUMN IF NOT EXISTS excluido_em     timestamptz,
  ADD COLUMN IF NOT EXISTS excluido_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excluido_motivo text;

COMMENT ON COLUMN public.contatos.excluido_em IS
  'Soft delete: contato some das listas, histórico permanece. NULL = ativo.';

CREATE INDEX IF NOT EXISTS contatos_ativos_idx ON contatos (nome) WHERE excluido_em IS NULL;

-- ---------------------------------------------------------------- 5. triggers

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['serena_configuracao', 'serena_prompts', 'serena_regras'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_upd ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_upd BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION set_atualizado_em()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 6. RLS
--
-- Mesmo desenho das demais tabelas de trabalho: a aplicação lê e escreve, e
-- quem pode o quê é decidido pelo RBAC no código, onde a noção de "admin"
-- existe. O banco garante que ninguém além da aplicação alcança as tabelas.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['serena_configuracao', 'serena_prompts', 'serena_regras'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
      EXECUTE format('DROP POLICY IF EXISTS app_trabalho ON public.%I', t);
      EXECUTE format($p$
        CREATE POLICY app_trabalho ON public.%I
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)
      $p$, t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE serena_prompts_id_seq TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE serena_regras_id_seq TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['serena_configuracao', 'serena_prompts', 'serena_regras'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
