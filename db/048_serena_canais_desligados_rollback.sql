-- Rollback da 048.
--
-- ATENÇÃO ao efeito operacional: tirar esta coluna devolve a voz a TODOS os
-- canais que estavam calados. Se a clínica estava atendendo só no Instagram
-- com o WhatsApp silenciado, o WhatsApp volta a responder pacientes no
-- instante em que este arquivo rodar — e o código lê a ausência da coluna
-- como "lista vazia" justamente porque, sem ela, ninguém consegue gravar a
-- lista (ver obterConfiguracaoDaSerena em src/dados/repositorio.js).
--
-- Antes de rodar: desligue o interruptor geral (POST /api/serena/estado
-- {"ativa": false}) ou confirme que responder em todos os canais é o que se
-- quer agora.

ALTER TABLE serena_configuracao
  DROP CONSTRAINT IF EXISTS serena_configuracao_canais_desligados_array;

ALTER TABLE serena_configuracao
  DROP COLUMN IF EXISTS canais_desligados;
