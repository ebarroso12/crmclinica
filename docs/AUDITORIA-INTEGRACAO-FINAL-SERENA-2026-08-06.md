# Auditoria da integração final da Serena — 2026-08-06

**Branch:** `fix/integracao-final-serena-claude`
**BASE_SHA:** `2c55a5fb26b972f208103c095ae2aa547d979b00` (main no início do trabalho)
**HEAD_SHA:** registrado no PR (último commit da branch)
**Executor:** Claude Code (único, por decisão do dono após a saída do Manus)
**Revisor externo:** ChatGPT

Classificações usadas: **COMPROVADO** (evidência direta), **INFERIDO** (conclusão
por correlação), **NÃO COMPROVADO** (não há evidência), **REPROVADO** (testado e
falhou), **NÃO TESTADO** (não executado, com o motivo).

---

## 1. O que esta branch entrega

| Commit | Entrega |
| --- | --- |
| `ef7bcbb` | Contrato `estrategia_ia` fail-closed: o adaptador decide o dono do fluxo de IA, nunca o payload. WhatsApp ambíguo → 422 `estrategia_ia_ambigua`, auditado. Recibo com `estrategia_ia` e `decisao_transporte`. 10 testes de contrato |
| `00c41f7` | Fim do redespacho: `openclaw_gerencia` importa e para; `crm_despacha` fala só com sessão interna (`OPENCLAW_SESSION_ID`), com linha de base, correlação por `runId`, idempotência e falha fechada `motor_ia_nao_configurado` |
| `f7e79e1` | Testes de agenda independentes do fuso do processo (base no PR #4, revisada) |
| `4507aec` | CI (ubuntu UTC, ubuntu São Paulo, windows) + ADR do handoff humano |
| `cc33b4b` | Contrato operacional no CLAUDE.md |
| `f060f85` | **Defeito real de produção corrigido**: janela do dia e carência no fuso da clínica — a oferta mostrava horário já ocupado |

## 2. O que veio do PR #4, e o que foi descartado

| Item do PR #4 | Decisão | Motivo |
| --- | --- | --- |
| Diagnóstico do circuito duplicado (chat.send reprocessando mensagem) | **Acolhido**, reimplementado | O diagnóstico está certo; a implementação daqui vai além (sessão interna + correlação), em vez de só devolver `{resposta:null}` |
| Contrato `estrategia_ia` (commit b76df41) | **Reimplementado fail-closed** | A versão do PR era fail-open: o payload escolhia a estratégia e WhatsApp ambíguo caía em despacho — exatamente o proibido |
| Correção TZ de `testes/agenda.test.js` | **Acolhida** (commit f7e79e1) | Verificada: suíte passa em UTC e SP |
| Correção TZ de `agenda-http.test.js` | **Acolhida adaptada** | Reescrita para conviver com o carimbo de estratégia |
| `package.json` | **Descartado** | O do PR está QUEBRADO: `"test": "--test …"` sem `node`. A main está correta e foi preservada |
| Textos da interface (`agenda não implementada`) e card de compromissos | **Não incluído** | Fora do escopo de segurança desta branch; pode virar PR próprio |
| `docs/ADR-TRANSPORTE-MENSAGENS-SERENA.md`, `AUDITORIA-2026-08-06.md` | **Referência** | Permanecem no PR #4 como histórico |
| Testes novos de atendimento/sincronia/resumo/identidade do b76df41 | **Não copiados** | A cobertura equivalente foi escrita aqui contra a implementação fail-closed |

## 3. Testes (Fase 5)

| Ambiente | SO | Node | npm | TZ | total | pass | fail | skip | duração | SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows nativo | Windows 11 (10.0.26200) | v24.15.0 | 12.0.2 | America/Sao_Paulo (sistema) | 715 | 715 | 0 | 0 | ~15,4 s | `f060f85` |
| Windows, TZ forçado | idem | idem | idem | UTC | 715 | 715 | 0 | 0 | ~16,8 s | `f060f85` |
| Windows, TZ forçado | idem | idem | idem | America/Sao_Paulo | 715 | 715 | 0 | 0 | ~16,9 s | `f060f85` |
| Ubuntu UTC | — | — | — | — | — | — | — | — | — | **NÃO TESTADO localmente** (sem autorização de WSL nesta sessão); coberto pelo job `ubuntu-utc` da CI |
| Ubuntu São Paulo | — | — | — | — | — | — | — | — | — | **NÃO TESTADO localmente**; coberto pelo job `ubuntu-sao-paulo` da CI |

`npm ci` e `npm run verificar` aprovados antes de cada bateria. O resultado da CI
(GitHub Actions) é anexado ao PR quando os jobs rodarem — **a CI é o critério, não
o build da Vercel**.

## 4. E2E (Fase 7)

| Ensaio | Estado | Evidência |
| --- | --- | --- |
| E2E A — duplicação | **NÃO TESTADO** | Exige instância/número de ensaio do OpenClaw com a Serena ligada; a Serena segue desligada por decisão do admin |
| E2E B — releitura | **NÃO TESTADO** | Mesmo bloqueio |
| E2E C — resposta antiga | **NÃO TESTADO** no canal real; **COMPROVADO em unidade** (openclaw.test.js: "resposta antiga nunca é devolvida como nova") |
| E2E D — concorrência | **NÃO TESTADO** no canal real; correlação por linha de base + runId **COMPROVADA em unidade** |
| E2E E — handoff humano | **NÃO TESTADO**; a ADR conclui que na Arquitetura A ele é impossível de provar (sem pausa por sessão no gateway) — ver item 6 |
| E2E F — MCP e agenda | **COMPROVADO em produção** — abaixo |

### E2E F — evidências (produção, 2026-08-06 ~05:25–05:32 UTC)

Paciente de ensaio: `[ENSAIO AUDITORIA] E2E F Integração Final`, 5516900000088.

| Verificação | Resultado |
| --- | --- |
| contato | 31017 — **COMPROVADO** |
| lead | 132 — **COMPROVADO** |
| lead em agendado | `qualificando → agendado` (audit 1013) — **COMPROVADO** |
| agendamento | 36, seg 10/08 10:00–11:30 SP, status `agendado` — **COMPROVADO** |
| 90 minutos | `duracao_min = 90` calculado no banco — **COMPROVADO** |
| lembrete 24h | id 65, pendente, dispara 09/08 10:00 SP — **COMPROVADO** |
| lembrete 2h | id 66, pendente, dispara 10/08 08:00 SP — **COMPROVADO** |
| google_evento_id | `dhvuqii3uhvjnh7iesit7ogbl8` — **COMPROVADO** (id devolvido pela API do Google) |
| evento visível no calendário do médico | **INFERIDO** (o id só existe se o Google criou; leitura direta do calendário configurado não está disponível a esta sessão) |
| audit_log | ids 1008–1013, trilha completa — **COMPROVADO** |

**Defeito descoberto pelo E2E F:** a primeira tentativa de agendar recebeu
"já existe um agendamento nesse horário" para um horário que a própria oferta
tinha acabado de listar. Produção oferecia segunda 08:30 com o agendamento 35
ocupando exatamente esse horário. Diagnóstico e correção no commit `f060f85`
(janela do dia no fuso do processo); reproduzido e verificado contra o banco
real com processo em UTC, antes e depois da correção. **Produção continua com o
defeito até o merge + deploy** — é o item mais forte a favor de revisar este PR
logo. Classificação: **REPROVADO em produção, CORRIGIDO na branch (COMPROVADO
em unidade e contra o banco real)**.

Nota de método: o agendamento 35 (ensaio anterior) permanece ativo como evidência
e não foi cancelado — o cancelamento correto é pelo painel, e esta sessão não tem
credencial de painel. Por isso o E2E F usou ensaio novo, como o plano permite.

## 5. Evidências de banco, Google e OpenClaw

- **Banco:** não houve escrita direta no Supabase, migration ou SQL manual nesta
  fase. O E2E F realizou escritas controladas exclusivamente pelo fluxo
  MCP → API → domínio → repositório; evidências acima.
- **Google:** `google_evento_id` gravado nos agendamentos 35 e 36; sem erros de
  Google nos logs de runtime da Vercel nas janelas dos ensaios.
- **OpenClaw:** sonda somente-leitura no gateway da clínica (2026-08-06): 220
  métodos no `hello`; `dmPolicy=allowlist`, `allowFrom=[]` (Serena calada,
  telefone conectado) — **COMPROVADO**; inventário completo na ADR.

## 6. Handoff humano (P0.1)

Ver `docs/ADR-HANDOFF-HUMANO-SERENA.md`. Resumo: não existe pausa por sessão
comprovada no gateway (sem métodos de pausa, sem campo de pausa na sessão, sem
denylist no schema; `sessions.patch` existe mas o contrato de escrita é **NÃO
COMPROVADO**). Pelo critério do plano, a **Arquitetura A é incompatível com
handoff humano por conversa**. A Arquitetura B (canal conectado e calado; CRM
importa, aplica as gates existentes — interruptor, horário, assumida, pausa,
duplicada — e aciona a Serena headless desta branch, respondendo pelo método
`send`) tem as **primitivas implementadas em código**. Roteamento produtivo,
envio pelo canal e handoff **ainda não ativados nem comprovados por E2E**.
`allowFrom` com "todos menos um" segue **vetado**.

## 7. Riscos e bloqueios

1. **Produção oferece horário ocupado** até o merge (defeito do item 4) — risco
   operacional real e motivo de urgência do PR.
2. E2E A–E exigem ambiente de ensaio do OpenClaw que não existe ainda — bloqueia
   religar a Serena.
3. `chat.send` do `d152589` continua na main até o merge; risco dormente com a
   Serena desligada.
4. Hooks globais do claude-flow seguem criando arquivos-lixo com `=>` em
   comandos; mitigação documentada no CLAUDE.md; correção é decisão do dono.
5. Agendamentos de ensaio 35 e 36 ativos na agenda real de segunda 10/08 (08:30 e
   10:00), espelhados no Google — cancelar pelo painel quando deixarem de servir
   de evidência.

## 8. Pendências de segurança

1. **P1 — alta prioridade, em PR separado:** o mecanismo de auditoria de
   `usuarios` deve excluir/redigir `senha_hash`, `totp_segredo_cifrado`,
   tokens de recuperação, tokens de sessão e qualquer segredo equivalente
   antes de gravar `detalhe.old` ou `detalhe.new`.

## 9. Rollback

- Este PR não contém migration nem escrita SQL direta no Supabase. Antes do
  merge, rollback significa fechar o PR. Após o merge, o rollback deverá
  ocorrer por `git revert` dos commits (todos aditivos) ou rollback do
  deployment na Vercel (`isRollbackCandidate`). Os registros de ensaio 35 e 36
  serão preservados até o protocolo pós-merge e depois cancelados pela
  aplicação, mantendo a trilha de auditoria.
- A migration 016 (já em produção, da fase anterior) tem rollback documentado no
  próprio arquivo — não faz parte desta branch.

## 10. Veredito

> **APTO PARA MERGE CONDICIONAL** — CI verde nos três ambientes e revisão
> externa do ChatGPT concluída em 06/08/2026.
>
> **NÃO PRONTO PARA RELIGAR A SERENA** — a Serena deve permanecer desligada até
> a aprovação dos E2E A–E em ambiente de ensaio, incluindo o handoff humano
> por conversa como pré-condição.

O que muda cada veredito:

- **Merge:** CI verde + revisão externa aprovada.
- **Religar:** merge feito + ambiente de ensaio montado + E2E A–E aprovados,
  com o handoff (E2E E) demonstrando conversa assumida em silêncio e os demais
  pacientes atendidos.

---

## 11. Adendo pós-merge — 06/08/2026

Registro do merge e do protocolo pós-merge. Toda verificação abaixo foi feita
por leitura (GET/SELECT); nenhuma escrita partiu desta auditoria.

### Merge e deploy

| Verificação | Evidência | Resultado |
| --- | --- | --- |
| Merge pelo PR #5, merge commit, head travado | merge commit `7d93c88` (head `c1c57c3`, `--match-head-commit`), 06:02:47 UTC | **COMPROVADO** |
| Vercel publicou o SHA da main | deployment `dpl_EUq2R9BwLBFuvaLR1RpB5unfc5RD`, production READY, `gitSource.sha = 7d93c88` | **COMPROVADO** |
| Smoke somente leitura | `/health`: ok, banco alcançável (`crmclinica_app`, papel `backend`, RLS efetivo) | **COMPROVADO** |
| Defeito da oferta corrigido em produção | Com 35/36 ativos, segunda 10/08 não oferecia 08:30 nem 10:00 (só 13:00/14:30/16:00); terça 08:30 oferecida | **COMPROVADO** |

### Cancelamento dos ensaios 35 e 36 (pelo painel, usuário admin)

| Verificação | Evidência | Resultado |
| --- | --- | --- |
| 35 cancelado | `status=cancelado`, `cancelado_em=2026-08-06T03:20:42-03:00`, `cancelado_motivo=null` (nenhum motivo informado no painel), `google_evento_id` preservado | **COMPROVADO** |
| 36 cancelado | `status=cancelado`, `cancelado_em=2026-08-06T03:20:48-03:00`, `cancelado_motivo=null`, `google_evento_id` preservado | **COMPROVADO** |
| Lembretes não elegíveis | 63/64 (ag. 35) e 65/66 (ag. 36) em `estado=ignorado`, motivo `agendamento_cancelado`, nada enviado, nada apagado | **COMPROVADO** |
| Trilha de auditoria | `audit_log` 1017 (ag. 35) e 1020 (ag. 36), ação `agendamento_cancelado`, usuário 1 (admin), com timestamps; 1018/1019/1021/1022 para os lembretes | **COMPROVADO** |
| Horários liberados | Oferta volta a listar segunda 10/08 08:30 e 10:00 após o cancelamento | **COMPROVADO** |
| Google Calendar | O contrato implementado de `cancelar` **não remove nem atualiza o evento no Google** — os eventos dos ensaios permanecem no calendário do médico (não bloqueiam a oferta: o filtro `doCrm` os exclui da ocupação). Leitura direta do calendário não está disponível a esta sessão | **PARCIALMENTE COMPROVADO** (comportamento conforme o contrato; eventos remanescentes inferidos, remoção manual pelo médico se desejar) |
| Contato/lead preservados | contatos 31014 e 31017, leads 131 e 132 existem; nenhum DELETE executado | **COMPROVADO** |
| Nenhum agendamento novo | Nenhum `agendamento` com id > 36 | **COMPROVADO** |
| Serena desligada, política intacta | Sonda no gateway antes e depois: `dmPolicy=allowlist`, `allowFrom=[]` | **COMPROVADO** |

### Confirmação ao vivo da pendência de segurança P1 (item 8)

Os registros `audit_log` 1015 e 1016 (trigger de `usuarios` no login do admin,
06/08 03:19–03:20 BRT) gravaram a linha completa do usuário em `detalhe.old` e
`detalhe.new`, **incluindo `senha_hash`** (e gravariam `totp_segredo_cifrado`
se houvesse). A pendência P1 do item 8 deixa de ser hipótese: está ocorrendo em
produção a cada login/atualização de usuário. Mantida a classificação **P1 de
alta prioridade, em PR separado**: redigir/excluir segredos antes de gravar o
detalhe da auditoria.

### Pendências abertas ao fim do protocolo

1. **P1** — redação de segredos na auditoria de `usuarios` (confirmada ao vivo).
2. Eventos dos ensaios 35 e 36 remanescentes no Google Calendar (só visual;
   remoção manual, ou incluir a limpeza do Google no contrato de `cancelar` em
   PR futuro).
3. E2E A–E em ambiente de ensaio — pré-condição para religar a Serena.

### Veredito final do protocolo

> **PR #5 INTEGRADO EM PRODUÇÃO.**
> **ENSAIOS 35 E 36 CANCELADOS E AUDITADOS.**
> **SERENA PERMANECE DESLIGADA.**
> **RELIGAMENTO PROIBIDO ATÉ E2E A–E APROVADOS.**
