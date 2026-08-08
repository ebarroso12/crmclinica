# Dicionário oficial de métricas — CRM Clínica

**Status:** oficial. Toda métrica exibida em painel, relatório ou resposta de IA
DEVE citar uma definição deste dicionário. Métrica sem definição aqui não é
exibida — número sem definição é boato com dígitos.

**Convenções obrigatórias em qualquer exibição:**

1. **Período**: todo número vem acompanhado do intervalo `[início, fim)` que o
   produziu. Intervalo fechado no início, aberto no fim.
2. **Timezone**: `America/Sao_Paulo` para tudo que é "por dia/hora". O banco
   grava `timestamptz` (UTC); a conversão acontece na view/consulta, nunca no
   navegador.
3. **Filtros**: os filtros aplicados (origem, campanha, estágio, canal) são
   parte do número e aparecem junto dele.
4. **Denominadores**: toda taxa informa numerador e denominador explícitos.
   "Conversão 12%" sem "12 de 100 leads do período" não é publicável.

---

## 1. Leads e funil

| Métrica | Definição | Fonte | Denominador |
|---|---|---|---|
| `leads_novos` | Leads criados no período (primeiro registro do contato no funil), por hora/dia/semana/mês/ano | `leads.criado_em` | — |
| `leads_por_origem` | `leads_novos` particionado por `leads.origem` (vocabulário fixo: WHATSAPP, SITE, TELEFONE, INDICACAO, INSTAGRAM, FACEBOOK, GOOGLE, CONVENIO, WALK_IN, OUTRO) | `leads.origem` | `leads_novos` do período |
| `leads_por_campanha` | `leads_novos` particionado por `utm_campaign` (nulo = "sem campanha", exibido como categoria própria, nunca omitido) | `leads.utm_campaign` | `leads_novos` do período |
| `leads_por_estagio` | Fotografia atual: leads em cada estágio (novo, qualificando, agendado, convertido, perdido). É estoque, não fluxo — não somar com métricas de período | `leads.estagio` | total de leads ativos |
| `conversao_funil` | Leads criados no período que atingiram `agendado` (e, separadamente, `convertido`) até o momento da consulta | `lead_eventos` (tipo `estagio`) | `leads_novos` do período |
| `motivo_perda` | Leads movidos para `perdido` no período, por `perdido_motivo` (nulo = "sem motivo registrado") | `lead_eventos` + `leads.perdido_motivo` | leads perdidos no período |
| `aging_estagio` | Dias corridos desde `estagio_desde` até agora, por lead. Faixas: 0–3, 4–7, 8–14, 15+ | `leads.estagio_desde` | — |

## 2. Conversas e resposta

| Métrica | Definição | Fonte | Denominador |
|---|---|---|---|
| `tempo_primeira_resposta` | Para cada conversa: `min(saida não-privada) − min(entrada)`. Mediana e p90 no período; conversas ainda sem resposta NÃO entram no cálculo e são contadas à parte em `backlog_sem_resposta` | `mensagens` | conversas com resposta no período |
| `duracao_contato` | `max(criado_em) − min(criado_em)` das mensagens não-privadas de cada conversa encerrada no período | `mensagens`, `conversas` | conversas resolvidas no período |
| `backlog_sem_resposta` | Fotografia: conversas abertas cuja última mensagem é `entrada` (o paciente falou por último), com idade da espera | `conversas.aguardando_resposta_desde` | conversas abertas |
| `sla_resposta` | % de conversas do período cuja primeira resposta saiu em ≤ N minutos (N configurável; padrão 15 min em horário de atendimento) | derivado de `tempo_primeira_resposta` | conversas com inbound no período |
| `picos_horario` | Mensagens de entrada por hora do dia e dia da semana, no fuso da clínica | `mensagens.criado_em` | total de entradas do período |

## 3. Agenda

| Métrica | Definição | Fonte | Denominador |
|---|---|---|---|
| `agendamentos_novos` | Agendamentos criados no período | `agendamentos.criado_em` | — |
| `remarcacoes` | Eventos de remarcação no período (mudança de `inicio` de agendamento existente) | auditoria de agendamentos | agendamentos ativos do período |
| `cancelamentos` | Agendamentos cancelados no período, por motivo quando houver | `agendamentos.status` | agendamentos do período |
| `faltas` | Agendamentos marcados como falta no período | `agendamentos.status` | agendamentos com data no período |
| `comparecimento` | `compareceu / (compareceu + faltas)` no período | `agendamentos.status` | consultas realizadas+faltas |

## 4. Serena e IA

| Métrica | Definição | Fonte | Denominador |
|---|---|---|---|
| `respostas_automacao` | Mensagens de saída com `autor_tipo = 'automacao'` no período | `mensagens` | entradas do período |
| `handoff_serena` | Conversas assumidas por humano no período (`acao = 'assumida_por_humano'` na auditoria), separando escalonação automática (`escalonada*`) de assunção manual | `audit_log` | conversas com atividade no período |
| `silencio_serena` | Decisões de não responder, por motivo (`serena_desligada`, `serena_pausada`, `fora_do_horario`, `assumida_por_humano`, …) | `audit_log` (`automacao_silenciada`) | inbounds do período |
| `duplicacao_ia` | Tentativas de resposta bloqueadas pela chave de idempotência (`duplicada = true` na auditoria de `respondida_pela_automacao`) | `audit_log` | respostas do período |
| `latencia_ia` | Mediana e p95 de `latencia_ms` das chamadas de IA no período, por provedor e modelo | `ia_chamadas` | chamadas do período |
| `custo_ia` | Soma de `custo_estimado_usd` no período, por provedor, modelo e finalidade | `ia_chamadas` | — |
| `erros_ia` | Chamadas com `erro` não nulo no período, por código; taxa sobre o total | `ia_chamadas` | chamadas do período |
| `fallback_ia` | Chamadas atendidas por provedor de fallback (`fallback_de` não nulo) | `ia_chamadas` | chamadas do período |

## 5. Regras de leitura

- **Estoque vs. fluxo:** métricas de fotografia (`leads_por_estagio`,
  `backlog_sem_resposta`) valem para o instante da consulta e não se somam a
  métricas de período.
- **Dado sintético não entra:** contatos e conversas com origem de ensaio
  (`origem = 'ensaio'` ou telefone na faixa reservada `5516900000xxx`) são
  excluídos de TODAS as views agregadas.
- **Privadas não contam:** mensagens `privada = true` (notas internas, avisos de
  sistema) nunca entram em contagem de resposta nem de duração.
- **Fuso na fronteira do dia:** "dia" começa à meia-noite de São Paulo. Uma
  mensagem às 23h de terça em UTC (20h de terça em SP) conta em terça.

## 6. Implementação

As views agregadas que materializam este dicionário vivem na migration
`db/026_analitica.sql` e são expostas por `GET /api/metricas/*`. Cada view
carrega comentário SQL apontando para a entrada correspondente desta página.
