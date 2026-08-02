-- 010 — Lembretes de agendamento (24h e 2h)
--
-- Numerada 010, e não 008, porque o banco já tinha 008 e 009 aplicadas por fora
-- deste repositório (`008_crmclinica_security_hardening` e
-- `009_storage_privilege_revoke`, visíveis em
-- `supabase_migrations.schema_migrations`). Reaproveitar o número faria duas
-- coisas diferentes atenderem pelo mesmo nome — e a próxima pessoa a ler o
-- ledger não teria como saber qual das duas está no banco.
--
-- A regra central deste arquivo é a mesma da 006, aplicada a outro problema:
-- **a garantia é do banco, não da aplicação.**
--
-- Um lembrete duplicado não é um detalhe estético. É a clínica mandando duas
-- mensagens iguais para o paciente às 8h da manhã, e é o tipo de erro que
-- aparece justamente quando há dois workers rodando — no dia em que alguém
-- sobe uma segunda instância para dar conta do volume.
--
-- Duas coisas fecham essa porta:
--
--   1. `lembretes_unicos` — UNIQUE (agendamento_id, tipo, janela). O mesmo
--      lembrete para o mesmo agendamento, do mesmo tipo, para o mesmo horário
--      só existe uma vez. Enfileirar de novo não cria linha: `ON CONFLICT DO
--      NOTHING` transforma a segunda tentativa em nada.
--
--   2. `FOR UPDATE SKIP LOCKED` na reivindicação (ver `reivindicarLembretes` em
--      src/dados/repositorio.js). Dois workers pedindo trabalho ao mesmo tempo
--      recebem conjuntos disjuntos: o segundo pula a linha travada em vez de
--      esperar por ela, e ninguém processa a mesma linha duas vezes.
--
-- `janela` é o instante do agendamento no momento em que o lembrete foi criado.
-- Remarcar muda esse instante, o que produz uma janela nova — e é assim que a
-- remarcação gera lembretes novos sem que os antigos possam ser reaproveitados.
--
-- Aplicar depois de 001 a 007.

BEGIN;

-- ---------------------------------------------------------------- 1. opt-out
--
-- O opt-out vive no contato, não no agendamento: quem pede para parar de
-- receber está falando da relação inteira, não de uma consulta.
--
-- ADD COLUMN IF NOT EXISTS: nada existente é redefinido nem apagado.

ALTER TABLE public.contatos
  ADD COLUMN IF NOT EXISTS lembretes_optout        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lembretes_optout_em     timestamptz,
  ADD COLUMN IF NOT EXISTS lembretes_optout_motivo text;

COMMENT ON COLUMN public.contatos.lembretes_optout IS
  'Contato pediu para não receber lembretes automáticos. Vale para todos os agendamentos.';

-- ---------------------------------------------------------------- 2. fila

CREATE TABLE IF NOT EXISTS lembretes (
  id              bigserial PRIMARY KEY,

  agendamento_id  bigint NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
  contato_id      bigint NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,

  tipo            text NOT NULL CHECK (tipo IN ('confirmacao_24h', 'confirmacao_2h')),

  -- Instante do agendamento a que este lembrete se refere. Junto com
  -- (agendamento_id, tipo) é o que torna o enfileiramento idempotente.
  janela          timestamptz NOT NULL,
  -- Quando o worker deve mandar: `janela` menos 24h ou 2h.
  agendar_para    timestamptz NOT NULL,

  estado          text NOT NULL DEFAULT 'pendente'
                    CHECK (estado IN ('pendente', 'processando', 'enviado', 'ignorado', 'falhou')),

  tentativas      int NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas  int NOT NULL DEFAULT 5 CHECK (max_tentativas > 0),
  -- Backoff: enquanto `now()` não alcança este instante, a linha não é servida.
  tentar_em       timestamptz NOT NULL DEFAULT now(),

  -- Quem pegou a linha e quando. Serve para devolver à fila o que um worker
  -- morto deixou preso em 'processando' — sem isso, a linha ficaria parada
  -- para sempre e ninguém notaria.
  processando_por     text,
  processando_desde   timestamptz,

  -- 'real' quando a mensagem saiu de fato; 'dry_run' quando o adaptador do
  -- OpenClaw rodou sem protocolo confirmado. Estado 'enviado' com modo
  -- 'dry_run' significa: a fila fez seu trabalho e **nenhuma mensagem saiu**.
  modo_entrega    text CHECK (modo_entrega IN ('real', 'dry_run')),
  entrega_referencia text,

  enviado_em      timestamptz,
  ignorado_motivo text,
  ultimo_erro     text,

  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),

  -- Idempotência por agendamento, tipo e janela. É a constraint que faz
  -- reenfileirar ser seguro: a segunda inserção não cria nada.
  CONSTRAINT lembretes_unicos UNIQUE (agendamento_id, tipo, janela)
);

-- O índice que o worker usa: a busca é sempre "pendentes cuja hora chegou".
-- Parcial, porque a fila útil é uma fatia pequena da tabela.
CREATE INDEX IF NOT EXISTS lembretes_fila_idx
  ON lembretes (agendar_para, tentar_em)
  WHERE estado = 'pendente';

-- Recuperação de linha presa: só interessa o que está 'processando'.
CREATE INDEX IF NOT EXISTS lembretes_presos_idx
  ON lembretes (processando_desde)
  WHERE estado = 'processando';

CREATE INDEX IF NOT EXISTS lembretes_agendamento_idx ON lembretes (agendamento_id, tipo);
CREATE INDEX IF NOT EXISTS lembretes_estado_idx      ON lembretes (estado, agendar_para DESC);
CREATE INDEX IF NOT EXISTS lembretes_contato_idx     ON lembretes (contato_id, agendar_para DESC);

DROP TRIGGER IF EXISTS trg_lembretes_upd ON lembretes;
CREATE TRIGGER trg_lembretes_upd BEFORE UPDATE ON lembretes
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ---------------------------------------------------------------- 3. RLS

ALTER TABLE public.lembretes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    DROP POLICY IF EXISTS app_trabalho ON public.lembretes;
    CREATE POLICY app_trabalho ON public.lembretes
      FOR ALL TO crmclinica_app
      USING (true) WITH CHECK (true);

    -- A fila é tabela de trabalho: a aplicação lê, cria, atualiza e limpa o que
    -- envelheceu. O histórico que não se apaga é o audit_log, e ele continua
    -- sem DELETE para esta role.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.lembretes TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE lembretes_id_seq TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.lembretes FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
