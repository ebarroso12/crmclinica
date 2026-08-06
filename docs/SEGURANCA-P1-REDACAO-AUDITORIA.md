# P1 — Redação de segredos na trilha de auditoria

**Branch:** `fix/redacao-segredos-audit-log`
**BASE_SHA:** `855eef5c04b254a58f799be849b530728b722e93`
**Vulnerabilidade:** o trigger `audit_user_changes` fotografava a linha inteira
de `usuarios` em `detalhe.old`/`detalhe.new`. Cada login (que atualiza
`ultimo_login_em`) gravava o `senha_hash` completo no `audit_log`; o mesmo
aconteceria com `totp_segredo_cifrado`. Comprovada em produção (registros 1015
e 1016, login do admin em 06/08/2026). Nenhum valor é reproduzido aqui.

## Inventário (somente leitura, 06/08/2026)

- Função: `audit_user_changes()` — `SECURITY DEFINER`, `search_path ''`,
  genérica para todas as tabelas auditadas; `to_jsonb(OLD/NEW)` cru.
- Trigger em `usuarios`: `trg_audit_usuarios` (AFTER INSERT OR UPDATE OR DELETE).
- Chaves sensíveis reais de `usuarios` (pelo schema): `senha_hash`,
  `totp_segredo_cifrado`. (`precisa_trocar_senha` é flag booleana, não segredo.)
- Único outro segredo do schema: `recuperacoes_senha.hash_token` — a tabela
  **não** tem trigger de auditoria; nada a fazer nela.
- Registros contaminados: **81**, IDs **199–1016**, `entidade='usuarios'`,
  ações `update` (79) e `insert` (2: IDs 204 e 229), de 04/08 a 06/08.
- Acesso ao `audit_log`: SELECT/INSERT para `crmclinica_app` (RLS `crm008_*`);
  nenhuma rota da API devolve `audit_log` hoje (a tela de Auditoria do painel
  está "não implementada").

## Correção em três camadas

1. **Defesa na escrita (banco)** — `db/017_redacao_segredos_auditoria.sql`
   redefine `audit_user_changes`: para `tg_table_name = 'usuarios'`, remove
   `senha_hash` e `totp_segredo_cifrado` do JSONB antes de gravar (`- array[...]`,
   remoção real: sem máscara, sem tamanho, sem resto).
2. **Sanitização histórica (banco, mesma migration)** — UPDATE transacional
   remove as mesmas chaves de `detalhe.old`/`detalhe.new` dos 81 registros,
   preservando linha, autor, timestamp, ação e campos não sensíveis; grava
   evento semântico `sanitizacao_de_segredos` com contagem, intervalo de IDs e
   nomes das chaves — nunca valores.
3. **Defesa na leitura/escrita (aplicação)** — `src/seguranca/redator-auditoria.js`:
   sanitizador central, recursivo (objetos e arrays em qualquer profundidade),
   imutável, com lista explícita + negação por padrão de chaves claramente
   secretas. Aplicado desde já na costura única de escrita da aplicação
   (`registrarAuditoria` nos dois repositórios). Qualquer rota futura que
   devolva `audit_log` DEVE passar o `detalhe` por `redigirAuditoria()` —
   proteção contra histórico não sanitizado, trigger futuro errado e dados
   importados.

## Validação da migration (ensaio somente leitura em produção)

A expressão exata da migration foi aplicada em SELECT (sem escrita) sobre os
dados reais: 81 contaminados antes → **0** depois; o `old` do registro 1015
transformado mantém os 18 campos não sensíveis e perde exatamente as duas
chaves. Testes: 728/728 locais (13 novos em `testes/redacao-auditoria.test.js`).

## Plano de aplicação (ordem)

1. Merge do PR de segurança (via PR, merge commit).
2. Deploy da Vercel (camada de aplicação passa a redigir na escrita).
3. Aplicar `db/017` em produção (transação única: função + histórico).
4. Verificação pós-migration (somente leitura):
   `SELECT count(*) FROM audit_log WHERE (detalhe->'old') ?| array['senha_hash','totp_segredo_cifrado'] OR (detalhe->'new') ?| array['senha_hash','totp_segredo_cifrado']` → deve ser 0;
   novo login → novo registro de `usuarios` sem as chaves.
5. Rotacionar a senha do admin master (o hash exposto ficou legível para quem
   leu o audit_log no período) e revogar as sessões anteriores.

## Rollback

- **Código da aplicação:** `git revert` dos commits (todos aditivos). Sem
  efeito colateral — o redator só remove chaves que nunca deveriam existir.
- **Função do banco:** tecnicamente reversível reaplicando a definição antiga
  (002/016), mas isso reintroduz a vulnerabilidade — não fazer.
- **Sanitização histórica: IRREVERSÍVEL, por decisão de segurança.** Restaurar
  os segredos exigiria tê-los copiado para algum lugar antes de apagar — o que
  recriaria o vazamento. Não existe cópia. O evento semântico no próprio
  `audit_log` é o registro permanente do que foi feito.

## Fora do escopo deste PR

- Implementar a rota de leitura da auditoria no painel (quando vier, usar o
  redator).
- Auditoria de `recuperacoes_senha` (não auditada hoje; sem exposição).
