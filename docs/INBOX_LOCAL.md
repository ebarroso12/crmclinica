# Inbox local

O inbox é o próprio produto. Contato, conversa e mensagem vivem no PostgreSQL do
crmclinica, e esse banco é a fonte de verdade. Não há serviço externo de conversas:
nenhuma tela, rota ou variável aponta para fora.

## Fluxo

```text
Paciente no WhatsApp
        │
        ▼
  POST /api/eventos ── contrato + assinatura + idempotência
        │
        ▼
  banco do crmclinica ── contato, conversa e mensagem gravados
        │
        ├─ conversa assumida por humano → PARA. Fica com a equipe.
        │
        └─ sem humano → contexto mínimo → OpenClaw
                                              │
                                              ▼
                          resposta gravada no mesmo histórico local
```

A resposta da automação entra na mesma thread que a equipe lê. Não existe registro
paralelo: quem abre a conversa vê tudo em ordem, venha de quem vier.

## Rotas

| Rota | Método | O que faz |
| --- | --- | --- |
| `/api/conversas` | GET | Lista do inbox. Aceita `fila`, `status`, `busca`, `contato` |
| `/api/conversas/filas` | GET | Vocabulário: filas, estados, prioridades, temperaturas, etiquetas |
| `/api/conversas/:id` | GET | Conversa, ficha do contato, notas e conversas anteriores |
| `/api/conversas/:id/mensagens` | GET | Thread, em ordem cronológica |
| `/api/conversas/:id/mensagens` | POST | Resposta humana (`privada: true` vira nota interna) |
| `/api/conversas/:id/assumir` | POST | Assume e pausa a IA (`liberar: true` devolve) |
| `/api/conversas/:id/etiquetas` | POST | Substitui o conjunto de etiquetas |
| `/api/conversas/:id/ficha` | PUT | Nome, telefone, e-mail, identificador e atributos livres |
| `/api/conversas/:id/prioridade` | POST | `baixa`, `media`, `alta`, `urgente` |
| `/api/conversas/:id/estado` | POST | Resolver e reabrir |
| `/api/conversas/:id/temperatura` | POST | `quente`, `morno`, `frio` |
| `/api/conversas/:id/notas` | POST | Nota na ficha do contato |
| `/api/contatos/:id/conversas` | GET | Histórico do contato — o que abre ao clicar no nome |
| `/api/leads` | GET | Kanban; cada card traz `conversa_id` |
| `/api/eventos` | POST | Recepção de mensagem de canal |

## Filas

| Fila | Recorte |
| --- | --- |
| **Minhas** | Conversas assumidas ou atribuídas |
| **Não atribuídas** | Ninguém assumiu ainda — é onde a automação atua |
| **Todos** | Tudo que está no inbox |

## Pausa da IA

A regra é conservadora: **quando um humano assume, a automação cala**.

| Situação | Motivo registrado |
| --- | --- |
| Conversa assumida | `assumida_por_humano` |
| Conversa atribuída a alguém | `humano_responsavel` |
| Conversa resolvida | `conversa_resolvida` |
| Pausa temporária vigente | `pausa_temporaria` |
| Estado desconhecido | `estado_desconhecido` |

Responder pela interface **assume a conversa junto** — é o gesto que diz "eu cuido
deste". Nota interna não assume nem cala a IA: anotar não é atender.

Duas colunas sustentam isso em `conversas`: `assumida_por_humano` e `ia_pausada_ate`.

## Etiquetas e temperatura

As etiquetas operacionais da equipe (`pagou_sinal`, `falta_pagar`, `em_protocolo`,
`pos_consulta`, `avaliacao`, `positiva`, `negativa`, `pacientes_antigos`) convivem com
as três de temperatura: `lead_quente`, `lead_morno`, `lead_frio`.

Trocar a temperatura mexe **só** na etiqueta de temperatura — as demais ficam onde estão.
Nome de etiqueta desconhecido é ignorado, nunca criado por digitação errada.

A temperatura marcada por uma pessoa é soberana: a sugestão automática não a sobrescreve.

## Kanban

Cada lead guarda `conversa_id` — o vínculo com a conversa que o originou. É o que faz
clicar no card abrir a conversa certa, em vez de uma busca por nome que erraria em
homônimos.

Colunas: Novos, Qualificando, Agendados, Convertidos, Perdidos.

## Contexto mínimo

O que sai do CRM para o orquestrador é só: identificador da conversa, canal, estado,
temperatura, nome/telefone/identificador do contato e as últimas mensagens **não privadas**.

Nota interna, evento de sistema, e-mail, anexo e qualquer dado clínico **não atravessam**.
Há teste que falha se atravessarem.

## Banco

Migration em [`db/001_inbox.sql`](../db/001_inbox.sql).

```bash
psql "$CRMCLINICA_DATABASE_URL" -f db/001_inbox.sql
```

Sem `CRMCLINICA_DATABASE_URL` o inbox roda em memória — dá para desenvolver e testar,
mas nada sobrevive ao reinício, e `/api/resumo` mostra isso. Em produção a variável é
obrigatória e o processo não sobe sem ela.
