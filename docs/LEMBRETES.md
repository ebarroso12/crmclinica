# Lembretes de agendamento

Confirmação automática 24 horas e 2 horas antes da consulta, pelo WhatsApp,
com o **OpenClaw** como único orquestrador.

> **Estado da entrega: `dry-run`.** A fila funciona de ponta a ponta — enfileira,
> decide, tenta, registra, audita — e **nenhuma mensagem sai**. O motivo está em
> [Por que dry-run](#por-que-dry-run), e não é uma pendência de código deste
> repositório.

---

## O problema

Falta de paciente é o custo mais silencioso de uma clínica: o horário não volta,
e ninguém é avisado de que ele existiu. Um lembrete resolve boa parte disso — mas
só se três coisas nunca acontecerem:

1. **lembrete duplicado** — a mesma mensagem duas vezes é pior que nenhuma;
2. **lembrete de consulta cancelada** — o paciente desmarcou e recebe confirmação;
3. **lembrete para quem pediu para parar** — isso não se desfaz com desculpa.

As três são garantidas pelo banco, não pelo cuidado do código. É a mesma escolha
da agenda (`docs/AGENDA.md`), pelo mesmo motivo: cuidado esquece, constraint não.

---

## Como funciona

```
marcar consulta  →  fila (2 linhas: 24h e 2h)
                         │
     worker (a cada minuto) reivindica o que venceu
                         │
     relê agendamento e contato  →  ainda deve enviar?
                    ├── não → ignorado, com o motivo registrado
                    └── sim → adaptador OpenClaw → enviado
                                   │
                              falhou? → retry com backoff → falhou (definitivo)
```

### Estados

| Estado | Significa |
| --- | --- |
| `pendente` | Na fila, esperando a hora ou o próximo retry |
| `processando` | Um worker reivindicou e está trabalhando nela |
| `enviado` | Passou pelo adaptador. **Veja `modo_entrega`** |
| `ignorado` | Não deve ser enviado. `ignorado_motivo` diz por quê |
| `falhou` | Esgotou as tentativas, ou o erro é permanente |

`modo_entrega` é a coluna que impede um mal-entendido caro:

- `real` — a mensagem saiu;
- `dry_run` — **nada saiu**; a fila apenas simulou o envio.

A auditoria separa os dois com ações distintas: `lembrete_enviado` e
`lembrete_simulado`. Um relatório que conte "enviados" nunca vai somar simulação.

### Motivos de `ignorado`

| Motivo | Quando |
| --- | --- |
| `janela_no_passado` | A consulta foi marcada com menos antecedência que o lembrete pede |
| `agendamento_cancelado` / `_compareceu` / `_faltou` | O assunto acabou |
| `remarcado` | O horário mudou; o lembrete da janela nova já está na fila |
| `optout` | O contato pediu para não receber |
| `sem_telefone` | Não há para onde mandar |
| `agendamento_ja_comecou` | O worker chegou tarde demais |
| `atrasado_demais` | Passou da tolerância (6h para o de 24h, 1h para o de 2h) |

---

## As garantias, e o que as sustenta

### Nenhuma duplicidade — nem com dois workers

Duas coisas, ambas no banco:

**1. `lembretes_unicos UNIQUE (agendamento_id, tipo, janela)`**
Enfileirar o mesmo lembrete de novo não cria linha: `ON CONFLICT DO NOTHING`
transforma a segunda tentativa em nada. É o que torna
`npm run lembretes -- sincronizar` seguro de rodar quantas vezes quiser.

**2. `FOR UPDATE SKIP LOCKED` na reivindicação**
Dois workers pedindo trabalho ao mesmo tempo recebem conjuntos **disjuntos**: o
segundo pula a linha travada em vez de esperar por ela. `SELECT ... FOR UPDATE`
sozinho não bastaria — o segundo worker bloquearia, e depois enxergaria a linha
já processada.

Provado em `testes/lembretes-concorrencia.test.js` (memória e PostgreSQL) e em
`npm run smoke-lembretes`, com duas conexões de verdade contra o banco real.

### Nada é enviado sem reler o mundo

Entre enfileirar e enviar passa um dia inteiro. A decisão de mandar usa o
agendamento e o contato **relidos no momento do envio** — não a foto de ontem.
Cancelou, remarcou, pediu para parar: o lembrete morre, mesmo já reivindicado.

### Retry limitado, com backoff

1min → 2 → 4 → 8 → 16, com teto de 1 hora e 5 tentativas. Erro marcado como
permanente (envelope inválido, protocolo indisponível) não gasta as cinco: falha
na primeira, porque repetir não muda nada.

Worker que morre no meio deixa a linha em `processando`. Depois de 5 minutos de
lease vencido, ela volta à fila — contando a tentativa, para que um lembrete que
derruba o worker toda vez termine em `falhou` em vez de circular para sempre.

### Timezone

Tudo em `America/Sao_Paulo`, sempre. "Hoje", "amanhã" e a hora do texto são
calculados no fuso da clínica, não no do servidor — que roda em UTC. Um lembrete
que diz "às 14:00" para uma consulta das 11:00 é o tipo de erro que nunca aparece
em desenvolvimento.

---

## Opt-out

Vale para o contato inteiro, não para uma consulta. Dois caminhos:

**Pelo canal** — o paciente responde `PARAR`, `SAIR`, `STOP`, `DESCADASTRAR`.
Vale na hora em que a mensagem chega, e cancela o que já estava na fila. A
comparação é sobre a frase inteira: *"posso parar de tomar o remédio?"* não
desliga nada.

**Pela equipe** — `POST /api/contatos/:id/lembretes` com `{"receber": false}`,
ou `npm run lembretes -- optout --contato=3`.

Voltar atrás (`{"receber": true}`) devolve o contato à régua para o que vier —
não ressuscita o que já saiu da fila.

---

## O que atravessa para o OpenClaw

Só isto, e nada mais:

```json
{
  "referencia": "lembrete:42",
  "tipo": "confirmacao_24h",
  "canal": "whatsapp",
  "destinatario": "5516993120938",
  "texto": "Olá, Marina! Você tem horário na Clínica Dr. Edson Barroso amanhã, às 14:00. …"
}
```

O que **não** vai: tipo do agendamento, observações, motivo da consulta, nome do
profissional, identificador de lead, histórico da conversa, prompt. O adaptador
recusa envelope com qualquer campo fora dessa lista — barreira contra um dado
clínico atravessar por descuido no futuro.

Nem o log recebe o conteúdo: telefone sai mascarado (`***0938`) e o texto vira
uma contagem de caracteres.

---

## Por que dry-run

O transporte do OpenClaw está confirmado: é um gateway **WebSocket** — o proxy
aceita upgrade e não existe REST em `/api`. O que **não** está confirmado é o
envelope do protocolo: se é JSON-RPC, se há `id`, se os campos vão em `params`,
nem qual é a sequência do handshake de autenticação. As evidências estão em
`docs/OPENCLAW.md`.

Escrever o cliente a partir desses fragmentos seria adivinhar. Um envio
"bem-sucedido" contra um envelope inventado não entrega mensagem nenhuma — e a
fila marcaria `enviado`, e ninguém descobriria até um paciente reclamar.

Por isso, enquanto `PROTOCOLO_CONFIRMADO` for `false` em
`src/integracoes/openclaw-lembretes.js`:

- o adaptador opera em `dry_run`;
- pedir `LEMBRETES_MODO_ENTREGA=real` **não** faz o adaptador improvisar: ele
  recusa com `openclaw_protocolo_desconhecido`, dizendo o que falta;
- todo lugar que mostra a fila diz em que modo ela está.

### Como ligar o envio real

Falta uma coisa só, e ela não é código deste repositório: **o protocolo**.
Qualquer uma destas o fornece:

1. documentação oficial do gateway OpenClaw;
2. captura de uma sessão real na aba de rede, com a interface aberta — as
   primeiras mensagens revelam handshake e envelope;
3. acesso ao servidor, para ler a configuração do gateway.

Com ele em mãos:

1. implemente `enviarReal(envelope)` como cliente WebSocket;
2. vire `PROTOCOLO_CONFIRMADO` para `true`;
3. defina `LEMBRETES_MODO_ENTREGA=real`, `OPENCLAW_BASE_URL` e `OPENCLAW_TOKEN`.

Nenhum outro arquivo muda. Fila, worker, auditoria e testes continuam iguais — o
caminho `real` já está montado e testado com cliente injetado.

---

## Operação

### Worker

```bash
npm run lembretes:worker                    # contínuo, um lote por minuto
npm run lembretes:worker -- --uma-vez       # um lote e sai
npm run lembretes:worker -- --intervalo=30  # segundos entre lotes
npm run lembretes:worker -- --lote=50
```

Pode rodar em duas ou mais cópias — é para isso que a reivindicação é exclusiva.
`SIGINT`/`SIGTERM` esperam o lote corrente terminar antes de encerrar.

### Consulta e correção

```bash
npm run lembretes -- resumo                     # fila por estado + modo de entrega
npm run lembretes -- fila --estado=pendente
npm run lembretes -- falhas
npm run lembretes -- sincronizar                # enfileira o que falta na agenda futura
npm run lembretes -- reenfileirar --id=12
npm run lembretes -- optout --contato=3 --motivo="pediu no telefone"
npm run lembretes -- optin  --contato=3
npm run lembretes -- processar                  # um lote manual
```

### API

| Rota | O que faz |
| --- | --- |
| `GET /api/lembretes?estado=&tipo=&limite=` | A fila |
| `GET /api/lembretes/resumo` | Contagem por estado e o modo de entrega |
| `GET /api/lembretes/falhas` | Só o que precisa de atenção |
| `GET /api/lembretes/vocabulario` | Tipos e estados, para a interface |
| `POST /api/lembretes/sincronizar` | Enfileira o que falta (idempotente) |
| `POST /api/lembretes/:id/reenfileirar` | Devolve um falhado à fila |
| `GET /api/agenda/:id/lembretes` | A fila de um agendamento |
| `POST /api/contatos/:id/lembretes` | Opt-out / opt-in (`{"receber": false}`) |

Consultar exige `conversas:ler`. Sincronizar e reenfileirar exigem
`conversas:priorizar` (gestor ou admin) — mexer na fila é operação, não
atendimento. Opt-out exige `contatos:editar`.

---

## Variáveis

```bash
LEMBRETES_ATIVOS=sim              # `nao` desliga o enfileiramento
LEMBRETES_MODO_ENTREGA=dry_run    # `real` exige protocolo confirmado
CRMCLINICA_NOME_CLINICA=Clínica Dr. Edson Barroso
LEMBRETES_INTERVALO_MS=60000
LEMBRETES_LOTE=20
LEMBRETES_MAX_TENTATIVAS=5
```

---

## Banco

Migration `db/010_lembretes.sql` (numerada 010 porque 008 e 009 já existiam no
banco, aplicadas fora deste repositório).

- `lembretes` — a fila, com `lembretes_unicos` e dois índices parciais;
- `contatos.lembretes_optout`, `_em`, `_motivo` — o opt-out.

Rollback em `db/010_lembretes_rollback.sql`. **Leia antes de rodar**: ele apaga o
opt-out, ou seja, quem pediu para não receber mais mensagens volta a receber.

`npm run verificar-banco` confere a tabela, as colunas, o RLS e a constraint.
`npm run smoke-lembretes` exercita a fila inteira contra o banco real, com dois
workers simultâneos, e limpa o que criou.

---

## Testes

| Arquivo | O que prova |
| --- | --- |
| `testes/lembretes.test.js` | Regras puras: janelas, decisão, backoff, fuso, texto |
| `testes/lembretes-servico.test.js` | A fila de ponta a ponta: cancelamento, remarcação, opt-out, retry |
| `testes/lembretes-concorrencia.test.js` | Dois workers; unicidade sob enfileiramento paralelo |
| `testes/lembretes-http.test.js` | A API, com RBAC |
| `testes/openclaw-lembretes.test.js` | O adaptador não inventa protocolo |
| `testes/contrato-repositorio.test.js` | Memória e PostgreSQL respondem igual |

A suíte de contrato e a de concorrência também rodam contra PostgreSQL:

```bash
CRMCLINICA_TEST_DATABASE_URL="postgres://..." npm test
```

> **O banco apontado é limpo com `TRUNCATE` a cada execução.** Use um banco de
> teste. Nunca o de produção.
