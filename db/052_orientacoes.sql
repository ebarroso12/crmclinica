-- 052 — orientações: quando a IA não sabe e pergunta para a clínica.
--
-- Pedido do Dr. Edson em 13/09/2026, a partir de um caso concreto: alguém
-- pergunta sobre uma publicação do Instagram e a assistente não tem como saber
-- o que estava escrito lá. Até aqui ela tinha duas saídas ruins — inventar, ou
-- escalar e sumir da conversa.
--
-- Agora existe uma terceira: ela diz ao lead que é uma assistente de IA, que
-- vai verificar com um profissional da clínica, e REGISTRA A DÚVIDA aqui. O
-- celular de quem pode responder toca (as inscrições da 050), a pessoa escreve
-- a orientação no CRM, e a assistente compila e repassa ao lead no tom dela.
--
-- Por que uma tabela, e não uma etiqueta na conversa: isto tem ciclo de vida
-- próprio (pedida → respondida, ou pedida → expirada), tem autor, tem texto dos
-- dois lados e precisa ser consultada por "o que está esperando há mais de uma
-- hora". Etiqueta não guarda nada disso.
--
-- O QUE FICA GUARDADO AQUI É CONVERSA DE PACIENTE: a dúvida cita o que a pessoa
-- perguntou, e a orientação é o que a clínica respondeu internamente. Mesma
-- postura do resto do schema: RLS ligada, só `crmclinica_app` alcança.
--
-- Idempotente: pode rodar duas vezes.

BEGIN;

CREATE TABLE IF NOT EXISTS orientacoes (
  id             bigserial PRIMARY KEY,
  conversa_id    bigint NOT NULL REFERENCES conversas (id) ON DELETE CASCADE,
  agente_id      bigint REFERENCES agentes (id) ON DELETE SET NULL,
  -- O que a assistente não soube responder, nas palavras dela.
  duvida         text NOT NULL,
  -- O que a clínica respondeu internamente (não vai literal para o paciente).
  orientacao     text,
  estado         text NOT NULL DEFAULT 'pendente'
                 CHECK (estado IN ('pendente', 'respondida', 'dispensada')),
  -- Quem orientou. SET NULL: a orientação continua valendo como histórico
  -- mesmo se a conta for apagada depois.
  respondida_por bigint REFERENCES usuarios (id) ON DELETE SET NULL,
  respondida_em  timestamptz,
  -- Marcado quando a assistente avisa o lead que a equipe vai retornar, para
  -- ela não repetir esse aviso a cada ciclo do worker.
  avisado_em     timestamptz,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- "O que está pendente nesta conversa" e "o que está pendente há muito tempo"
-- são as duas perguntas que o sistema faz o tempo todo.
CREATE INDEX IF NOT EXISTS orientacoes_conversa_idx ON orientacoes (conversa_id);
CREATE INDEX IF NOT EXISTS orientacoes_pendentes_idx
  ON orientacoes (criado_em) WHERE estado = 'pendente';

-- Uma pendência por conversa: se a pessoa perguntar de novo antes de a clínica
-- responder, isso não pode virar duas notificações e duas respostas.
CREATE UNIQUE INDEX IF NOT EXISTS orientacoes_uma_pendente_por_conversa
  ON orientacoes (conversa_id) WHERE estado = 'pendente';

ALTER TABLE orientacoes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON orientacoes TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE orientacoes_id_seq TO crmclinica_app;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'orientacoes' AND policyname = 'orientacoes_app'
    ) THEN
      CREATE POLICY orientacoes_app ON orientacoes
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

COMMIT;
