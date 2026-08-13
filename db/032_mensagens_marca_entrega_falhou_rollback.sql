-- Rollback da 032 — marca de entrega falhou em `mensagens`
--
-- **Não é para ser rodado por reflexo.** Está aqui porque uma migration sem
-- caminho de volta escrito é uma migration cujo caminho de volta será
-- improvisado às pressas, no pior momento possível.
--
-- O que este arquivo apaga:
--   • as duas colunas novas em `mensagens` (`entrega_falhou`,
--     `entrega_falhou_motivo`) — nada em outra tabela, nenhuma linha é
--     removida, só as duas colunas somem.
--
-- O que isso custa: o marcador visual de "não entregue ao paciente" na tela
-- de Conversas (achado A-3 da auditoria independente) volta a não existir —
-- uma resposta bloqueada pela barreira final, ou que falhou no envio real,
-- volta a ficar indistinguível de uma entrega normal na tela. O código da
-- aplicação já degrada sem quebrar quando a coluna não existe
-- (`montarMensagem` em src/dados/repositorio.js lê com `?? false`), então
-- reverter só o SQL não derruba nada — mas reintroduz o problema que a 032
-- existe para resolver.
--
-- Reverter esta migration NÃO desfaz, sozinha, a lógica de aplicação que
-- escreve nessas colunas (isso é código, não banco) — se o código de
-- aplicação continuar tentando gravar `entrega_falhou`/`entrega_falhou_motivo`
-- depois deste rollback, cada tentativa de gravação vai falhar com "coluna
-- não existe". Reverta os dois juntos (banco e deploy do código).

BEGIN;

ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entrega_falhou_motivo;
ALTER TABLE public.mensagens DROP COLUMN IF EXISTS entrega_falhou;

COMMIT;
