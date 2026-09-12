-- 048 — quais canais a Serena deixa de atender sem desligar a automação inteira.
--
-- Pedido de 12/09/2026: atender no Instagram com o WhatsApp da clínica calado.
-- Até aqui só existia o interruptor geral (`ativa`), que cala todos os canais
-- juntos — para ligar o Instagram era preciso ligar o WhatsApp da clínica no
-- mesmo movimento.
--
-- Desenho: o interruptor geral continua soberano (`ativa = false` cala tudo,
-- sem exceção — é a parada de emergência). Esta coluna só regula o LIGADO,
-- como `modo_ativacao` da 028 já fazia para contatos.
--
-- Lista vazia (o padrão) = comportamento de antes desta migration: todos os
-- canais respondem. Por isso a coluna nasce com '[]' e NOT NULL: um NULL aqui
-- teria de ser interpretado toda vez, e "não sei" não é um estado que a
-- decisão de responder possa ter.
--
-- ORDEM DE ATIVAÇÃO (importa): a coluna nasce '[]', ou seja, TODOS os canais
-- respondem. Quem vai atender só no Instagram tem de seguir nesta ordem:
--   1. aplicar esta migration;
--   2. PUT /api/serena/canais {"canais_desligados": ["whatsapp"]} (ou desmarcar
--      a caixa na tela da Serena);
--   3. só então ligar a automação (POST /api/serena/estado {"ativa": true}).
-- Invertendo 2 e 3, o WhatsApp da clínica volta a responder pacientes na janela
-- entre os dois cliques.
--
-- Idempotente: pode rodar duas vezes.

BEGIN;

ALTER TABLE serena_configuracao
  ADD COLUMN IF NOT EXISTS canais_desligados jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Só array. Sem isto, um objeto ou uma string gravada à mão viraria uma lista
-- que o código teria de adivinhar como ler — e adivinhar, aqui, é calar ou
-- soltar um canal sem ninguém ter decidido.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'serena_configuracao_canais_desligados_array'
  ) THEN
    ALTER TABLE serena_configuracao
      ADD CONSTRAINT serena_configuracao_canais_desligados_array
      CHECK (jsonb_typeof(canais_desligados) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN serena_configuracao.canais_desligados IS
  'Canais que a Serena nao atende enquanto a automacao esta ligada (ex.: ["whatsapp"]). '
  'Lista vazia = atende todos. O interruptor geral (ativa) continua valendo acima disto.';

COMMIT;
