# Entrega — Frente Serena, Leads, Métricas e IA

**Branch:** `agent/claude-serena-leads-ia` · **Base:** `a663be9` (main, pós PR #7)
**Data:** 2026-08-07 · **Suíte:** 827/827 testes passando (120 novos nesta frente)
**Migrations:** 025, 026, 027, 028 (reservadas para esta frente; NÃO aplicadas em produção)

---

## 1. O que foi entregue, por tarefa

### P0 — Corrigido e provado

| Tarefa | Entrega | Evidência (teste) |
|---|---|---|
| **P0-07** E2E inbound → CRM → Serena → outbound | A resposta da automação era gravada no banco e **nunca enviada ao paciente** (`entregarAoPaciente` só tinha a resposta humana como chamador). Corrigido: a saída da Serena nasce com `id_externo` determinístico (`serena:resposta:{conversa}:{inbound}` — o índice único do banco garante "1 inbound → máx 1 resposta"), é entregue pelo canal com chave idempotente, e a chave de despacho deriva do inbound (retry = mesma chave, mesmo com mensagens novas no meio) | `atendimento-idempotencia.test.js` (16 provas); `e2e-fluxo-critico.test.js` cenários 1–3 |
| **P0-08** Handoff e silêncio | Na Arquitetura B (CRM dono da resposta, conforme `ADR-HANDOFF-HUMANO-SERENA.md`), o handoff por conversa funciona por construção: assumir cala SÓ aquela conversa; liberar devolve; desligada globalmente, a Serena **continua registrando** tudo e o silêncio fica auditado com motivo | `e2e-fluxo-critico.test.js` cenários 4–5; `atendimento-idempotencia.test.js` (handoff por conversa) |

Regras absolutas cobertas por prova executável: persistir antes de responder (1), 1 inbound → 1 resposta (2), retry com mesma chave (3), handoff pausa IA (6), desligada registra (7). As regras 8–10 e 13–15 viraram **regras semeadas nomeadas** no prompt (`bin/semear-serena.js` + `semear-serena.test.js` garante presença por nome) e **avaliação automática** (ver P1-24).

### P1 — CRM comercial (migration 025)

| Tarefa | Entrega | Evidência |
|---|---|---|
| P1-10 Kanban com aging | `leads.estagio_desde` + faixas (recente ≤3d, atenção ≤7d, esfriando ≤14d, abandonado >14d) calculadas no servidor; badge no card | `crm-fluxo.test.js` (aging), `crm-fluxo-http.test.js` (kanban devolve aging) |
| P1-11 Proprietário e próximo passo obrigatórios | Movimento explícito da equipe exige ambos (422 `gestao_obrigatoria`); perder exige motivo; avanço automático da qualificação segue livre; `POST /api/leads/:id/gestao`; a UI pede o próximo passo na hora do drag | `crm-fluxo.test.js`, `crm-fluxo-http.test.js` |
| P1-12 Sino idempotente 15 dias | Tabela `tarefas` com chave única ancorada na última atividade: worker roda por minuto, a mesma inatividade gera UMA tarefa; atividade nova abre novo ciclo | `crm-fluxo.test.js` (4 provas de idempotência do sino) |
| P1-13 SLA e fila aguardando | `conversas.aguardando_resposta_desde` mantida na gravação da mensagem (entrada abre preservando o início; saída visível fecha; nota privada não mexe); `GET /api/conversas/aguardando`; cartão no painel com estouro >15min destacado | `crm-fluxo.test.js` (SLA), `crm-fluxo-http.test.js` |
| P1-14 Resumo interno ao encerrar | `POST /api/conversas/:id/encerrar`: nome, telefone, síntese citada (nunca interpretada), agendou sim/não, pendência. Gravado na conversa + mensagem PRIVADA. **Teste prova que nada passa pelo canal** | `crm-fluxo.test.js` ("o resumo interno NUNCA passa pelo canal") |
| P1-15 Formulário pós-agendamento | Tabela com FK `NOT NULL` para `agendamentos` (garantia estrutural) + serviço exige status `confirmado` (409 antes disso); um formulário por agendamento; reenvio reaproveita com a mesma chave de canal | `crm-fluxo.test.js`, `crm-fluxo-http.test.js` (409 → confirma → 200) |

### P1 — Analítica (migration 026)

| Tarefa | Entrega | Evidência |
|---|---|---|
| P1-16 Dicionário oficial | `docs/METRICAS.md`: toda métrica com definição, fonte, denominador; convenções obrigatórias (período `[de, ate)`, fuso America/Sao_Paulo, filtros, denominadores) | o serviço de métricas implementa as convenções e os testes as cobram |
| P1-17 Eventos e views | `eventos_analiticos` (append-only, chave de dedup) + 7 views comentadas apontando o dicionário; fuso convertido na view; dados sintéticos (faixa `5516900000xx`) excluídos de TUDO | `metricas.test.js` (exclusão de sintéticos, mediana só de respondidas) |
| P1-18 Dashboard leads/conversas | Aba Métricas: origem (com denominador), funil-fotografia, motivos de perda, 1ª resposta (mediana/p90 com base declarada), backlog | `metricas.test.js` HTTP |
| P1-19 Dashboard agenda/Serena | Consultas por status, comparecimento (n de d, taxa nula sem consultas — nunca "0%"), handoff, silêncio por motivo, respostas da automação | idem |

### P1 — Multi-IA (migrations 027–028)

| Tarefa | Entrega | Evidência |
|---|---|---|
| P1-20 Relatório por IA | `POST /api/ia/relatorio` + botão na aba Métricas; idempotente por período+dia; **sem provedor cai no relatório determinístico dos mesmos números** — o botão nunca quebra | `ia-http.test.js` |
| P1-21 Gateway multi-provedor | OpenAI, Anthropic, Google e DeepSeek (+ Kimi legado); catálogo/allowlist em `ia_modelos` mantido pelo backend; modelo fora do catálogo é recusado; chaves SÓ no servidor | `ia-gateway.test.js` (11 provas) |
| P1-22 Menus provedor/modelo | `GET /api/ia/modelos` agrupado; menu de modelo depende do provedor; sem chave aparece "indisponível" desabilitado | `ia-http.test.js` |
| P1-23 Fallback/timeout/custo/telemetria | `ia_chamadas` com chave única (retry = mesmo resultado, sem custo dobrado); fallback **apenas técnico** (timeout/rede/5xx/429/401) com `fallback_de` registrado; recusa semântica não é retentada; custo estimado por preço de catálogo; telemetria sem raciocínio interno e a listagem sem o texto | `ia-gateway.test.js` |
| P1-24 Avaliação empatia/segurança/aderência | Heurística determinística 0–100 com motivos; segurança manda no veredito; varredura idempotente; reprovada vira notificação. **Matriz de avaliações executável: 14 casos adversariais** | `avaliacao-ia.test.js` (a matriz) |
| P1-25 Assistente por aba | `POST /api/ia/assistente`: contexto por aba via allowlist do SERVIDOR (só agregados — nunca conteúdo de paciente, SQL, shell ou administração); pergunta delimitada como não confiável | `ia-http.test.js` |

### P2 / P3

| Tarefa | Entrega | Evidência |
|---|---|---|
| P2-06 Indisponibilidade/retry/concorrência | Timeout de IA nunca vira sucesso; orquestrador fora → escalona sem perder mensagem; 3 entregas concorrentes → 1 resposta; retry pós-falha reutiliza a chave | `e2e-fluxo-critico.test.js`, `ia-gateway.test.js`, `lembretes-concorrencia.test.js` (pré-existente) |
| P2-07 E2E no CI | 5 cenários E2E entram na esteira existente (ubuntu UTC + São Paulo + windows) sem mudar o workflow | `.github/workflows/ci.yml` roda `npm test` |
| P3-02 Central de notificações | Tabela `notificacoes` (chave única idempotente), rotas, sino com badge e lista no topo da UI | `ia-http.test.js` |
| P3-05 Ativação gradual | Modos `todos`/`percentual`/`lista`; percentual por hash **determinístico** do contato; lista explícita; desligado global soberano; quem fica fora tem a mensagem registrada e o silêncio auditado; `PUT /api/serena/ativacao` | `ativacao-gradual.test.js` (9 provas) |

**Bônus:** `GET /api/diagnostico` respondia 404 (guarda de prefixo abortava antes do mapa) — o botão "Verificar agora" do Centro operacional estava quebrado em produção. Corrigido com teste HTTP.

---

## 2. Incidentes da sessão (transparência total)

1. **Commit na branch da frente do Codex.** Outra sessão de agente trocou o checkout do working tree compartilhado no meio dos meus comandos; o commit do conserto do diagnóstico caiu em `agent/codex-agenda-usuarios` (commit `81daf8e`, único da branch). Recuperei o conteúdo por cherry-pick para a minha branch (`63d0657`) e **movi toda a minha frente para um git worktree isolado** (`C:\crmclinica-wt-claude`) — nenhuma troca de branch alheia me afeta mais, e eu parei de tocar o tree deles. Remover o commit da branch do Codex exige `git branch -f` (categoria reset, vetada sem autorização expressa). **Comando para quem autorizar:** `git branch -f agent/codex-agenda-usuarios a663be9` (a branch não tem nenhum commit próprio; nada se perde).
2. **Seed acidental de 5 regras no banco de produção** (15:53 UTC). `bin/semear-serena.js` executava `main()` no `require`; um teste que importava suas `REGRAS` rodou no working tree principal, onde o `.env` real existe, e o seeder (idempotente) criou as 5 regras novas em `serena_regras`. **Impacto zero em comportamento**: a Serena está desligada e o prompt do CRM não é propagado ao agente do canal. O conteúdo é exatamente a política pretendida (as regras entregues nesta branch). Corrigido o gatilho (`require.main === module`) para nunca mais acontecer. Removê-las exigiria DELETE em produção (vetado); ficam, e o painel permite desativá-las se o Edson preferir.
3. **Arquivos-lixo dos hooks.** Os hooks globais do claude-flow continuaram criando arquivos vazios na raiz (armadilha documentada no CLAUDE.md). Removi os criados durante a sessão; `'old')` e `DOCUMENTO CRM/` são anteriores e ficaram intocados.

---

## 3. Riscos residuais

1. **E2E contra ambiente real segue pendente.** Tudo aqui é provado com dublês (dados 100% sintéticos, como a missão exige). Os E2E A–E do plano de estabilização contra a instância de ensaio do OpenClaw continuam necessários ANTES de religar a Serena — o ADR condiciona a publicação da Arquitetura B a esse ensaio.
2. **Migrations 025–028 não aplicadas.** Aplicar exige autorização expressa (produção). Ordem: 025 → 026 → 027 → 028, com `npm run verificar-banco` depois (as listas ESPERADO/RLS/constraints já cobrem as quatro).
3. **A troca de estratégia (`openclaw_gerencia` → `crm_despacha`) continua sendo UMA linha por desenho e não foi tocada** — o WhatsApp real hoje importa histórico; a resposta pelo CRM só passa a valer no ensaio da Arquitetura B.
4. **Adaptadores de provedor (OpenAI/Anthropic/Google/DeepSeek) foram testados com dublês**, não contra as APIs reais (não há chaves no ambiente, de propósito). Primeira chamada real deve ser feita com `IA_TIMEOUT_MS` conservador e observando `/api/ia/chamadas`.
5. **Prompt do CRM ainda não alcança o agente do canal** (achado do mapeamento): editar prompt/regras no painel não muda o comportamento no WhatsApp enquanto o `USER.md` da instância OpenClaw não for alinhado (`agents.files.set`, uso não ensaiado). Relevante para quando religar.
6. **Avaliação heurística é primeira linha, não juiz final** — cobre padrões conhecidos (matriz); a avaliação por IA-juiz (avaliador `ia` já previsto no schema) fica como evolução.
7. **Duas lacunas herdadas anotadas e não tocadas** (fora do escopo desta frente): `verificar-banco.js` não confere as tabelas de voz da migration 012; funções da migration 008 (aplicada fora do Git) não são reconstruíveis a partir de `db/`.

## 4. Sugestões de próximos passos

1. **Ensaio da Arquitetura B** com número de teste: aplicar migrations, `OPENCLAW_SESSION_ID` dedicado, rodar E2E A–E, e só então ativação gradual (`percentual` 10% → 50% → `todos`).
2. **IA-juiz na avaliação**: usar o próprio gateway para segunda opinião nas respostas com veredito `atencao`.
3. **Alinhamento do prompt do canal por RPC** (`agents.files.set`) com diff e auditoria — fecharia o buraco entre painel e agente.
4. **Worker dedicado** (separar o sino/avaliações/resumos do worker de lembretes quando o volume crescer).
5. **Consolidar o painel de auditoria** (a aba existe como stub; a trilha já tem tudo).

## 5. Como validar localmente

```bash
npm ci
npm run verificar   # sintaxe de todos os arquivos, incluindo os novos
npm test            # 827 testes, incluindo E2E críticos e a matriz da Serena
# com banco de ensaio:
for m in db/0*.sql; do psql "$URL_DE_ENSAIO" -f "$m"; done   # cuidado com o rollback da 010
npm run verificar-banco
```
