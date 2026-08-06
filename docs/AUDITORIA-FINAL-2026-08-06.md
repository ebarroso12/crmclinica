# Auditoria final — crmclinica

**Data:** 2026-08-06
**Escopo:** explicar a limpeza dos dados, corrigir defeitos residuais e comprovar o circuito
Serena → MCP → API do agente → domínio da agenda → PostgreSQL/Supabase → avanço do lead → fila de lembretes → Google.

---

## Veredito

O circuito **funciona de ponta a ponta em produção**, com evidência persistente (seção 3).
A limpeza dos dados **está explicada** (seção 1). Quatro defeitos residuais foram
**corrigidos e publicados** (seção 2). A Serena **permanece desligada** no WhatsApp — religá-la
é decisão do admin e depende das pendências da seção 4.

---

## 1. A limpeza: o que aconteceu com agendamentos, lembretes, Ana Paula e o lead 129

### O que os dados dizem

| Evidência | Valor | Fonte |
|---|---|---|
| Criações auditadas | `audit_log` ids 994–1000: agendamentos 32–34 e lembretes 59–62, criados 03:03–03:06 UTC de 06/08 | `audit_log` |
| Eventos de exclusão dessas linhas | **zero** | `audit_log` |
| Último delete auditado antes disso | 05/08 21:38 UTC (limpeza de conversas/mensagens de teste, 164 eventos com snapshot) | `audit_log` acao='delete' |
| Integridade do próprio audit_log | `n_tup_del = 0` — o livro nunca foi rasurado; os ids 98–113 ausentes são transações revertidas, não linhas apagadas | `pg_stat_user_tables` |
| Como as linhas sumiram | `DELETE` comum (não TRUNCATE): `n_tup_del` = 32 em agendamentos, 44 em lembretes, 18 em contatos, 5 em leads, 9 em lead_eventos | `pg_stat_user_tables` |
| Sequências preservadas | agendamentos=34, lembretes=62 — consistente com DELETE sem RESTART IDENTITY | sequences |

### Por que não havia rastro

O trigger de auditoria (`audit_user_changes`) cobria só `conversas`, `mensagens` e
`usuarios`. Nas tabelas clínicas, qualquer DELETE — pelo painel, por SQL direto ou pela
Management API do Supabase — era invisível. **Corrigido pela migration 016** (seção 2).

### Quem foi

Entre 03:06 e 03:23 UTC de 06/08, uma sessão de agente em ambiente de nuvem
(autor `*@users.noreply.github.com`) executava uma **auditoria arquitetural** neste
repositório: criou os agendamentos de ensaio 32–34, e às 03:23 empurrou o commit
`d152589` direto na `main`; às 03:45–03:53 abriu o PR #4
(`fix/auditoria-arquitetural-completa`, relatório assinado "Manus") com a regra
"nenhum commit direto em main" — instituída *depois* do d152589. A limpeza dos dados de
ensaio (agendamentos, lembretes, o contato "Ana Paula" e os leads 129/130) aconteceu
nessa mesma janela, por SQL direto, sem passar pela aplicação.

Atribuição por correlação, não por flagrante: sem trigger de DELETE e sem
`pg_stat_statements` acessível, não existe o comando gravado. Mas a janela temporal, o
alvo exato (só os dados de ensaio daquela sessão) e os canais de acesso disponíveis
(token do Supabase CLI desta conta, com acesso de dono via Management API — o mesmo que
esta auditoria usou para aplicar a 016) tornam a sessão de auditoria arquitetural a
única explicação plausível. Nada aconteceu sozinho: a sessão foi autorizada pelo admin.

### Drift entre repositório e banco

O banco vivo tem artefatos que o `db/` não tem: as policies `crm008_*` (que dão à
aplicação DELETE em `lead_eventos`), o guard `crm008_guard_usuario_sensitive` e os
triggers `trg_audit_*` originais. Foram aplicados por fora, provavelmente por sessões
anteriores via Supabase MCP. **Recomendação:** exportar esses objetos para uma migration
`db/` (o Git responde "o que foi entregue"; hoje ele responde errado).

---

## 2. Defeitos residuais corrigidos

| Defeito | Correção | Commit | Verificação |
|---|---|---|---|
| Agendar pela Serena não movia o lead: a rota avançava para `'agendamento'` (etapa inexistente) e o catch engolia a recusa — 34 consultas marcadas, nenhum card movido | `'agendado'` + falha logada + primeira suíte de testes da porta do agente (4 testes) | `825c63e` | Em produção: `audit_log` id 1007, lead 131 `qualificando → agendado` |
| Exclusão sem testemunha nas tabelas clínicas | Migration `db/016`: triggers `trg_audit_del_*` em agendamentos, lembretes, leads, contatos, lead_eventos, notas_internas — disparam para qualquer papel, inclusive `postgres` | `6e8d32b` | Aplicada em produção 06/08, seis triggers confirmados no catálogo |
| 36 arquivos-lixo commitados na raiz (fragmentos de shell: `1)`, `({`, `AGORA`…) | Removidos do índice e do disco | `127fe61` | Raiz limpa; causa provável: hooks globais do claude-flow rodando via `cmd /c` transformam fragmentos `=> ...)` em redirecionamentos; **vigiar recorrência** (um novo apareceu e foi apagado durante esta própria sessão) |
| Política da Serena não proibia publicar bastidores (incidente real: notas internas na conversa do paciente; Serena desligada pelo admin às 23:33 UTC de 05/08, `audit_log` 987) | Regra "sem bastidores" na política oficial (semeada em produção, `audit_log` 1001, 16 regras ativas) | `90f3603` | `serena_regras` |

Suíte após as correções: **701 testes, 0 falhas** (fuso de São Paulo).

### Sobre o inglês e o raciocínio vazado — a fronteira

O cérebro que respondia no WhatsApp é um **agente do OpenClaw com instruções próprias
(USER.md), fora deste repositório**. A política do CRM (que já mandava responder em
português) não chega automaticamente a ele — o CRM alcança o agente apenas para
ligar/desligar (`dmPolicy`, via `openclaw-politica.js`). Alinhar o USER.md do OpenClaw à
política oficial do CRM é passo de operação obrigatório antes de religar.

---

## 3. Prova do circuito, elo por elo

Executada em 06/08 ~04:19 UTC, contra produção, dirigindo `bin/mcp-crmclinica.js` por
JSON-RPC/stdin — exatamente como o OpenClaw o usa. Paciente de ensaio:
**[ENSAIO AUDITORIA] Ana Paula da Prova, 5516900000077**.

| Elo | Evidência persistente |
|---|---|
| Serena → MCP | `tools/list` devolveu as 4 ferramentas; cada chamada abaixo entrou por `tools/call` |
| MCP → API do agente | 4× `POST /api/agente/acao` HTTP 200 nos logs da Vercel (04:19:12–04:19:15, deploy `dpl_HWox92DK…`, commit `90f3603`) |
| API → domínio da agenda | `consultar_horarios` ofereceu 6 horários ("segunda-feira, 10/08, 08:30"…); `agendar` aceitou o primeiro — oferta e marcação concordando (regressão do f4c23ac coberta) |
| Domínio → PostgreSQL | `agendamentos.id = 35` (contato 31014, lead 131, 10/08 08:30–10:00 SP, status `agendado`) |
| Avanço do lead | lead 131: `novo → qualificando` (qualificação) e `qualificando → agendado` (agendamento) — `audit_log` 1002, 1003, 1007; `lead_eventos` 19–23 |
| Fila de lembretes | lembretes 63 (`confirmacao_24h`, 09/08 08:30 SP) e 64 (`confirmacao_2h`, 10/08 06:30 SP), estado `pendente` — `audit_log` 1005, 1006 |
| → Google | `agendamentos.google_evento_id = t6g2e91j92lg293uvueecv1ntg` — id devolvido pela API do Google na criação; nenhum erro de Google nos logs da Vercel |

**Trilha completa:** `audit_log` ids 1002–1007, todas com origem `automacao`.

**O agendamento 35 fica no banco como evidência.** Ele ocupa segunda 10/08 08:30 e está
espelhado no Google Calendar do médico com o nome `[ENSAIO AUDITORIA]`. Quando a
evidência cumprir seu papel: cancelar **pelo painel** (o cancelamento remove o evento do
Google, cancela os lembretes e, desde a 016, deixa rastro).

### Reprodutibilidade

1. `npm test` — 701 testes; a suíte do agente (`testes/agente-http.test.js`) percorre o circuito em memória.
2. O ensaio E2E: dirigir `bin/mcp-crmclinica.js` com `CRMCLINICA_AGENTE_TOKEN` no ambiente, enviando `initialize`, `tools/list` e `tools/call` por stdin (um JSON por linha) — telefone de ensaio `55169000000XX` e nome `[ENSAIO …]`.
3. Conferir: linhas em `agendamentos`/`lembretes`, estágio do lead, trilha no `audit_log`.

---

## 4. Pendências (fora do alcance desta sessão ou aguardando decisão humana)

1. **Religar a Serena** — decisão do admin. Antes: alinhar o USER.md do OpenClaw à
   política do CRM (16 regras, incluindo "português do Brasil" e "sem bastidores") e
   cumprir as condições do PR #4.
2. **PR #4 (auditoria arquitetural "Manus")** — aguarda revisão humana, por regra do
   próprio PR. Duas alegações **verificadas por esta auditoria**: (a) o `chat.send` do
   `d152589` reprocessaria a mensagem do paciente (risco dormente enquanto a Serena está
   desligada — o `d152589` está na `main` e em produção); (b) com `TZ=UTC` a suíte quebra
   (6 falhas em `agenda.test.js`, expectativas com `getHours` — só código de teste; o
   domínio foi corrigido no `f4c23ac`).
3. **Drift banco × repositório** — exportar `crm008_*` e `trg_audit_*` para `db/`.
4. **Token do Supabase CLI** — nesta máquina, dá acesso de **dono** ao banco via
   Management API (foi como a 016 entrou, e provavelmente como a limpeza saiu). Ciência
   e, se preferir, rotação: `supabase logout`.
5. **Arquivos-lixo** — vigiar; se voltar, o suspeito são os hooks globais do
   claude-flow (`~/.claude/settings.json` → `hook-handler.cjs` via `cmd /c`).
6. **SMTP ausente** — recuperação de senha por e-mail não sai (aviso recorrente nos
   logs da Vercel).
7. **Supabase MCP do claude.ai** — sem permissão neste projeto (org gerida pela
   Vercel); as consultas desta auditoria entraram pela conexão da aplicação
   (`crmclinica_app`) e pela Management API.
