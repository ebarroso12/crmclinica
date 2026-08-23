> **⚠️ NÃO MESCLAR NEM PUBLICAR AINDA.** Este PR é rascunho de revisão. Nenhuma migration deste PR foi aplicada em produção. Preview da Vercel está desligado só para esta branch (`vercel.json` → `git.deploymentEnabled`).

## Nota sobre este relatório

Os números de teste e o SHA-base citados no pedido original de PR (`1109/1109`, `80/80`, HEAD `dd03ac2`) são de um ponto anterior desta sessão — antes das Pendências 1-4 (drift 008/009, barreira "Resolver", garantia real de entrega, chat ao vivo durável) serem concluídas. Este corpo usa o **estado real do Git e os resultados finais registrados após essas 4 pendências**: 13 commits (`c359e0b`..`a75c5d6`), suíte final 1113/1113, PostgreSQL 85/85.

## Causas-raiz

1. **P0 (herdado, já commitado antes desta leva):** métodos do repositório abriam `pool.connect()` + `BEGIN/COMMIT` próprios em vez de checar `contexto.atual()?.client` — FK violation para entidades criadas mais cedo na mesma transação ambiente ainda não commitada.
2. **Outbox sem posse verificável:** `concluirTrabalhoDeOutbox` fechava o trabalho só por `id`, sem conferir status/dono/`RETURNING` — um worker com lease vencido podia sobrescrever o desfecho de quem já havia retomado o trabalho.
3. **Recuperação de senha não atômica:** `marcarRecuperacaoUsada` tinha a guarda certa no SQL (`WHERE usado_em IS NULL`), mas o resultado era descartado e as 4 escritas da redefinição rodavam soltas, sem transação — duas requisições concorrentes com o mesmo token podiam ambas passar.
4. **Bypass de 2FA no SSE (P1-04):** o gate de segundo fator só enxergava o cabeçalho `Authorization`, que `EventSource` nunca envia — a rota de chat ao vivo resolvia a identidade real depois do gate, driblando-o.
5. **Botão sem handler:** `data-tela` só tinha listener dentro do `<nav>`; dois botões do painel inicial ("Ver todas", "Agenda") ficavam fora, clicavam e não faziam nada.
6. **Drift 008/009:** duas migrations aplicadas em produção fora do Git — reconstrução impossível a partir só de `db/*.sql` até esta leva.
7. **Chat ao vivo só em memória:** sem persistência, sem cursor, sem replay — reconectar perdia tudo; token de sessão inteiro exposto na URL do `EventSource`.

## Alterações por commit

| Commit | O quê |
|---|---|
| `c359e0b` | Porteiro que torna a prova PostgreSQL obrigatória (nunca "PULADO" silencioso) |
| `9fd39e4` | Reproduz o ingresso transacional completo contra PostgreSQL real |
| `3f29235` / `4eebc04` | P0: `registrarMensagem`, `definirEtiquetasDaConversa`, `definirDisponibilidades` passam a respeitar a transação ambiente |
| `74d14d6` | **Fencing da outbox** — `posse_token` monotônico (migration 033) |
| `67bd9cb` | **Recuperação de senha atômica** |
| `9b0d81a` | Delegação de clique em `[data-tela]` no `document` |
| `5225974` | **SSE respeita o gate de 2FA** (P1-04) |
| `dd03ac2` | Correções de uma auditoria independente sobre os 4 commits acima (achados reais, ver abaixo) |
| `88eecfa` | **Drift 008/009**: reconstrução versionada de funções + policies |
| `6753c9b` | Barreira final da Serena: cobertura de "Resolver" (faltava dos 4 gatilhos) |
| `3fe6d1c` | Documenta a garantia real de entrega da outbox (não é exactly-once) |
| `cf5506b` | **Chat ao vivo durável**: log em Postgres, cursor, replay, bilhete de conexão |
| `a75c5d6` | `vercel.json`: desliga Preview só desta branch |

## Barreira final da Serena

`podeEntregarAgora` (`atendimento.js`) relê o controle no limite imediatamente anterior à chamada de `canal.enviar` — não apenas antes da geração. Testado para os 4 gatilhos que podem mudar **durante** a geração da IA (Desligar, Pausar, Assumir, Resolver): nenhum consegue entregar depois que o controle muda, e o aborto é auditado como `envio_abortado_por_controle`.

## Prevenção de duplicidade — limite real da garantia

**Não é exactly-once.** Documentado explicitamente em `automacao-outbox.js`:
- **Garantido:** nunca duas respostas pelo caminho normal (`chave_idempotencia` + reivindicação exclusiva `FOR UPDATE SKIP LOCKED`); nunca reenvio automático de uma entrega indeterminada (timeout/queda de rede vira `incerto`, escalado para humano, nunca retentado sozinho).
- **Limite teórico, não eliminado por construção:** janela de corrida entre renovar o lease e chamar a Evolution (que não tem idempotência nativa no envio) — mitigada pela margem de `LEASE_MS` (~4x o pior caso documentado), não observada em produção.

## Fencing da outbox

Migration `033_outbox_posse_token.sql`: `posse_token bigint` monotônico, incrementado a cada reivindicação. `concluirTrabalhoDeOutbox` e `renovarReivindicacaoDeOutbox` exigem o token corrente quando declarado — um worker que perdeu a posse não consegue mais concluir, reagendar nem matar o trabalho de quem retomou. 4 testes contra PostgreSQL real.

## Recuperação atômica de senha

`marcarRecuperacaoUsada` agora devolve se a chamada reivindicou o token (`RETURNING`); `redefinirSenha` reivindica primeiro, dentro da mesma transação (`repositorio.comUsuario`) das outras três escritas. Teste reproduz duas redefinições concorrentes com o mesmo token: só uma vence.

## Chat ao vivo com cursor e replay

Migration `037_conversas_eventos_duraveis.sql`: log append-only em Postgres (`conversas_eventos`, cursor `id bigserial`) substitui a dependência exclusiva de memória. Reconectar manda o cursor (`Last-Event-ID` ou `?cursor=`); a rota reproduz exatamente o perdido antes de assinar ao vivo, sem duplicar. Token de sessão saiu da URL — troca por bilhete de uso único (`conversas_eventos_tickets`, `POST /api/conversas/eventos/ticket`, resgate atômico). 5 testes contra PostgreSQL real + cobertura HTTP (desconectar → gerar eventos → reconectar com cursor → conferir exatamente os ids perdidos, sem duplicar).

**Limitação documentada, não implementada:** filtragem fina por conversa (ex.: atendente só vendo o que lhe foi atribuído) não existe — também não existe em nenhuma rota REST hoje. Implementar só para o SSE seria inconsistente e daria falsa sensação de segurança.

## Correção dos botões

"Ver todas" e "Agenda" (painel inicial) tinham `data-tela` mas ficavam fora do `<nav>` — o listener antigo só alcançava `nav [data-tela]`. Corrigido com delegação de evento no `document`.

## Drift 008/009 — reconstrução

Extração somente-leitura contra produção (`pg_get_functiondef`/`pg_policies`/`pg_roles`) → SQL gerado mecanicamente, nunca transcrito. `db/034` (10 funções + 53 policies `crm008_*`), `db/035` (storage, idempotente), `db/036` (13 policies legadas `restrict_*`, hoje comprovadamente inertes). Validado por aplicação real, do zero, em banco descartável (34 migrations, 0 erro, contagens exatas).

**Ordem correta para aplicação futura (não numérica):**

| Ordem real | Migration | Por quê |
|---|---|---|
| 1 | `007_hardening.sql` | cria a role `crmclinica_app` e as tabelas base |
| 2 | `034_reconstrucao_funcoes_e_policies_008.sql` | só precisa de `007` |
| 3 | `035_reconstrucao_storage_privileges_009.sql` | só precisa de `007` (independente de `034`) |
| 4 | `010` … `011_serena.sql` | cria `serena_configuracao`/`serena_prompts`/`serena_regras` |
| 5 | `036_reconstrucao_policies_restrict_legado.sql` | precisa de `034` (funções `is_admin_master`/`is_colaborador`) **e** `011` (tabelas `serena_*`) |
| 6 | `012` … `033_outbox_posse_token.sql` | `033` só precisa de `031` |
| — | `018_restringir_funcoes_security_definer.sql` (já commitada) | faz `REVOKE`/`GRANT` em funções que só existem depois de `034` — **numericamente vem antes, mas funcionalmente precisa vir depois** |
| — | `037_conversas_eventos_duraveis.sql` | depende só de `conversas`/`usuarios` (`db/001`) — pode entrar em qualquer ponto depois delas |

Achado à parte, não relacionado a 008/009: `016` cria um trigger que chama `audit_user_changes()`, mas só `017` define essa função — gap pré-existente entre duas migrations já commitadas antes desta leva.

**`033_outbox_posse_token.sql` precisa preceder qualquer deploy do código que grava `posse_token`** (`automacao-outbox-servico.js`, `repositorio.js`) — sem ela, `reivindicarTrabalhosDeOutbox` quebra a fila inteira (comprovado: a query falha no parse por coluna inexistente).

## Resultado da suíte

- **Memória:** 1113/1113 passando, 13 skipped (esperados — dependem de PostgreSQL real), 0 falha.
- **PostgreSQL real:** 85/85 passando, 0 falha.
- `npm run verificar`: OK. `git diff --check`: limpo.

## Auditoria independente

Um agente auditor, sem relação com a implementação, tentou refutar os achados dos primeiros 4 commits (fencing, senha, botão, SSE) rodando os testes e revertendo código para provar as regras. Achou 2 confirmados sem ressalva, 2 com ressalvas reais (comentário falso sobre compatibilidade sem a migration 033; teste de controle-negativo do SSE mal rotulado) — todos corrigidos no commit `dd03ac2`.

## Limitações e riscos restantes

- `current_usuario_id()` (usada por várias policies `crm008_*` ativas) depende de `auth.jwt()->>'email'`, que o backend nunca declara — o ramo "dono do registro" dessas policies nunca casa por essa via hoje. Registrado, não corrigido (mudaria RLS em produção sem decisão do dono).
- Filtragem fina por conversa no chat ao vivo não existe (ver acima).
- `db/018` e `db/016` têm dependências de ordem que contradizem a numeração — só resolvível aplicando na ordem funcional documentada, ou com decisão do dono sobre renumerar migrations já commitadas.
- Nenhuma das migrations novas (033-037) foi aplicada em produção — todas pendentes de decisão e janela de deploy do dono.

## Checklist de rollout

- [ ] Revisar cada migration nova (`033`-`037`) e seus rollbacks
- [ ] Aplicar em produção na **ordem funcional** da tabela acima, não na ordem numérica dos nomes de arquivo
- [ ] Confirmar `posse_token` aplicado (`033`) **antes** de publicar o código que a usa
- [ ] Confirmar `034`/`035` aplicadas **antes** de qualquer reaplicação de `018`
- [ ] Revisar decisão sobre `current_usuario_id()` (limitação acima) antes de depender dela para autorização real
- [ ] Só então: merge, deploy, remover o bloqueio de Preview deste `vercel.json` (ou deixar — a branch deixa de existir após o merge)

## Checklist de rollback

- Cada migration nova tem seu `_rollback.sql` correspondente (`033`, `034`, `035`, `036`, `037`)
- `035` (storage) e a parte histórica de `017` (não desta PR) são **irreversíveis por decisão de segurança** — documentado nos próprios arquivos, não removê-los
- Reverter o código (fencing, recuperação de senha, SSE, chat ao vivo) é seguro sem reverter as migrations — todas as migrations são aditivas (`ADD COLUMN`/`CREATE TABLE`/`CREATE OR REPLACE FUNCTION`), nenhuma quebra o schema anterior
