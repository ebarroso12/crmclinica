-- 047 — Equipe dos agentes e separação clínica × agentes (docs/AGENTES.md,
-- "Quem vê o quê").
--
-- Decisão do Dr. Edson (11/09/2026): as conversas de um agente (outro negócio,
-- outro número — o primeiro é a Loja Alpins) só aparecem para as pessoas
-- escolhidas para aquele agente; o admin vê tudo, sempre. E a clínica também
-- se separa: cada usuário tem "vê a clínica: sim/não". Um funcionário da loja
-- (não vê a clínica, está na equipe do Alpins) nunca enxerga paciente.
--
-- O que cada peça garante:
--
--   agente_equipe           — quem atende cada agente. CASCADE nas duas FKs:
--                             apagar agente ou usuário apaga só o vínculo,
--                             nunca conversa nem histórico.
--   usuarios.acesso_clinica — padrão TRUE, para ninguém perder acesso no dia da
--                             aplicação. É a aplicação (src/seguranca/escopo.js)
--                             que decide com ela; o admin ignora a marca.
--   guard_usuario_acesso_clinica — a política crm008_u_u deixa o próprio usuário
--                             atualizar a sua linha (nome, telefone). Sem este
--                             gatilho, qualquer caminho de "editar o próprio
--                             perfil" que um dia repassasse campos a mais daria
--                             ao funcionário da loja um jeito de se dar acesso
--                             aos pacientes. Pela aplicação (crmclinica_app), só
--                             backend e admin mudam a marca. Fora dela (dono das
--                             tabelas no SQL Editor, manutenção) o gatilho não
--                             interfere: ali não há sessão de usuário a proteger,
--                             e o claim vazio faria current_app_role() falhar.
--                             Função separada de propósito: guard_usuario_sensitive
--                             (008) vive fora do repositório e não é reescrita aqui.
--
-- Nenhum conteúdo de conversa ou de paciente entra nestas estruturas.
--
-- ORDEM OBRIGATÓRIA: aplicar esta migration ANTES de publicar o código que a
-- usa (o código novo lê usuarios.acesso_clinica e agente_equipe a cada
-- requisição de quem não é admin). Compatível para trás: o código antigo não
-- lê nem a coluna nem a tabela.
--
-- Bloqueio: ADD COLUMN ... NOT NULL DEFAULT constante é só metadado no
-- PostgreSQL 11+ (sem reescrever a tabela), mas pega lock exclusivo em
-- `usuarios` até o COMMIT — login e toda leitura de usuário esperariam. Por
-- isso `lock_timeout` de 5 s: sem o lock, a migration inteira falha sem mudar
-- nada; espere e aplique de novo.
--
-- Mesmo desenho de RLS/GRANT da 046. Rollback em 047_equipe_de_agentes_rollback.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ----------------------------------------------------------- agente_equipe

CREATE TABLE IF NOT EXISTS agente_equipe (
  agente_id  bigint NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  usuario_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_por bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agente_equipe_pk PRIMARY KEY (agente_id, usuario_id)
);

-- A leitura quente é "de quais agentes este usuário é" (a cada requisição).
CREATE INDEX IF NOT EXISTS agente_equipe_usuario_idx ON agente_equipe (usuario_id);

-- --------------------------------------------------- usuarios.acesso_clinica

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS acesso_clinica boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN usuarios.acesso_clinica IS
  'Vê a clínica (pacientes, leads, agenda, Serena). FALSE = só as conversas dos agentes da equipe dele. Admin ignora a marca. docs/AGENTES.md.';

-- ---------------------------------------------------- usuarios.recebe_resumo
--
-- Resumo do atendimento por equipe (docs/RESUMOS.md): quem recebe é a equipe
-- de cada lado — a da clínica recebe os da clínica, a de cada agente os do
-- agente. Esta marca é a pausa por pessoa, que só o admin muda (auditado).
-- Padrão TRUE: ninguém que hoje receberia deixa de receber pela migration.
-- Não precisa de gatilho: a marca só decide o que chega ao WhatsApp da própria
-- pessoa — não abre dado nenhum.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS recebe_resumo boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN usuarios.recebe_resumo IS
  'Recebe o resumo de atendimento da(s) equipe(s) em que está. FALSE = pausado pelo admin. docs/RESUMOS.md.';

CREATE OR REPLACE FUNCTION public.guard_usuario_acesso_clinica()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- IFs aninhados de propósito: a ordem de avaliação de um AND em SQL não é
  -- garantida, e fora da aplicação o claim pode estar vazio.
  IF NEW.acesso_clinica IS DISTINCT FROM OLD.acesso_clinica AND current_user = 'crmclinica_app' THEN
    IF public.current_app_role() NOT IN ('backend', 'admin') THEN
      RAISE EXCEPTION 'acesso à clínica só pode ser alterado por administrador';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_usuarios_acesso_clinica_guard ON usuarios;
CREATE TRIGGER trg_usuarios_acesso_clinica_guard BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION public.guard_usuario_acesso_clinica();

-- ---------------------------------------------------------------- RLS/GRANT

ALTER TABLE public.agente_equipe ENABLE ROW LEVEL SECURITY;

-- Tabela nova não nasce aberta para PUBLIC (DEFAULT PRIVILEGES, db/029).
REVOKE ALL ON public.agente_equipe FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_usuario_acesso_clinica() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    DROP POLICY IF EXISTS app_trabalho ON public.agente_equipe;
    CREATE POLICY app_trabalho ON public.agente_equipe
      FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
    -- Zera o herdado antes do mínimo: sem TRUNCATE (ignora o RLS) e, no
    -- PostgreSQL 17, sem MAINTAIN. Vínculo não se edita: entra ou sai.
    REVOKE ALL ON public.agente_equipe FROM crmclinica_app;
    GRANT SELECT, INSERT, DELETE ON public.agente_equipe TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.agente_equipe FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.guard_usuario_acesso_clinica() FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
