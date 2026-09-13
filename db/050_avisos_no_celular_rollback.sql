-- Rollback da 050.
--
-- Efeito operacional: ninguém mais recebe aviso no celular, e as inscrições
-- dos aparelhos são perdidas. Quem quiser voltar a receber precisa apertar o
-- botão de novo em Meu perfil, aparelho por aparelho — a permissão do
-- navegador continua dada, mas a inscrição em si some.
--
-- Não há dado clínico aqui: a tabela guarda endereço de entrega do serviço de
-- push e as chaves do navegador, nada do paciente.
--
-- O código sobrevive à ausência da tabela: as rotas de inscrição passam a
-- falhar e o cartão some da tela, e o disparo do aviso é engolido pelo
-- try/catch de `criarAvisos` — o atendimento não para.

BEGIN;

DROP TABLE IF EXISTS notificacoes_inscricoes;

COMMIT;
