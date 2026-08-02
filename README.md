# crmclinica

CRM de atendimento da Clínica Dr. Edson Barroso. Projeto novo, construído do zero:
o sistema anterior é consultado como referência, nunca como dependência.

## Papéis

Cada peça tem uma responsabilidade só, e nenhuma invade a da outra:

| Peça | Papel |
| --- | --- |
| **OpenClaw** | Orquestrador de eventos, ferramentas e tarefas. Decide o que acontece e quando. |
| **Serena** | Agente de atendimento. Acolhe, qualifica, encaminha e aplica as barreiras clínicas. |
| **CRM** | Fonte de verdade de contatos, leads, conversas, mensagens, agenda e auditoria. |
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
public/         interface web (HTML, CSS e JS sem dependência externa)
src/
  config.js         leitura e validação do ambiente, sem expor segredo
  index.js          inicialização do processo
  armazenamento/    registro de idempotência
  contratos/        contrato de eventos — a única porta de entrada de dado externo
  dominio/          regras do CRM (resumo operacional)
  integracoes/      cliente isolado do OpenClaw
  provedores/       provedor opcional de modelo
  servidor/         HTTP: roteamento, leitura de corpo e cabeçalhos de segurança
testes/         testes de contrato, HTTP, integração e auditoria
documentos/     material de referência do cliente (PRD, roadmap, schema)
docs/           decisões e contratos deste repositório
```

## Como rodar

Requer **Node.js 22 ou superior**. Não há dependências de terceiros.

```bash
cp .env.exemplo .env    # preencha só no ambiente local
npm run iniciar         # sobe em http://127.0.0.1:4100
npm test                # suíte completa
npm run verificar       # checagem de sintaxe de todos os arquivos
```

## Rotas

| Rota | Método | Descrição |
| --- | --- | --- |
| `/` | GET | Interface web |
| `/health` | GET | Identidade, versão e instante |
| `/api/resumo` | GET | Indicadores do painel e saúde da plataforma |
| `/api/eventos` | POST | Recepção de eventos do orquestrador, assinada e idempotente |

## Segurança

- Segredo nenhum entra no Git, no navegador ou em prompt versionado. `.env` é ignorado; só `.env.exemplo` é versionado, sempre com valores em branco.
- Webhook exige assinatura HMAC-SHA256, conferida em tempo constante antes de o corpo ser interpretado.
- Corpo de requisição tem teto de bytes; acima dele a leitura para e a resposta é 413.
- Todo evento externo passa pelo contrato em `src/contratos/evento.js` e recebe chave de idempotência: reenvio não duplica atendimento.
- A interface só carrega recursos do próprio domínio (CSP restritiva, sem script inline e sem CDN).
- Em produção o processo não sobe com configuração insegura — HTTPS e segredo de webhook são obrigatórios.
- `npm test` inclui auditoria executável: termo proibido ou credencial versionada quebra a suíte.

## Estado

Fundação. As rotas respondem, o contrato de eventos está fechado e testado, e a interface
está montada — mas nenhum dado real de paciente é acessado ainda. Os números do painel
são declaradamente de demonstração até o CRM ser ligado ao banco.

Documentação detalhada em [`docs/`](docs/).
