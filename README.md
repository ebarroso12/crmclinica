# crmclinica

CRM de atendimento da Clínica Dr. Edson Barroso. Projeto novo, construído do zero:
o sistema anterior é consultado como referência, nunca como dependência.

## Papéis

Cada peça tem uma responsabilidade só, e nenhuma invade a da outra:

| Peça | Papel |
| --- | --- |
| **OpenClaw** | Orquestrador de eventos, ferramentas e tarefas. Decide o que acontece e quando. |
| **Serena** | Agente de atendimento. Acolhe, qualifica, encaminha e aplica as barreiras clínicas. |
| **CRM** | Fonte de verdade de contatos, leads, conversas, mensagens, agenda e auditoria. O inbox é o próprio produto. |
| **Prontuário** | Sistema clínico existente. Acessado só por ferramenta autorizada, com escopo mínimo. |
| **Kimi** | Provedor opcional de modelo. Pode ser trocado ou desligado sem afetar o produto. |
| **Canais** | WhatsApp, Instagram, site e formulário, como adaptadores independentes. |

O provedor de modelo nunca orquestra nem decide: é uma escolha interna, atrás do contrato.
Desligar o provedor não muda as regras de atendimento nem derruba o CRM.

Não há orquestrador visual externo neste projeto, e não existe produto com nome
fundido de provedor e orquestrador.

## Estrutura

```text
api/            ponte para a Vercel (mesma aplicação, como função)
db/             migrations do PostgreSQL
public/         interface web (HTML, CSS e JS sem dependência externa)
servicos/       processos separados; gateway seguro da Serena Voz
src/
  config.js         leitura e validação do ambiente, sem expor segredo
  index.js          inicialização do processo
  armazenamento/    registro de idempotência em memória
  contratos/        contrato de eventos — a única porta de entrada de dado externo
  dados/            pool e repositório do inbox (PostgreSQL e memória)
  dominio/          regras do CRM: conversas, leads, agenda, lembretes e atendimento
  integracoes/      clientes isolados do OpenClaw (eventos e lembretes)
  provedores/       provedor opcional de modelo
  servidor/         HTTP: roteamento, leitura de corpo e cabeçalhos de segurança
testes/         testes de contrato, repositório, atendimento, HTTP e auditoria
documentos/     material de referência do cliente (PRD, roadmap, schema)
docs/           decisões e contratos deste repositório
```

## Onde roda

| Ambiente | Endereço |
| --- | --- |
| Produção | https://crmclinica.edsonbarrosojr.com.br |
| Produção (endereço da Vercel) | https://crmclinica-nu.vercel.app |
| Local | http://127.0.0.1:4100 |

O domínio próprio depende de um registro DNS no provedor do domínio:
`A crmclinica → 76.76.21.21`, ou `CNAME crmclinica → cname.vercel-dns.com`.

```bash
npm run verificar-dominio            # em qual etapa o domínio está
npm run verificar-dominio -- --esperar   # acompanha a propagação
```

O comando separa três coisas que falham por motivos diferentes — o nome
resolve, aponta para a Vercel, responde com HTTPS. Sem essa distinção, é fácil
trocar o registro DNS quando o que falta é só o certificado ser emitido.

O **worker de lembretes não roda na Vercel**: função serverless não mantém
processo vivo, então a fila encheria sem nada sair. Ele roda como serviço no
servidor do OpenClaw (`crmclinica-lembretes.service`), e é ele que faz as
mensagens saírem.

## Como rodar

Requer **Node.js 22 ou superior**. Única dependência: `pg`, o driver do PostgreSQL.

```bash
npm install
cp .env.exemplo .env    # preencha só no ambiente local

# Com banco (recomendado) — as migrations são cumulativas, aplique em ordem:
for m in db/0*.sql; do psql "$CRMCLINICA_DATABASE_URL" -f "$m"; done

npm run iniciar          # sobe em http://127.0.0.1:4100
npm test                 # suíte completa (roda sem banco)
npm run verificar        # checagem de sintaxe de todos os arquivos
npm run verificar-banco  # o que está de fato aplicado: tabelas, RLS, papéis
```

`npm run verificar-banco` responde à pergunta que só o banco pode responder — se
as migrations foram aplicadas e se o RLS está ligado. Rode antes de expor
qualquer ambiente: uma tabela sem RLS num projeto Supabase fica legível pela API
REST automática com a chave anônima, que é pública por definição.

### Conecte como `crmclinica_app`, não como `postgres`

```bash
npm run preparar-conexao
```

O comando gera uma senha, aplica na role, testa a conexão nova e só então
reescreve `CRMCLINICA_DATABASE_URL` no `.env`. **A senha não é exibida nem
registrada em log** — existe em memória durante a execução e depois só no `.env`,
que o `.gitignore` protege. É idempotente: rode de novo para rotacionar.

Por que isso não é opcional: `postgres` é dono das tabelas e tem `BYPASSRLS`.
Conectando por ele, o Row Level Security **nunca é avaliado** e todas as
políticas do banco viram decoração — sem erro, sem log, sem sintoma. Em produção
a aplicação recusa subir com conexão privilegiada; fora dela, avisa.

Sem `CRMCLINICA_DATABASE_URL` o inbox roda em memória: útil para desenvolver, mas
nada persiste. Em produção a variável é obrigatória.

## Rotas

| Rota | Método | Descrição |
| --- | --- | --- |
| `/` | GET | Interface web |
| `/health` | GET | Identidade, versão e instante |
| `/api/resumo` | GET | Indicadores do painel e saúde da plataforma |
| `/api/eventos` | POST | Recepção de mensagem de canal, assinada e idempotente |
| `/api/conversas…` | GET/POST/PUT | Inbox: lista, thread, resposta, assumir, etiquetas, ficha |
| `/api/contatos?busca=` | GET | Busca por nome ou telefone, para escolher o paciente |
| `/api/leads` | GET | Kanban de leads |
| `/api/agenda…` | GET/POST | Agenda: grade, horários livres, propor, confirmar, remarcar, cancelar |
| `/api/conversas/:id/agenda` | GET | A agenda do paciente vista de dentro da conversa |
| `/api/lembretes…` | GET/POST | Fila de lembretes: estado, falhas, sincronização, reenfileiramento |
| `/api/contatos/:id/lembretes` | POST | Opt-out e opt-in do paciente |
| `/api/serena…` | GET/POST | Estado, interruptor, prompt versionado e regras |
| `/api/serena/horario` | PUT | Grade de horários; `null` remove o limite |
| `/api/serena/pausa` | POST/DELETE | Pausa com prazo, para intervenção humana |
| `/api/serena/plantao` | POST | Atende fora do horário, sem tocar na grade |
| `/api/serena/voz…` | GET/POST | Laboratório interno de voz, consentimento, sessão e transcrição |

O inbox completo está descrito em [`docs/INBOX_LOCAL.md`](docs/INBOX_LOCAL.md), a
agenda em [`docs/AGENDA.md`](docs/AGENDA.md) e os lembretes em
[`docs/LEMBRETES.md`](docs/LEMBRETES.md).


## Quando a Serena atende

Quatro controles, do mais forte para o mais fraco. A ordem é a regra: cada um
vence os de baixo, e nenhum vence os de cima.

| Controle | O que faz | Volta sozinho? |
| --- | --- | --- |
| **Interruptor** | Cala tudo, sem exceção. Exige motivo. | Não |
| **Pausa** | Cala por N minutos — a intervenção humana. | Sim |
| **Plantão** | Atende fora do horário por N minutos. | Sim |
| **Horário** | A grade semanal, no fuso da clínica. | — |

Pausa e plantão **têm prazo obrigatório**. Pausa sem fim é desligamento que
ninguém lembra de desfazer, e o esquecimento é silencioso: uma Serena muda é
indistinguível de uma Serena que ainda não recebeu mensagem. Pelo mesmo motivo o
plantão não edita a grade — editar para um sábado e esquecer de desfazer faria a
clínica atender todo sábado sem ninguém ter decidido isso.

Os dois se limpam mutuamente ao serem acionados: são intenções opostas, e o
conflito é resolvido na escrita, nunca na leitura.

Sem grade configurada, a Serena atende sempre — ausência de configuração não
vira silêncio. Um dia sem faixa nenhuma, por outro lado, é dia fechado; a tela
diz a diferença.

O horário vale no fuso da clínica (`America/Sao_Paulo`), não no do servidor. Em
UTC, "até as 18h" calaria às 15h e voltaria a falar de madrugada — sem nada no
código parecendo errado.

Calada por qualquer um dos quatro, **a mensagem do paciente continua sendo
gravada**. O que para é a resposta automática, não o inbox.

## Serena Voz (laboratório interno)

O projeto inclui um gateway para o motor livre
[`huggingface/speech-to-speech`](https://github.com/huggingface/speech-to-speech).
Ele nasce desligado, exige consentimento, usa sessões curtas e não armazena
áudio bruto. Nesta fase é só para teste da equipe: não atende pacientes nem
executa ações. Instalação, arquitetura e limites estão em
[`docs/SERENA_VOZ.md`](docs/SERENA_VOZ.md).

## Lembretes de agendamento

Confirmação automática 24h e 2h antes da consulta, pelo WhatsApp, com o OpenClaw
como orquestrador. A fila é persistente e processada por um worker:

```bash
npm run lembretes:worker        # processamento contínuo (pode rodar em duas cópias)
npm run lembretes -- resumo     # estado da fila e modo de entrega
npm run lembretes -- falhas     # o que precisa de atenção
npm run smoke-lembretes         # exercita a fila inteira contra o banco real
```

Duplicidade é impedida pelo banco, não pelo código: `UNIQUE (agendamento_id,
tipo, janela)` para o enfileiramento e `FOR UPDATE SKIP LOCKED` para a
reivindicação. Nada é enviado sem reler o agendamento e o contato — cancelou,
remarcou ou pediu para parar, o lembrete morre.

A mensagem sai pelo método `send` do gateway WebSocket do OpenClaw — o mesmo que
o comando oficial `openclaw message send` usa. O crmclinica se autentica como um
**dispositivo pareado** (chave Ed25519 aprovada uma vez no servidor), porque o
token do gateway sozinho não concede escopo de escrita:

```bash
npm run parear-openclaw   # gera a chave e pede pareamento; aprove no servidor
```

`enviado` só é gravado com confirmação do gateway **e** identificador de
mensagem. Timeout, queda de conexão e resposta sem identificador viram falha com
retry — nunca "enviado". Cada envio carrega uma chave de idempotência que o
próprio gateway deduplica, então o retry não duplica mensagem.

`LEMBRETES_MODO_ENTREGA=dry_run` roda a fila inteira sem enviar nada. Pedir
`real` sem gateway configurado faz o adaptador recusar, em vez de degradar em
silêncio e deixar a clínica achando que está lembrando pacientes. Protocolo e
evidências em [`docs/OPENCLAW.md`](docs/OPENCLAW.md).

## Segurança

- Segredo nenhum entra no Git, no navegador ou em prompt versionado. `.env` é ignorado; só `.env.exemplo` é versionado, sempre com valores em branco.
- Webhook exige assinatura HMAC-SHA256, conferida em tempo constante antes de o corpo ser interpretado.
- Corpo de requisição tem teto de bytes; acima dele a leitura para e a resposta é 413.
- Todo evento externo passa pelo contrato em `src/contratos/evento.js` e recebe chave de idempotência: reenvio não duplica atendimento.
- A interface só carrega recursos do próprio domínio (CSP restritiva, sem script inline e sem CDN).
- Em produção o processo não sobe com configuração insegura — HTTPS e segredo de webhook são obrigatórios.
- `npm test` inclui auditoria executável: termo proibido ou credencial versionada quebra a suíte.

## Estado

O inbox funciona de ponta a ponta: mensagem recebida vira contato, conversa e histórico;
a equipe responde, assume, resolve, etiqueta e edita a ficha; o kanban abre a conversa
que originou cada lead. Autenticação, RBAC, rate limit e qualificação de lead estão
implementados. A agenda marca, remarca e cancela, com o conflito de horário impedido
pelo banco. Os lembretes de 24h e 2h têm fila persistente, worker seguro contra
concorrência, opt-out, retry com backoff e auditoria — verificados contra o banco
real. Nenhum dado real de paciente foi usado.

Os lembretes enviam de verdade: o protocolo do gateway OpenClaw foi verificado na
instalação em produção, o crmclinica está pareado como dispositivo e a entrega é
confirmada mensagem a mensagem ([`docs/OPENCLAW.md`](docs/OPENCLAW.md)).

Pendente: o follow-up de leads frios, as métricas e o copiloto. O cliente de
**eventos de conversa** (`src/integracoes/openclaw.js`) ainda fala HTTP e
precisará migrar para o mesmo gateway — o inbox opera sem ele, então nada se
perde enquanto isso.

Documentação detalhada em [`docs/`](docs/).
