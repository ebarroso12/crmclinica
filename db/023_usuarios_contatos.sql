-- 023 — Usuários e contatos: dados estruturados, proteção de CPF/RG, termo
-- versionado, responsável legal e consentimento (P1-01 a P1-08).
--
-- Três regras atravessam o arquivo:
--
--  1. **CPF e RG nunca em claro.** Ficam cifrados (AES-256-GCM, pela aplicação);
--     a busca usa um hash HMAC separado. Quem lê a tabela não lê documento de
--     ninguém — e a busca exata continua possível.
--
--  2. **Excluir usuário é lógico.** `excluido_em` marca a saída; a autoria
--     histórica (`criado_por`, audit_log) permanece apontando para a pessoa que
--     agiu. Apagar a linha apagaria a assinatura de tudo que ela fez.
--
--  3. **Termo é versão, não texto solto.** Cada assinatura referencia a versão
--     exata aceita e o identificador da assinatura eletrônica no provedor
--     externo. O texto semeado aqui é TEMPLATE, sujeito a revisão jurídica —
--     não é redação jurídica definitiva.
--
-- Aplicar depois de 022.

BEGIN;

-- ---------------------------------------------------------------- usuários

-- Suspensão e exclusão lógica ganham situação própria (P1-02): 'desativado'
-- sozinho não distinguia quem foi suspenso de quem saiu — e a reação da
-- operação é diferente (reativar conta viva vs. restaurar histórico).
DO $$
BEGIN
  ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_situacao_check;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_situacao_check'
  ) THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_situacao_check
      CHECK (situacao IN ('pendente', 'ativo', 'recusado', 'desativado', 'suspenso', 'excluido'));
  END IF;
END $$;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nome_completo text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nascimento date;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cpf_cifrado text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cpf_busca_hash text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rg_cifrado text;
-- WhatsApp estruturado: DDI + DDD + número, para uso operacional (vínculo de
-- instância, contato da equipe) sem parsear string solta.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_ddi text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_ddd text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_numero text;
-- Permissão para usar o WhatsApp particular em nome da clínica: exigência
-- explícita e auditada, nunca presumida.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_particular_autorizado boolean NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_particular_autorizado_em timestamptz;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS whatsapp_particular_autorizado_por bigint
  REFERENCES usuarios(id) ON DELETE SET NULL;
-- Exclusão lógica. A autoria histórica fica de pé.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS excluido_em timestamptz;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS excluido_por bigint REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS excluido_motivo text;

-- O mesmo CPF não pode identificar duas pessoas da equipe. O hash é o que o
-- índice vê — o documento em si está cifrado na coluna ao lado.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_cpf_busca_uk
  ON usuarios (cpf_busca_hash) WHERE cpf_busca_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS usuarios_excluido_idx ON usuarios (excluido_em) WHERE excluido_em IS NOT NULL;

-- ---------------------------------------------------------------- contatos

ALTER TABLE contatos ADD COLUMN IF NOT EXISTS nome_completo text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS nascimento date;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS cpf_cifrado text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS cpf_busca_hash text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS rg_cifrado text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS whatsapp_ddi text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS whatsapp_ddd text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS whatsapp_numero text;
-- Responsável legal (menor de idade ou incapaz). Obrigatório pela aplicação
-- quando a data de nascimento indicar menor.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS responsavel_nome text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS responsavel_cpf_cifrado text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS responsavel_parentesco text;
-- Consentimento do responsável: quando, por qual canal e com qual versão de termo.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS consentimento_responsavel_em timestamptz;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS consentimento_canal text;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS consentimento_termo_id bigint;

CREATE INDEX IF NOT EXISTS contatos_cpf_busca_idx ON contatos (cpf_busca_hash) WHERE cpf_busca_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS contatos_nascimento_idx ON contatos (nascimento) WHERE nascimento IS NOT NULL;

-- ---------------------------------------------------------------- termos versionados

CREATE TABLE IF NOT EXISTS termos (
  id           bigserial PRIMARY KEY,
  -- O escopo separa o termo da equipe (uso do sistema, WhatsApp particular)
  -- do termo do paciente (atendimento, dados). Sobem e vigoram separados.
  escopo       text NOT NULL CHECK (escopo IN ('equipe', 'paciente')),
  versao       integer NOT NULL,
  titulo       text NOT NULL,
  texto        text NOT NULL,
  publicado    boolean NOT NULL DEFAULT false,
  publicado_em timestamptz,
  autor_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (escopo, versao)
);

-- No máximo UM vigente por escopo: é esta linha que garante que "o termo que
-- vale agora" tem sempre uma resposta só.
CREATE UNIQUE INDEX IF NOT EXISTS termos_vigente_uk
  ON termos (escopo) WHERE publicado;

CREATE TABLE IF NOT EXISTS termo_assinaturas (
  id                     bigserial PRIMARY KEY,
  termo_id               bigint NOT NULL REFERENCES termos(id) ON DELETE CASCADE,
  -- Exatamente um signatário: usuário da equipe OU contato (paciente).
  usuario_id             bigint REFERENCES usuarios(id) ON DELETE CASCADE,
  contato_id             bigint REFERENCES contatos(id) ON DELETE CASCADE,
  -- A assinatura eletrônica vive no provedor externo; aqui fica a referência.
  assinatura_externa_id  text NOT NULL,
  provedor               text,
  registrado_por         bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em              timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(usuario_id, contato_id) = 1)
);

-- Uma pessoa assina uma versão uma vez: reassinar a mesma versão é duplicata,
-- não reforço.
CREATE UNIQUE INDEX IF NOT EXISTS termo_assinaturas_usuario_uk
  ON termo_assinaturas (termo_id, usuario_id) WHERE usuario_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS termo_assinaturas_contato_uk
  ON termo_assinaturas (termo_id, contato_id) WHERE contato_id IS NOT NULL;

-- ---------------------------------------------------------------- semente (templates)

-- TEMPLATE SUJEITO A REVISÃO JURÍDICA. Não é redação jurídica definitiva:
-- é o marcador que permite a tela existir e o fluxo ser testado até a versão
-- revisada ser publicada pelo caminho próprio (nova versão + publicar).
INSERT INTO termos (escopo, versao, titulo, texto, publicado, publicado_em)
SELECT 'equipe', 1, 'Termo de uso do sistema pela equipe (template v1)',
$$TEMPLATE SUJEITO A REVISÃO JURÍDICA — não usar como redação definitiva.

1. O acesso ao crmclinica é individual e intransferível.
2. O uso do WhatsApp particular em nome da clínica exige autorização explícita, registrada neste sistema, e pode ser revogada a qualquer tempo.
3. A equipe se compromete a não registrar dados clínicos sensíveis fora dos campos próprios do sistema.
4. Todas as ações administrativas são auditadas.$$,
true, now()
ON CONFLICT (escopo, versao) DO NOTHING;

INSERT INTO termos (escopo, versao, titulo, texto, publicado, publicado_em)
SELECT 'paciente', 1, 'Termo de atendimento e consentimento (template v1)',
$$TEMPLATE SUJEITO A REVISÃO JURÍDICA — não usar como redação definitiva.

1. Os dados de contato informados serão usados para agendamento, lembretes e comunicação sobre o atendimento.
2. Para menores de idade, o agendamento exige responsável legal cadastrado e consentimento registrado.
3. O paciente pode revogar lembretes a qualquer momento, respondendo PARAR.$$,
true, now()
ON CONFLICT (escopo, versao) DO NOTHING;

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['termos', 'termo_assinaturas'] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_' || t, t);
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR ALL TO crmclinica_app USING (true) WITH CHECK (true)',
          'app_' || t, t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO crmclinica_app', t);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO crmclinica_app', t || '_id_seq');
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['termos', 'termo_assinaturas'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
