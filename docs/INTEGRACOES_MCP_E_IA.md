# MCP e IA no crmclinica

## MCP

O projeto carrega os MCPs de desenvolvimento `codex` e `hermes` em `.mcp.json`.
Eles ajudam os agentes a trabalhar no código; não são necessários para o agente de atendimento em produção.

## Kimi

Kimi não é um MCP neste projeto. Ele é um provedor opcional de modelo chamado pela Serena/OpenClaw através de `src/provedores/kimi.js`.

Configure somente no ambiente:

```text
KIMI_API_KEY=...
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-latest
```

Nunca coloque a chave no Git, em `.mcp.json`, no navegador, em prompts versionados ou em mensagens de atendimento.

O controlador continua sendo o OpenClaw. A Serena continua responsável pelas regras de atendimento e segurança clínica. O Kimi é apenas uma opção de modelo.
