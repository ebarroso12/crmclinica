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
src/
  config.js         leitura e validação do ambiente, sem expor segredo
  index.js          inicialização do processo
  armazenamento/    registro de idempotência em memória
  contratos/        contrato de eventos — a única porta de entrada de dado externo
  dados/            pool e repositório do inbox (PostgreSQL e memória)
  dominio/          regras do CRM: conversas, leads e ciclo de atendimento
  integracoes/      cliente isolado do OpenClaw
  provedores/       provedor opcional de modelo
  servidor/         HTTP: roteamento, leitura de corpo e cabeçalhos de segurança
testes/         testes de contrato, repositório, atendimento, HTTP e auditoria
documentos/     material de referência do cliente (PRD, roadmap, schema)
docs/           decisões e contratos deste repositório
```

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

O inbox completo está descrito em [`docs/INBOX_LOCAL.md`](docs/INBOX_LOCAL.md) e a
agenda em [`docs/AGENDA.md`](docs/AGENDA.md).

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
pelo banco. Nenhum dado real de paciente foi usado.

Pendente: a régua de confirmação e lembretes (24h e 2h), o follow-up de leads frios,
as métricas e o copiloto. O envio de mensagem depende do OpenClaw, cujo protocolo
ainda não foi confirmado — ver [`docs/OPENCLAW.md`](docs/OPENCLAW.md).

Documentação detalhada em [`docs/`](docs/).
