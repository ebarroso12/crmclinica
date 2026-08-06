-- 017 — Segredos saem da trilha de auditoria
--
-- A auditoria de `usuarios` fotografava a linha inteira: cada login (que
-- atualiza `ultimo_login_em`) gravava em `detalhe.old` e `detalhe.new` o
-- `senha_hash` completo do usuário — e gravaria `totp_segredo_cifrado` se
-- houvesse. Comprovado em produção nos registros 1015/1016 (login do admin).
-- Quem lê a trilha de auditoria não precisa, e não pode, ler segredos.
--
-- Duas coisas acontecem aqui, na mesma transação:
--
--   1. `audit_user_changes` passa a remover as chaves sensíveis do snapshot
--      de `usuarios` ANTES de gravar. Remoção real da chave no JSONB — sem
--      valor mascarado, sem tamanho, sem prefixo: a chave simplesmente não
--      existe no detalhe. As demais tabelas auditadas não têm colunas de
--      segredo (verificado no schema em 06/08/2026: o único segredo fora de
--      `usuarios` é `recuperacoes_senha.hash_token`, e essa tabela não tem
--      trigger de auditoria) — por isso só `usuarios` é tratada.
--
--   2. Os registros históricos já contaminados perdem as mesmas chaves, sem
--      perder mais nada: linha, timestamp, autor, ação e campos não sensíveis
--      permanecem. Um evento semântico registra a limpeza — quantidade,
--      intervalo de IDs e nomes das chaves; nunca os valores.
--
-- IRREVERSÍVEL DE PROPÓSITO: a limpeza histórica não tem rollback. Restaurar
-- os segredos apagados seria reintroduzir a vulnerabilidade; não existe cópia
-- deles em lugar algum desta migration. O rollback do item 1 (voltar a função
-- anterior, que era a da 002/016) é possível mas NÃO deve ser feito sem
-- reintroduzir a proteção — a definição antiga volta a gravar segredos.
--
-- Aplicar depois de 016.

BEGIN;

-- 1 ─ Defesa na escrita: o trigger redige antes de gravar.
--
-- Mesma assinatura, mesmo SECURITY DEFINER, mesmo search_path vazio da
-- definição anterior. A única mudança é a redação do snapshot de `usuarios`.

CREATE OR REPLACE FUNCTION public.audit_user_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  -- Colunas de `usuarios` que jamais entram na auditoria. A lista vive aqui,
  -- na origem, porque é aqui que o snapshot nasce.
  chaves_sensiveis constant text[] := array['senha_hash', 'totp_segredo_cifrado'];
  velho jsonb;
  novo jsonb;
begin
  if tg_table_name = 'audit_log' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    novo := to_jsonb(new);
    if tg_table_name = 'usuarios' then
      novo := novo - chaves_sensiveis;
    end if;
    insert into public.audit_log (usuario_id, entidade, entidade_id, acao, detalhe)
    values (
      (select public.current_usuario_id()),
      tg_table_name,
      coalesce((to_jsonb(new)->>'id')::bigint, null),
      'insert',
      jsonb_build_object('new', novo)
    );
    return new;
  elsif tg_op = 'UPDATE' then
    velho := to_jsonb(old);
    novo := to_jsonb(new);
    if tg_table_name = 'usuarios' then
      velho := velho - chaves_sensiveis;
      novo := novo - chaves_sensiveis;
    end if;
    insert into public.audit_log (usuario_id, entidade, entidade_id, acao, detalhe)
    values (
      (select public.current_usuario_id()),
      tg_table_name,
      coalesce((to_jsonb(new)->>'id')::bigint, null),
      'update',
      jsonb_build_object('old', velho, 'new', novo)
    );
    return new;
  elsif tg_op = 'DELETE' then
    velho := to_jsonb(old);
    if tg_table_name = 'usuarios' then
      velho := velho - chaves_sensiveis;
    end if;
    insert into public.audit_log (usuario_id, entidade, entidade_id, acao, detalhe)
    values (
      (select public.current_usuario_id()),
      tg_table_name,
      coalesce((to_jsonb(old)->>'id')::bigint, null),
      'delete',
      jsonb_build_object('old', velho)
    );
    return old;
  end if;

  return null;
end;
$function$;

-- 2 ─ Sanitização histórica: as mesmas chaves saem dos registros antigos.
--
-- Só as chaves saem. A linha fica; `usuario_id`, `criado_em`, `acao`,
-- `entidade` e todos os campos não sensíveis do detalhe ficam. O evento
-- semântico ao final registra o que foi feito — sem nenhum valor removido.

DO $$
DECLARE
  chaves_sensiveis constant text[] := array['senha_hash', 'totp_segredo_cifrado'];
  quantos integer;
  menor bigint;
  maior bigint;
BEGIN
  SELECT count(*), min(id), max(id)
    INTO quantos, menor, maior
    FROM public.audit_log
   WHERE (detalhe->'old') ?| chaves_sensiveis
      OR (detalhe->'new') ?| chaves_sensiveis;

  UPDATE public.audit_log
     SET detalhe = detalhe
       || (CASE WHEN detalhe ? 'old'
                THEN jsonb_build_object('old', (detalhe->'old') - chaves_sensiveis)
                ELSE '{}'::jsonb END)
       || (CASE WHEN detalhe ? 'new'
                THEN jsonb_build_object('new', (detalhe->'new') - chaves_sensiveis)
                ELSE '{}'::jsonb END)
   WHERE (detalhe->'old') ?| chaves_sensiveis
      OR (detalhe->'new') ?| chaves_sensiveis;

  INSERT INTO public.audit_log (usuario_id, entidade, entidade_id, acao, detalhe)
  VALUES (
    NULL,
    'audit_log',
    NULL,
    'sanitizacao_de_segredos',
    jsonb_build_object(
      'migration', '017_redacao_segredos_auditoria',
      'linhas_sanitizadas', quantos,
      'menor_id', menor,
      'maior_id', maior,
      'chaves_removidas', to_jsonb(chaves_sensiveis),
      'observacao', 'remoção irreversível por segurança; nenhum valor foi copiado ou registrado'
    )
  );
END $$;

COMMIT;

-- Verificação pós-aplicação (somente leitura; deve devolver 0):
--
--   SELECT count(*) FROM audit_log
--    WHERE (detalhe->'old') ?| array['senha_hash', 'totp_segredo_cifrado']
--       OR (detalhe->'new') ?| array['senha_hash', 'totp_segredo_cifrado'];
--
-- Rollback:
--
--   * Item 1 (função): reaplicar a definição da migration 002 restauraria o
--     comportamento antigo — NÃO fazer; voltaria a gravar segredos.
--   * Item 2 (histórico): SEM ROLLBACK. Irreversível por decisão de segurança.
