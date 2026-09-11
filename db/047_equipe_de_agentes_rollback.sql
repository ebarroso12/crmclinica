-- Rollback da 047 — remove a equipe dos agentes e usuarios.acesso_clinica.
--
-- ANTES de rodar: reverta o deploy do código que usa a 047 (com ele no ar,
-- toda requisição de quem não é admin falha ao ler a marca).
--
-- Recusa rodar se existir QUALQUER usuário com acesso_clinica = false. O código
-- anterior não conhece a marca: o funcionário da loja voltaria a ver pacientes
-- da clínica assim que entrasse. Antes, desative essas contas (situação) ou,
-- se for mesmo o caso, devolva a marca para true de propósito.
--
-- Os vínculos de agente_equipe somem sem recusa: sem a 047, o código anterior
-- mostra conversa de agente para toda a equipe da clínica — nenhum dado de
-- paciente sai para quem não via antes, que é o que a recusa acima protege.

BEGIN;

SET LOCAL lock_timeout = '5s';
-- Quem roda precisa enxergar TODOS os usuários: com row_security off, uma
-- política que esconderia linhas dá erro em vez de deixar a checagem passar.
SET LOCAL row_security = off;

-- Entre a checagem e o DROP COLUMN, ninguém muda a marca.
LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'acesso_clinica'
  ) THEN
    IF EXISTS (SELECT 1 FROM usuarios WHERE acesso_clinica = false) THEN
      RAISE EXCEPTION 'rollback da 047 recusado: existe usuário com acesso_clinica = false. O código anterior daria a essa pessoa acesso aos pacientes da clínica. Desative a conta ou devolva a marca para true antes.';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_usuarios_acesso_clinica_guard ON usuarios;
DROP FUNCTION IF EXISTS public.guard_usuario_acesso_clinica();
ALTER TABLE usuarios DROP COLUMN IF EXISTS acesso_clinica;
-- Sem recusa: o código anterior manda o resumo à lista do ambiente e ignora a pausa.
ALTER TABLE usuarios DROP COLUMN IF EXISTS recebe_resumo;
-- Registro de envios do resumo (sem telefone, sem texto): o código anterior não o usa.
DROP TABLE IF EXISTS resumo_envios;

DROP TABLE IF EXISTS agente_equipe;

COMMIT;
