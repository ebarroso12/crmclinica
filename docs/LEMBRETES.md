# Lembretes de agendamento

Confirmação automática 24 horas e 2 horas antes da consulta, pelo WhatsApp,
com o **OpenClaw** como único orquestrador.

> **Estado da entrega: real.** As mensagens saem pelo canal WhatsApp do OpenClaw,
> com confirmação do gateway a cada envio. O modo é uma variável
> (`LEMBRETES_MODO_ENTREGA`): em `dry_run` a fila roda inteira sem enviar nada,
> o que é o certo para desenvolvimento e para testar mudanças na régua.

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

## Como a mensagem sai

Pelo método **`send`** do gateway WebSocket do OpenClaw — o mesmo que o comando
oficial `openclaw message send` usa. Não há caminho paralelo: o crmclinica fala
o protocolo do orquestrador, não um atalho.

O protocolo inteiro, com a origem de cada regra, está em
[`OPENCLAW.md`](OPENCLAW.md). O que importa aqui:

### A entrega é confirmada, não presumida

`enviado` só depois de o gateway responder `ok` **com identificador de
mensagem**. Três situações nunca viram `enviado`:

| Situação | O que acontece |
| --- | --- |
| Timeout | falha com retry — a mensagem pode ter saído, e a chave de idempotência impede duplicar |
| Conexão caída | idem |
| Resposta `ok` sem identificador | falha com retry, código `entrega_nao_confirmada` |

Uma mensagem que *talvez* tenha saído é tratada como não enviada. É a escolha
segura: o retry é barato, e a duplicata é o erro que o paciente percebe.

### Idempotência de ponta a ponta

Além da constraint do banco, cada envio carrega uma `idempotencyKey`
determinística, derivada do lembrete. **O gateway deduplica por ela** — repetir
o envio devolve a resposta em cache em vez de mandar de novo.

Isso fecha a última janela que a fila sozinha não fecha: worker que envia, morre
antes de gravar `enviado`, e volta a processar a mesma linha. Verificado em
produção: dois envios com o mesmo envelope, um único `Sent message` no log do
canal.

### O dispositivo pareado

O token do gateway sozinho **não concede escopo**: quem envia precisa ser um
dispositivo pareado, com uma chave Ed25519 que um operador aprovou uma vez.

```bash
npm run parear-openclaw               # gera a chave e pede o pareamento
# no servidor:
openclaw devices list
openclaw devices approve <requestId>
npm run parear-openclaw               # confirma e recebe o deviceToken
```

A chave privada fica em `.openclaw-identidade.json` (coberto pelo `.gitignore`,
verificado pelo `npm test`) ou em `OPENCLAW_DEVICE_PRIVATE_KEY` para ambientes
sem disco gravável. Quem a tem fala pelo crmclinica com o orquestrador.

### Voltar para dry-run

`LEMBRETES_MODO_ENTREGA=dry_run`. A fila roda inteira — enfileira, decide, tenta,
registra, audita — e nada sai. É o modo certo para desenvolver e para testar
mudanças na régua sem mandar WhatsApp para ninguém.

Pedir `real` sem gateway configurado **não** degrada para dry-run em silêncio: o
adaptador recusa com `openclaw_indisponivel`, porque o alternativo seria a
clínica achar que está lembrando pacientes e não estar.

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
# Régua
LEMBRETES_ATIVOS=sim              # `nao` desliga o enfileiramento
LEMBRETES_MODO_ENTREGA=real       # `dry_run` roda a fila sem enviar nada
CRMCLINICA_NOME_CLINICA=Clínica Dr. Edson Barroso
LEMBRETES_INTERVALO_MS=60000
LEMBRETES_LOTE=20
LEMBRETES_MAX_TENTATIVAS=5

# Gateway do OpenClaw — é por aqui que a mensagem sai
OPENCLAW_GATEWAY_URL=wss://openclaw.exemplo.com.br/ws
OPENCLAW_GATEWAY_TOKEN=            # necessário no primeiro pareamento
OPENCLAW_DEVICE_TOKEN=             # emitido no pareamento; basta ele depois
OPENCLAW_DEVICE_PRIVATE_KEY=       # PEM ou base64, para ambiente sem disco
OPENCLAW_DEVICE_IDENTITY_PATH=     # padrão: .openclaw-identidade.json
OPENCLAW_CANAL=whatsapp
OPENCLAW_ACCOUNT_ID=               # só quando há mais de uma conta no canal
OPENCLAW_GATEWAY_TIMEOUT_MS=20000
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
| `testes/openclaw-gateway.test.js` | O protocolo e a assinatura do dispositivo, sem rede |
| `testes/openclaw-lembretes.test.js` | O adaptador: envio, confirmação e o que nunca vira "enviado" |
| `testes/contrato-repositorio.test.js` | Memória e PostgreSQL respondem igual |

A suíte de contrato e a de concorrência também rodam contra PostgreSQL:

```bash
CRMCLINICA_TEST_DATABASE_URL="postgres://..." npm test
```

> **O banco apontado é limpo com `TRUNCATE` a cada execução.** Use um banco de
> teste. Nunca o de produção.
