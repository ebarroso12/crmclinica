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
do WhatsApp continua conectado e recebe mensagens, mas o agente direto fica calado.
O CRM aplica horário, pausa, handoff e idempotência, chama a sessão interna da Serena
e só então envia a resposta pelo método `send`.

## Barreiras antes do ensaio

1. A senha do administrador deve ter sido trocada pelo painel e a verificação P1
   pós-troca concluída. Não registrar nem compartilhar a senha no relatório.
2. Usar um número reservado de ensaio, sem conversa real de paciente.
3. Manter o agente direto do canal em `dmPolicy=allowlist` e `allowFrom=[]`.
4. Confirmar que o número de ensaio pode receber mensagens e que o worker está
   isolado dos pacientes reais.
5. Preencher os segredos somente no ambiente; nunca em arquivo versionado.

## Configuração mínima

Além do banco e das variáveis comuns do worker, o ensaio exige:

```dotenv
SERENA_TRANSPORTE_WHATSAPP=crm_despacha
OPENCLAW_SESSION_ID=<sessao-interna-dedicada>
OPENCLAW_GATEWAY_URL=<gateway-de-comando>
OPENCLAW_DEVICE_TOKEN=<token-ou-use-OPENCLAW_GATEWAY_TOKEN>
OPENCLAW_CLINICA_GATEWAY_URL=wss://openclaw.edsonbarrosojr.com.br/ws
OPENCLAW_CLINICA_DEVICE_TOKEN=<token-ou-use-OPENCLAW_CLINICA_GATEWAY_TOKEN>
```

O worker recusa iniciar quando `crm_despacha` está selecionado e qualquer uma
dessas dependências está incompleta. A cada ciclo ele confirma novamente o canal
calado; se essa confirmação falhar, não importa nem responde mensagens naquele
ciclo.

## Matriz de aprovação E2E

Executar com identificadores e textos exclusivos de ensaio. A evidência deve conter
somente IDs técnicos, horários, ações e contagens — nunca conteúdo de paciente,
tokens, hashes ou segredos.

| Ensaio | Procedimento | Aprovação |
| --- | --- | --- |
| A — duplicação | Entregar uma mensagem ao importador e repetir o mesmo `id_externo` | Uma entrada, uma execução da Serena e no máximo um envio no canal |
| B — releitura | Rodar dois ciclos sem mensagem nova | O segundo ciclo não executa nem envia resposta |
| C — resposta antiga | Deixar histórico anterior na sessão e então enviar uma mensagem nova | Apenas a resposta correlacionada ao novo `runId` é entregue |
| D — concorrência | Enviar duas mensagens de ensaio próximas e processar ciclos concorrentes | Cada resposta fica na conversa correta; nenhuma resposta cruza ou duplica |
| E — handoff | Assumir uma conversa de ensaio e manter outra livre | A assumida fica silenciosa; a livre continua recebendo resposta automática |

Também conferir, após cada ensaio:

- a saída aparece uma única vez no histórico da conversa;
- o envio da Serena usa chave idempotente `serena:<conversa>:<mensagem>`;
- falha de envio gera `resposta_automacao_nao_entregue` e handoff, nunca sucesso;
- o `audit_log` não contém `senha_hash` nem `totp_segredo_cifrado` em `old` ou `new`.

## Critério de religamento

O atendimento automático só pode avançar do número de ensaio para produção quando
os cinco ensaios estiverem aprovados, a verificação P1 pós-troca estiver concluída
e houver evidência de que o agente direto continua globalmente calado. O avanço deve
ser gradual e acompanhado pelo painel.

## Recuo

Em qualquer duplicidade, resposta fora da conversa, falha de handoff ou dúvida:

1. definir `SERENA_TRANSPORTE_WHATSAPP=openclaw_gerencia`;
2. manter `dmPolicy=allowlist` e `allowFrom=[]`;
3. reiniciar somente o worker;
4. confirmar que novas mensagens não recebem resposta automática;
5. preservar IDs e eventos técnicos para diagnóstico, sem copiar conteúdo sensível.

Esse recuo retorna ao estado calado anterior. Ele não exige alterar o vínculo do
WhatsApp nem apagar histórico.
