-- 049 — Instagram por agente: a loja Alpins ganha o próprio perfil.
--
-- Pedido de 12/09/2026: o Agente Alpins deve ter no Instagram da loja a mesma
-- interação que a clínica já tem no dela — comentário vira resposta pública
-- mais DM, e a conversa por DM segue com o agente.
--
-- Até aqui tudo era da clínica: uma regra de gatilho valia para qualquer
-- comentário, viesse de onde viesse. Com dois perfis na mesma URL de webhook,
-- isso faria a regra da loja responder nos posts da clínica e vice-versa.
--
-- `agente_id NULL` = clínica (a Serena), que é como todas as regras de hoje
-- nascem — nenhuma muda de dono ao aplicar esta migration.
--
-- As credenciais NÃO entram aqui: token é segredo e continua em variável de
-- ambiente (INSTAGRAM_<APELIDO>_ACCESS_TOKEN). O que o banco guarda é só o id
-- público do perfil, em `agente_canais.instancia`, que já existe desde a 046.
--
-- Idempotente: pode rodar duas vezes.

BEGIN;

-- 1. Regra de gatilho pertence a um agente (ou à clínica).
ALTER TABLE instagram_regras_gatilho
  ADD COLUMN IF NOT EXISTS agente_id bigint REFERENCES agentes(id) ON DELETE CASCADE;

-- Buscar "as regras deste perfil" é o caminho quente do webhook: todo
-- comentário que chega faz essa consulta.
CREATE INDEX IF NOT EXISTS instagram_regras_por_agente
  ON instagram_regras_gatilho (agente_id, ativa);

-- 2. O comentário processado registra de qual perfil veio. Sem isto, a
--    métrica "quantos comentários" somaria loja e clínica, e a idempotência
--    não saberia distinguir dois comentários de contas diferentes.
-- SET NULL, e nao CASCADE: apagar o agente nao pode apagar o historico de
-- comentarios ja processados. A marca de idempotencia vive aqui — perde-la
-- faria comentarios antigos serem respondidos de novo se o webhook reentregar.
ALTER TABLE instagram_comentarios_processados
  ADD COLUMN IF NOT EXISTS agente_id bigint REFERENCES agentes(id) ON DELETE SET NULL;

ALTER TABLE instagram_comentarios_processados
  ADD COLUMN IF NOT EXISTS conta_comercial_id text;

CREATE INDEX IF NOT EXISTS instagram_comentarios_por_agente
  ON instagram_comentarios_processados (agente_id, criado_em DESC);

COMMENT ON COLUMN instagram_regras_gatilho.agente_id IS
  'Dono da regra: NULL = clinica (Serena); preenchido = agente daquele perfil do Instagram.';
COMMENT ON COLUMN instagram_comentarios_processados.agente_id IS
  'Agente dono do perfil que recebeu o comentario. NULL = perfil da clinica.';
COMMENT ON COLUMN instagram_comentarios_processados.conta_comercial_id IS
  'Id da conta comercial do Instagram que recebeu o evento (entry[].id do webhook da Meta).';

COMMIT;
