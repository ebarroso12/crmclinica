# MCP, orquestração e provedor de modelo

## MCP (ferramentas de desenvolvimento)

O projeto carrega os MCPs `codex` e `hermes` em `.mcp.json`. Eles servem aos agentes que
trabalham no código; **não** fazem parte do sistema de atendimento em produção e não têm
qualquer papel em tempo de execução.

## OpenClaw — o orquestrador

O OpenClaw orquestra eventos, ferramentas e tarefas. O CRM fala com ele por um único arquivo,
`src/integracoes/openclaw.js`, e por três caminhos:

- **entrada**: o orquestrador entrega eventos em `POST /api/eventos`, assinados com HMAC-SHA256;
- **WhatsApp**: o plugin confiável persiste cada inbound e o entrega em
  `POST /api/canais/whatsapp/eventos`, com segredo independente;
- **saída**: o CRM despacha eventos já validados e consulta a saúde do orquestrador.

Se o orquestrador estiver fora do ar, `verificarSaude` devolve `indisponivel` e o CRM segue
respondendo — a indisponibilidade dele nunca derruba a fonte de verdade.

Configuração:

```text
OPENCLAW_BASE_URL=https://…        # instância usada pelo canal
OPENCLAW_API_URL=                  # endpoint oficial da API, quando difere da interface
OPENCLAW_TOKEN=
OPENCLAW_SESSION_ID=
OPENCLAW_WEBHOOK_SECRET=           # mínimo 32 caracteres, obrigatório em produção
WHATSAPP_WEBHOOK_SECRET=           # segredo exclusivo do ingresso WhatsApp
OPENCLAW_TIMEOUT_MS=10000
```

`OPENCLAW_API_URL` tem prioridade sobre `OPENCLAW_BASE_URL`. Uma URL de interface com sessão
na query string **não** é endpoint de API e não deve ser configurada como tal.

## Serena — o agente de atendimento

A Serena aplica as regras de atendimento e as barreiras clínicas: acolhe, qualifica, encaminha
e escalona. Ela não diagnostica, não prescreve, não interpreta exame e não promete resultado.
Essas regras são da Serena, não do modelo que responde por trás dela.

## Provedor de modelo (opcional)

O Kimi pode ser usado como provedor de modelo atrás desse contrato. Ele é **opcional** e
**substituível**: sem chave configurada o sistema opera normalmente, apenas sem provedor.

```text
KIMI_API_KEY=
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-latest
```

Regras que não mudam com o provedor:

- nenhuma chamada de modelo parte do navegador — a chave nunca chega ao cliente;
- o prontuário inteiro nunca é enviado ao modelo; vale o escopo mínimo;
- o provedor não decide encaminhamento, não orquestra e não escreve no CRM sozinho;
- trocar de provedor não pode exigir mudança nas regras de atendimento.

A implementação vive isolada em `src/provedores/kimi.js`, atrás de uma interface pequena
(`completar`), justamente para que um segundo provedor entre sem tocar no resto.

## Segredos

Nunca coloque chave real no Git, em `.mcp.json`, no navegador, em prompt versionado ou em
mensagem de atendimento. `.env.exemplo` é versionado sempre com os valores em branco, e
`npm test` falha se uma credencial aparecer em arquivo versionado.
