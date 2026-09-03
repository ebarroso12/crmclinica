-- 044 — Widening do índice de identificador (043): não exige mais telefone nulo.
--
-- Contexto (achado da revisão de banco de 23/08, sobre a própria migration
-- 043): o índice original (`WHERE identificador IS NOT NULL AND telefone IS
-- NULL`) parava de proteger um contato assim que ele ganhasse telefone depois
-- de já existir. Isso não é hipotético — é o comportamento pedido pelo Dr.
-- Edson: a Serena vai perguntar telefone/WhatsApp durante a qualificação de
-- um lead do Instagram, e esse contato passa a ter telefone preenchido sem
-- deixar de ser a mesma pessoa. Com o índice antigo, a mensagem SEGUINTE da
-- mesma pessoa no Instagram (que continua chegando sem telefone, só com
-- identificador) deixava de encontrar o contato promovido — o INSERT do
-- caminho "sem telefone" não achava conflito (a linha promovida saiu do
-- escopo do índice) e criava um contato duplicado, com o mesmo identificador
-- mas telefone vazio. Era a mesma classe de bug que a migration 043 existe
-- para evitar, só que por uma porta diferente.
--
-- Correção: o índice passa a valer sempre que identificador existe,
-- independente do estado atual de telefone. `identificador` é uma chave de
-- identidade permanente uma vez atribuída (hoje só o Instagram escreve nela);
-- ganhar telefone depois não deveria apagar esse reconhecimento.
--
-- Índices são imutáveis quanto ao predicado — não dá para "alterar" o WHERE
-- de um índice existente, só recriar. Aditiva e reversível (a 043 continua
-- existindo como registro histórico; este arquivo apenas substitui o índice
-- por um mais permissivo). Rollback restaura o índice restrito da 043 em
-- 044_contatos_identificador_uk_sem_restricao_telefone_rollback.sql.

BEGIN;

DROP INDEX IF EXISTS contatos_identificador_uk;

CREATE UNIQUE INDEX IF NOT EXISTS contatos_identificador_uk
  ON contatos (identificador) WHERE identificador IS NOT NULL;

COMMIT;
