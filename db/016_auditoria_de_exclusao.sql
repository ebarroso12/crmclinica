-- 016 — Exclusão sem testemunha deixa de existir
--
-- Esta migration nasce de uma auditoria com uma pergunta sem resposta: as
-- tabelas `agendamentos` e `lembretes` amanheceram vazias, o contato e o lead
-- do ensaio sumiram — e o `audit_log` não tinha um único evento contando quem
-- apagou. As criações estavam todas lá (ids 994 a 1000); as exclusões, em lugar
-- nenhum.
--
-- O motivo: o trigger `audit_user_changes` cobria `conversas`, `mensagens` e
-- `usuarios` — e mais nada. Nas tabelas clínicas, um DELETE era invisível.
-- Quem apagasse pelo painel, por SQL direto ou pela Management API saía sem
-- assinar o livro.
--
-- Só DELETE, de propósito. As criações e mudanças de estado dessas tabelas já
-- são auditadas pela aplicação com eventos semânticos (`agendamento_criado`,
-- `lead_estagio_alterado`) — auditar INSERT e UPDATE aqui duplicaria cada um
-- deles com um espelho cru. A exclusão é diferente: ela é exatamente o evento
-- que a aplicação não registra, e o snapshot em `detalhe.old` é a única cópia
-- do que existia.
--
-- Isto não impede o dono do banco de apagar — impedir o dono é impossível por
-- definição. Garante outra coisa: que apagar deixa rastro, porque o trigger
-- dispara para qualquer papel, inclusive `postgres`.
--
-- Aplicar depois de 015.

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agendamentos', 'lembretes', 'leads', 'contatos', 'lead_eventos', 'notas_internas'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_del_%1$s ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_del_%1$s AFTER DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION audit_user_changes()', t);
  END LOOP;
END $$;

COMMIT;
