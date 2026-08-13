-- 031 — Outbox transacional do atendimento automático (P0-01, P0-02 do
-- COMANDO 1 — plano em docs/superpowers/plans/2026-08-13-serena-controle-duravel.md).
--
-- Substitui o `setImmediate` como garantia de que uma mensagem aceita pelo
-- webhook do WhatsApp (`/api/canais/whatsapp/eventos`) realmente é
-- processada. Uma função serverless da Vercel pode ser congelada ou
-- encerrada assim que a resposta HTTP sai — o `setImmediate` que corria
-- depois do `202` não tinha garantia nenhuma de terminar.
--
-- Três ideias atravessam este arquivo, no mesmo espírito da 010 (lembretes)
-- e da 021 (google_outbox), que já resolveram o mesmo problema para outras
-- filas deste sistema:
--
--  1. **A mensagem e o trabalho nascem juntos.** `automacao_outbox` não
--     inventa dado: guarda só a referência (`conversa_id`,
--     `mensagem_entrada_id`) de uma mensagem que a aplicação já grava na
--     mesma transação. Ou os dois existem, ou nenhum existe — quem garante
--     isso é `repositorio.comUsuario` em volta da chamada, não este arquivo.
--
--  2. **A fila é tabela, não memória.** Um worker que reinicia retoma de
--     onde parou; duas cópias do worker dividem o trabalho com
--     `FOR UPDATE SKIP LOCKED` na reivindicação (ver
--     `reivindicarTrabalhosDeOutbox` em src/dados/repositorio.js).
--
--  3. **Idempotência nomeada.** `chave_idempotencia` é única: reenfileirar o
--     mesmo trabalho (reentrega do webhook, corrida entre duas requisições)
--     não duplica linha. Este é o SEGUNDO nível de defesa contra
--     duplicidade — o primeiro é a idempotência do próprio evento do webhook
--     (tabela `eventos`, já existente) e o terceiro é o `id_externo` único
--     da mensagem de resposta gerada (tabela `mensagens`, já existente).
--
-- O que esta tabela **não** guarda: o texto da mensagem (já está em
-- `mensagens`), prompt, resposta da IA, token ou qualquer segredo.
-- `ultimo_erro` é só a mensagem técnica de uma falha de infraestrutura
-- (timeout, erro HTTP, exceção) — nunca o conteúdo trocado com o paciente.
--
-- Aditiva e reversível: nenhum DROP em objeto existente, nenhuma coluna
-- removida de outra tabela. Rollback em 031_automacao_outbox_rollback.sql.
--
-- Aplicar depois de 001 a 030.

BEGIN;

CREATE TABLE IF NOT EXISTS automacao_outbox (
  id                    bigserial PRIMARY KEY,

  conversa_id           bigint NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  -- A mensagem de ENTRADA (do paciente) que motivou este trabalho. Nula só é
  -- plausível num enfileiramento manual/de manutenção; o caminho do webhook
  -- sempre preenche.
  mensagem_entrada_id   bigint REFERENCES mensagens(id) ON DELETE SET NULL,

  -- Idempotência: reenfileirar o mesmo par (conversa, mensagem de entrada)
  -- não cria segunda linha. `ON CONFLICT DO NOTHING` no enfileiramento é o
  -- que torna isso uma garantia do banco, não um cuidado do código.
  chave_idempotencia    text NOT NULL UNIQUE,

  status                text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'processando', 'concluido', 'morto', 'incerto')),

  tentativas            int NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas        int NOT NULL DEFAULT 5 CHECK (max_tentativas > 0),
  -- Backoff: enquanto `now()` não alcança este instante, o trabalho não é
  -- servido. Também é onde a reivindicação decide "chegou a hora".
  disponivel_em         timestamptz NOT NULL DEFAULT now(),

  -- Quem pegou o trabalho e quando — o lease. Serve para devolver à fila o
  -- que um worker morto deixou preso em 'processando'; sem isso, a linha
  -- ficaria reservada para sempre e o paciente nunca receberia resposta nem
  -- silêncio explicado.
  reivindicado_por      text,
  reivindicado_em       timestamptz,

  -- Só o motivo técnico. Nunca o texto gerado pela IA, nunca o que o
  -- paciente escreveu — ver o comentário do topo do arquivo.
  ultimo_erro           text,

  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  concluido_em          timestamptz
);

COMMENT ON TABLE automacao_outbox IS
  'Fila durável do atendimento automático: substitui o setImmediate pós-202 do webhook do WhatsApp. Nunca guarda conteúdo de mensagem — só a referência.';
COMMENT ON COLUMN automacao_outbox.ultimo_erro IS
  'Mensagem técnica de falha (timeout, HTTP, exceção). Nunca conteúdo clínico ou texto de mensagem.';

-- O worker pergunta "o que está pendente e na hora de tentar?": o índice
-- parcial cobre exatamente essa pergunta, e só ela — como em
-- google_outbox_pendentes_idx (021) e lembretes_fila_idx (010).
CREATE INDEX IF NOT EXISTS automacao_outbox_fila_idx
  ON automacao_outbox (disponivel_em)
  WHERE status = 'pendente';

-- Recuperação de trabalho preso: só interessa o que está 'processando'.
CREATE INDEX IF NOT EXISTS automacao_outbox_presos_idx
  ON automacao_outbox (reivindicado_em)
  WHERE status = 'processando';

CREATE INDEX IF NOT EXISTS automacao_outbox_conversa_idx ON automacao_outbox (conversa_id);

DROP TRIGGER IF EXISTS trg_automacao_outbox_upd ON automacao_outbox;
CREATE TRIGGER trg_automacao_outbox_upd BEFORE UPDATE ON automacao_outbox
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ------------------------------------------------------------------- RLS
--
-- A outbox é fila de trabalho interna: só o backend (crmclinica_app) lê e
-- escreve. Não existe caso de uso em que `anon` (o público, sem login) ou
-- `authenticated` (a sessão do navegador da equipe, via Supabase Auth — este
-- projeto não usa esse mecanismo para autenticar a equipe, mas a role existe
-- no Supabase) precisem tocar esta tabela: o painel nunca lê a fila
-- diretamente, só o que o diagnóstico decide expor. Revogar explicitamente
-- em vez de confiar no RLS sozinho — defesa em profundidade, mesmo padrão
-- de 010 e 021.

ALTER TABLE public.automacao_outbox ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    DROP POLICY IF EXISTS app_trabalho ON public.automacao_outbox;
    CREATE POLICY app_trabalho ON public.automacao_outbox
      FOR ALL TO crmclinica_app
      USING (true) WITH CHECK (true);

    GRANT SELECT, INSERT, UPDATE, DELETE ON public.automacao_outbox TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE automacao_outbox_id_seq TO crmclinica_app;
  END IF;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.automacao_outbox FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
