-- 050 — aparelhos que recebem aviso no celular (Web Push).
--
-- Pedido de 12/09/2026: "quando acontecer algo na conta que me pertence, o
-- usuário ser notificado, via popup do celular".
--
-- O que esta tabela guarda: uma linha por APARELHO inscrito, não por pessoa.
-- A mesma pessoa usa celular e computador, e cada navegador tem o seu endereço
-- de entrega. O endereço (`endpoint`) é gerado pelo serviço de push do próprio
-- navegador (Google, Mozilla, Apple) e é único — daí a UNIQUE: o navegador
-- troca o endereço de tempos em tempos e reinscreve sozinho, e sem a chave
-- única o mesmo celular viraria linha nova a cada troca, recebendo o aviso
-- repetido.
--
-- O que ela NÃO guarda: nada do paciente. O empurrão sai sem conteúdo (ver
-- src/seguranca/webpush.js) porque a notificação aparece na tela de bloqueio,
-- à vista de quem estiver por perto — "Maria Silva: preciso remarcar minha
-- consulta de psiquiatria" ali é exatamente o vazamento que o CRM existe para
-- evitar.
--
-- `p256dh` e `auth` são as chaves que o navegador entrega na inscrição. Hoje
-- elas não são usadas (só fariam falta para cifrar um payload, que não
-- mandamos), mas guardá-las agora é o que permite ligar o conteúdo cifrado
-- depois sem pedir permissão de novo a cada aparelho.
--
-- ON DELETE CASCADE em usuario_id: conta apagada leva junto os aparelhos dela.
-- Um aparelho órfão continuaria recebendo aviso de uma conta que não existe
-- mais.
--
-- Idempotente: pode rodar duas vezes.

BEGIN;

CREATE TABLE IF NOT EXISTS notificacoes_inscricoes (
  id              bigserial PRIMARY KEY,
  usuario_id      bigint NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  -- Para a pessoa reconhecer qual aparelho é, quando tiver vários.
  agente          text,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  ultimo_envio_em timestamptz
);

-- O endereço de entrega é a identidade do aparelho.
CREATE UNIQUE INDEX IF NOT EXISTS notificacoes_inscricoes_endpoint_uk
  ON notificacoes_inscricoes (endpoint);

-- Caminho quente: "para quem eu aviso agora" e "quais aparelhos são desta
-- pessoa" passam por usuario_id. Sem o índice, o CASCADE de apagar usuário
-- varreria a tabela inteira.
CREATE INDEX IF NOT EXISTS notificacoes_inscricoes_usuario_idx
  ON notificacoes_inscricoes (usuario_id);

-- RLS: mesma postura do resto do schema — a aplicação entra como
-- `crmclinica_app` e o recorte por usuário é feito nas consultas (ver
-- listarInscricoesParaAviso). A tabela não é exposta ao papel anônimo.
ALTER TABLE notificacoes_inscricoes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmclinica_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON notificacoes_inscricoes TO crmclinica_app;
    GRANT USAGE, SELECT ON SEQUENCE notificacoes_inscricoes_id_seq TO crmclinica_app;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'notificacoes_inscricoes'
         AND policyname = 'notificacoes_inscricoes_app'
    ) THEN
      CREATE POLICY notificacoes_inscricoes_app ON notificacoes_inscricoes
        FOR ALL TO crmclinica_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

COMMIT;
