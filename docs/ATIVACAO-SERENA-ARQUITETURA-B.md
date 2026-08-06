# Ativação controlada da Serena no WhatsApp — Arquitetura B

**Data:** 2026-08-06  
**Estado:** código preparado; produção permanece inalterada e o religamento segue
condicionado aos E2E A–E.

**Destino confirmado pelo administrador:** OpenClaw em
`https://openclaw.edsonbarrosojr.com.br`, gateway
`wss://openclaw.edsonbarrosojr.com.br/ws` e linha da clínica
`+55 16 99312-0938`. O vínculo existente deve ser preservado; não gerar novo QR
se o gateway já informar essa linha como conectada.

Este roteiro ativa o desenho decidido em `ADR-HANDOFF-HUMANO-SERENA.md`: o canal
do WhatsApp continua conectado e admite mensagens, o plugin
`crmclinica-ingresso-whatsapp` as persiste e entrega ao CRM, e o hook
`before_agent_reply` encerra o turno direto antes de qualquer chamada ao modelo.
O CRM registra primeiro, aplica horário, pausa, handoff e idempotência, chama a
sessão interna da Serena e só então envia a resposta pelo método `send`.

## Barreiras antes do ensaio

1. A senha do administrador deve ter sido trocada pelo painel e a verificação P1
   pós-troca concluída. Não registrar nem compartilhar a senha no relatório.
2. Usar um número reservado de ensaio, sem conversa real de paciente.
3. Manter `dmPolicy=allowlist` e `allowFrom=[]` enquanto o plugin ainda não
   estiver instalado, carregado e inspecionado. Nesse estado as DMs são
   descartadas; ele é seguro para preparar, mas não atende ao requisito de inbox.
4. No primeiro ensaio, liberar **somente** o número sintético de teste na
   allowlist. Abrir para todos é o último passo, depois dos E2E.
5. Confirmar que o worker não consulta `chat.history` no modo `crm_despacha`.
6. Preencher os segredos somente no ambiente; nunca em arquivo versionado.

## Configuração mínima

Além do banco e das variáveis comuns do worker, o ensaio exige:

```dotenv
SERENA_TRANSPORTE_WHATSAPP=crm_despacha
OPENCLAW_SESSION_ID=<sessao-interna-dedicada>
OPENCLAW_GATEWAY_URL=<gateway-de-comando>
OPENCLAW_DEVICE_TOKEN=<token-ou-use-OPENCLAW_GATEWAY_TOKEN>
OPENCLAW_CLINICA_GATEWAY_URL=wss://openclaw.edsonbarrosojr.com.br/ws
OPENCLAW_CLINICA_DEVICE_TOKEN=<token-ou-use-OPENCLAW_CLINICA_GATEWAY_TOKEN>
WHATSAPP_WEBHOOK_SECRET=<segredo-aleatorio-com-32-ou-mais-caracteres>
CRMCLINICA_INGRESS_URL=https://<dominio-do-crm>/api/canais/whatsapp/eventos
CRMCLINICA_INGRESS_SPOOL_DIR=/root/.openclaw-clinica/crmclinica-ingresso-whatsapp
```

O worker recusa iniciar quando `crm_despacha` está selecionado e qualquer uma
dessas dependências está incompleta. Nesse modo ele não lê sessões ou histórico
do canal e não reescreve `dmPolicy`: o ingresso pertence exclusivamente ao plugin.

## Instalação da ponte antes de admitir DMs

Empacotar e instalar exatamente o diretório versionado:

```bash
cd /caminho/do/crmclinica/integracoes/openclaw-plugin-crmclinica
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/crmclinica-openclaw-ingresso-whatsapp-0.1.0.tgz --force
```

No ambiente do serviço `openclaw-clinica.service`, definir
`CRMCLINICA_INGRESS_URL`, `WHATSAPP_WEBHOOK_SECRET` e, opcionalmente,
`CRMCLINICA_INGRESS_SPOOL_DIR`. No `openclaw.json`, habilitar explicitamente:

```json
{
  "channels": {
    "whatsapp": {
      "pluginHooks": { "messageReceived": true },
      "dmPolicy": "allowlist",
      "allowFrom": ["<numero-sintetico-de-ensaio>"]
    }
  },
  "plugins": {
    "allow": ["whatsapp", "crmclinica-ingresso-whatsapp"],
    "entries": {
      "crmclinica-ingresso-whatsapp": {
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Reiniciar o serviço e exigir três evidências antes de mandar a primeira mensagem:

1. `openclaw plugins inspect crmclinica-ingresso-whatsapp --runtime --json`
   informa o plugin carregado;
2. o gateway fica `ready` e o WhatsApp volta a `Listening`;
3. a pasta do spool existe com modo `0700` e não há erro de configuração do plugin.

O OpenClaw atual não possui modo nativo `listenOnly`. Por isso a allowlist de
ensaio é uma barreira obrigatória: se o hook silencioso não disparar, o teste é
interrompido antes de abrir o número para pacientes.

## Matriz de aprovação E2E

Executar com identificadores e textos exclusivos de ensaio. A evidência deve conter
somente IDs técnicos, horários, ações e contagens — nunca conteúdo de paciente,
tokens, hashes ou segredos.

| Ensaio | Procedimento | Aprovação |
| --- | --- | --- |
| A — ingresso | Enviar uma mensagem do número sintético liberado | Uma entrada aparece em **Conversas** antes de qualquer saída; nenhum run ocorre na sessão WhatsApp |
| B — duplicação | Reentregar o mesmo `messageId` pelo spool | Uma entrada, uma execução da Serena e no máximo um envio no canal |
| C — indisponibilidade | Tornar a rota do CRM temporariamente indisponível e enviar uma mensagem sintética | Item permanece no spool e entra uma vez no CRM após a recuperação |
| D — concorrência | Enviar duas mensagens de ensaio próximas e processar ciclos concorrentes | Cada resposta fica na conversa correta; nenhuma resposta cruza ou duplica |
| E — handoff | Assumir uma conversa de ensaio e manter outra livre | A assumida fica silenciosa; a livre continua recebendo resposta automática |

Também conferir, após cada ensaio:

- a saída aparece uma única vez no histórico da conversa;
- não aparece texto de raciocínio interno, ferramenta ou histórico do agente no inbox;
- o envio da Serena usa chave idempotente `serena:<conversa>:<mensagem>`;
- falha de envio gera `resposta_automacao_nao_entregue` e handoff, nunca sucesso;
- o `audit_log` não contém `senha_hash` nem `totp_segredo_cifrado` em `old` ou `new`.

## Critério de religamento

O atendimento automático só pode avançar do número de ensaio para produção quando
os cinco ensaios estiverem aprovados, a verificação P1 pós-troca estiver concluída
e houver evidência de que o hook direto continua globalmente calado. Só então
trocar `dmPolicy` para `open` e `allowFrom` para `["*"]`. O avanço deve ser
acompanhado pelo painel, pelo spool e pelo `audit_log`.

## Recuo

Em qualquer duplicidade, resposta fora da conversa, falha de handoff ou dúvida:

1. primeiro definir `dmPolicy=allowlist` e `allowFrom=[]`, bloqueando novas DMs;
2. definir `SERENA_TRANSPORTE_WHATSAPP=openclaw_gerencia` somente se a intenção
   for voltar deliberadamente ao modo antigo;
3. reiniciar o gateway e o worker;
4. confirmar que novas mensagens não recebem resposta automática;
5. manter os arquivos pendentes do spool — não apagar — para reentrega controlada;
6. preservar IDs e eventos técnicos para diagnóstico, sem copiar conteúdo sensível.

Esse recuo retorna ao estado calado anterior. Ele não exige alterar o vínculo do
WhatsApp nem apagar histórico.
