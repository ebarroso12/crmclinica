# Auditoria Arquitetural — CRMClinica
**Data:** 2026-08-06  
**Auditor:** Manus (independente)  
**Branch de correção:** `fix/auditoria-arquitetural-completa`  
**PR:** https://github.com/ebarroso12/crmclinica/pull/4

---

## Fase 1 — Mapeamento do Fluxo Real

### Fluxo de entrada de mensagem (como estava em `main` após `d152589`)

```
[Paciente] → WhatsApp
    ↓
[OpenClaw] recebe e grava na sessão (chat.history)
    ↓
[Worker CRM] sincronizarConversas() — polling sessions.list + chat.history
    ↓
[sincronia-conversas.js] → atendimento.receberMensagem(evento)
    ↓
[atendimento.js] grava no banco, qualifica lead
    ↓
[atendimento.js] → responderSePossivel(conversaId)
    ↓
[atendimento.js] → orquestrador.despacharEvento(evento)
    ↓
[openclaw.js d152589] → sessions.list → chat.send → chat.history (POLLING)
    ↓
CIRCUITO DUPLICADO: a mensagem já estava na sessão!
```

### Evidências de código

| Arquivo | Linha | Evidência |
|---|---|---|
| `bin/worker-lembretes.js` | 208 | `orquestrador: null` — o worker monta o atendimento SEM orquestrador |
| `src/servidor/http.js` | 93 | O servidor HTTP monta o atendimento COM orquestrador real |
| `src/dominio/sincronia-conversas.js` | 187 | `atendimento.receberMensagem(evento)` chamado para cada mensagem `user` |
| `src/dominio/atendimento.js` | 155 | `orquestrador.despacharEvento(evento)` chamado dentro de `responderSePossivel` |
| `src/integracoes/openclaw.js` (d152589) | 101 | `chat.send` com `sessionKey` — reenviava a mensagem do paciente |

### Risco identificado: circuito duplicado

O fluxo acima produz:
1. Paciente envia "Quero agendar" → OpenClaw grava na sessão.
2. Worker lê, importa para o CRM, chama `receberMensagem`.
3. `receberMensagem` → `responderSePossivel` → `despacharEvento`.
4. `despacharEvento` (d152589) envia "Quero agendar" novamente via `chat.send`.
5. Serena processa "Quero agendar" **duas vezes** — resposta duplicada ao paciente.

A `idempotencyKey` do CRM não identifica a mensagem original do WhatsApp (que entrou por outro mecanismo), portanto não previne a duplicação.

---

## Fase 2 — Decisão Arquitetural

Ver: `docs/ADR-TRANSPORTE-MENSAGENS-SERENA.md`

**Decisão: Arquitetura A — OpenClaw controla a conversa.**

O projeto foi desenhado para esta arquitetura desde o início:
- `openclaw-politica.js` controla o estado da Serena via `dmPolicy` (ligar/desligar).
- `sincronia-conversas.js` importa respostas da Serena (`assistant`) do histórico.
- O servidor MCP (`bin/mcp-crmclinica.js`) fornece ferramentas para a Serena.

O CRM não deve reenviar mensagens do paciente ao OpenClaw. A Serena já responde no canal.

---

## Fase 3 — Teste de Duplicação

**Status: PENDENTE**

Aguarda:
1. Aprovação e merge do PR #4.
2. Número reservado de ensaio configurado.
3. Execução com marcador `E2E-DUPLICACAO-20260806-HHMMSS`.

**Critério de aceitação:**
- 1 mensagem de entrada → 1 registro no CRM → 1 resposta da Serena → 1 registro de saída → 1 mensagem no telefone.

---

## Fase 4 — Correlação de Resposta

**Status: RESOLVIDO (pela Arquitetura A)**

Com a Arquitetura A, o CRM não aguarda resposta da Serena via polling de `chat.history`. A Serena responde diretamente no canal. O CRM importa a resposta via `sincronia-conversas.js`, que já usa `id_externo` para deduplicação.

O problema de `aguardarResposta` devolver uma resposta antiga foi eliminado pela remoção da chamada a `chat.send` em `despacharEvento`.

---

## Fase 5 — Seleção de Sessão

**Status: RESOLVIDO (pela Arquitetura A)**

Com a Arquitetura A, o CRM não precisa localizar sessões por telefone para enviar mensagens. A seleção de sessão foi removida do `despacharEvento`. O `sincronia-conversas.js` já usa `telefoneDaSessao()` com lógica robusta para importar mensagens.

---

## Fase 6 — Validação do Protocolo Real

**Status: PENDENTE**

Requer:
1. Gateway configurado com `OPENCLAW_GATEWAY_URL` e `OPENCLAW_GATEWAY_TOKEN`.
2. Execução de `ferramentas/smoke-lembretes.js` contra o gateway real.
3. Verificação de `sessions.list`, `chat.history`, `channels.status` e `send` reais.

---

## Fase 7 — Interface

**Status: CORRIGIDO**

| Texto removido | Substituído por |
|---|---|
| `agenda não implementada` | `consultas agendadas` |
| `A agenda ainda não foi implementada.` | `Carregando dados da agenda…` (atualizado dinamicamente) |

O card "Próximos compromissos" agora exibe o número real de consultas do dia, ou mensagem de erro se a API falhar.

---

## Fase 8 — Testes de Agenda

**Status: CORRIGIDO**

| Teste | Arquivo | Erro | Causa | Surgiu antes do commit? | Correção |
|---|---|---|---|---|---|
| os horários livres respeitam janela, bloqueio e ocupação | `agenda.test.js:144` | `[12, 14]` em vez de `[9, 11]` | `getHours()` sensível ao TZ do processo (UTC no sandbox) | Sim | `horaEmSP()` com `Intl.DateTimeFormat` |
| horário que já passou não é oferecido | `agenda.test.js:158` | `[14]` em vez de `[11]` | Mesmo | Sim | Mesmo |
| remarcar move o horário | `agenda.test.js:406` | `19 !== 16` | Mesmo | Sim | Mesmo |
| (5 outros) | `agenda.test.js` | Variações do mesmo erro de TZ | Mesmo | Sim | Mesmo |

**Causa raiz:** O sandbox roda em `TZ=UTC`. Os testes usavam `getHours()` que retorna a hora local do processo. Em produção (Vercel, `TZ=UTC` também), os testes falhariam da mesma forma.

**Correção:** Substituição de `getHours()` por `horaEmSP()` (extrai hora no fuso `America/Sao_Paulo` via `Intl.DateTimeFormat`). O script `test` no `package.json` agora define `TZ=America/Sao_Paulo` explicitamente.

**Resultado:** 694 pass, 0 fail.

---

## Fase 9 — Governança

**Regras em vigor:**
- Nenhum commit direto em `main` durante a estabilização.
- Toda implementação usa branch + PR + suíte completa.
- A Serena permanece desligada no WhatsApp até o veredito final.

**PR aberto:** https://github.com/ebarroso12/crmclinica/pull/4

---

## Fase 10 — Tabela de Estado

| Componente | Estado | Evidência | Risco | Decisão | Próxima ação |
|---|---|---|---|---|---|
| Transporte WebSocket | Corrigido | `openclaw.js` usa `criarClienteGateway` | Nenhum | Mantido | Validar com gateway real |
| Ingresso WhatsApp | Operacional | `sincronia-conversas.js` + `sessions.list` | Baixo | Mantido | Teste E2E |
| `chat.send` | Removido do fluxo principal | `despacharEvento` retorna `null` | Eliminado | Removido | — |
| `chat.history` | Usado apenas para importação | `sincronia-conversas.js:145` | Baixo | Mantido | — |
| Correlação de resposta | Resolvida (Arq. A) | Sem polling de resposta no CRM | Nenhum | Resolvida | — |
| Seleção de sessão | Resolvida (Arq. A) | Sem `sessions.list` no `despacharEvento` | Nenhum | Resolvida | — |
| Idempotência | Operacional | `id_externo` no `registrarMensagem` | Baixo | Mantida | — |
| Duplicação | Eliminada | `despacharEvento` não chama `chat.send` | Eliminado | Corrigida | Confirmar com teste E2E |
| Sincronização CRM | Operacional | `sincronia-conversas.js` + polling | Baixo | Mantida | — |
| Interface | Corrigida | Textos "não implementada" removidos | Nenhum | Corrigida | — |
| Agenda | Operacional | 40 testes passando | Baixo | Corrigida | — |
| Testes | 694 pass, 0 fail | `npm test` com `TZ=America/Sao_Paulo` | Nenhum | Corrigidos | CI/CD |
| Produção (`main`) | Aguardando PR | Branch `fix/auditoria-arquitetural-completa` | Alto | Pendente | Revisão e merge do PR #4 |

---

## Veredito

> **NÃO PRONTO PARA RELIGAR A SERENA**

Pendências antes de religar:

1. **PR #4 revisado e aprovado** por pelo menos um revisor humano.
2. **Teste E2E** com número reservado (Fase 3): confirmar 1 entrada → 1 resposta → 1 saída.
3. **Teste de integração real** contra o gateway (Fase 6): confirmar protocolo WebSocket.
4. **Auditoria revisada** pelo ChatGPT com evidências do GitHub, Vercel e Supabase.

Quando os quatro itens acima estiverem comprovados, o veredito pode ser revisado para **PRONTO PARA RELIGAR**.
