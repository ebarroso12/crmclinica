# OpenClaw — protocolo e envio

Registro do que foi **verificado na instalação em produção** (OpenClaw
`2026.7.1-2`, build `0790d9f`) e na documentação oficial. Cada afirmação abaixo
tem a origem indicada: arquivo, comando ou página. Nada aqui é suposição
apresentada como fato.

> Versão anterior deste documento dizia que o envelope do protocolo era
> desconhecido, e por isso os lembretes ficaram em dry-run. **Isso foi
> resolvido**: o protocolo foi lido do pacote instalado, o crmclinica foi
> pareado como dispositivo e a primeira mensagem real saiu com confirmação do
> gateway. O histórico fica aqui porque explica por que o adaptador tem a forma
> que tem.

## Como se envia uma mensagem

O comando oficial é `openclaw message send`:

```bash
openclaw message send --channel whatsapp --target +5516993120938 --message "…" --json
```

Por baixo, ele chama o método **`send`** do gateway WebSocket. O mesmo método,
com os mesmos parâmetros, é o que o crmclinica usa — não há um caminho paralelo.

| Item | Valor | Onde foi verificado |
| --- | --- | --- |
| Transporte | WebSocket, protocolo v4 | `PROTOCOL_VERSION` em `dist/gateway/protocol/index.js` |
| Endpoint público | `wss://openclaw.edsonbarrosojr.com.br/ws` | sondagem: responde `connect.challenge` |
| Porta interna | `172.17.0.1:18789` | `ss -ltnp`; `gateway.customBindHost` na config |
| Métodos de envio | `send`, `message.action`, `poll` | registro em `dist/server-methods-*.js` |
| Canais configurados | `telegram`, `whatsapp` | `openclaw channels status --json` |
| WhatsApp | `linked: true`, `connected: true` | idem, canal `WhatsApp Web` |

## O envelope

Handshake e frames, conforme `docs.openclaw.ai/gateway/protocol` e confirmados
em execução:

```jsonc
// servidor abre
{ "type": "event", "event": "connect.challenge", "payload": { "nonce": "…", "ts": 1785717830113 } }

// cliente responde
{ "type": "req", "id": "1", "method": "connect", "params": { /* ver abaixo */ } }

// servidor confirma
{ "type": "res", "id": "1", "ok": true, "payload": { "type": "hello-ok", "protocol": 4, … } }
```

Requisição: `{type:"req", id, method, params}`.
Resposta: `{type:"res", id, ok, payload|error}`.
Evento: `{type:"event", event, payload}`.

### Parâmetros de `send`

Schema `SendParamsSchema`, extraído do próprio pacote:

```jsonc
{
  "required": ["to", "idempotencyKey"],
  "properties": {
    "to": "string", "message": "string", "channel": "string", "accountId": "string",
    "idempotencyKey": "string",
    "mediaUrl": "…", "mediaUrls": "…", "buffer": "…", "filename": "…",
    "contentType": "…", "asVoice": "…", "gifPlayback": "…", "agentId": "…",
    "replyToId": "…", "threadId": "…", "forceDocument": "…", "silent": "…",
    "parseMode": "HTML", "sessionKey": "…"
  },
  "additionalProperties": false
}
```

O crmclinica usa cinco: `to`, `message`, `channel`, `idempotencyKey` e
`accountId` quando configurado. `additionalProperties: false` significa que um
campo a mais é recusado pelo gateway — uma barreira a mais contra dado clínico
atravessar por descuido.

### `idempotencyKey` não é enfeite

O gateway **deduplica por ela**. Um `send` repetido com a mesma chave devolve a
resposta em cache (`cached: true`) em vez de mandar de novo — o mecanismo está
em `resolveGatewayInflightRequest` (`dist/send-*.js`), que monta
`dedupeKey = "send:" + idempotencyKey`.

Isso fecha a última janela que a fila do crmclinica sozinha não fecha: worker que
envia, morre antes de gravar `enviado`, e volta a processar a mesma linha. A
chave é derivada do lembrete — mesmo lembrete, mesma chave, uma mensagem só.

Verificado em produção: dois `enviar()` seguidos com o mesmo envelope
devolveram o mesmo `messageId` (`3EB005A3A4D7417C6AE075`), e o log do canal
registrou **um único** `Sent message`.

## A autenticação — o ponto que custou a descobrir

**O token compartilhado do gateway não concede escopo nenhum.** Conectar só com
ele resulta em `scopes: []`, e qualquer método útil responde:

```text
missing scope: operator.read
```

Escopo vem de **dispositivo pareado**: uma chave Ed25519 que o gateway conhece e
que um operador aprovou uma vez. É o mesmo caminho que o CLI oficial e o app
usam — não é um contorno.

### O payload assinado

Formato v3, lido de `buildDeviceAuthPayloadV3` em
`packages/gateway-client/src/device-auth.ts`. Posicional, separado por `|`:

```text
v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
```

- `deviceId` — SHA-256 hex dos 32 bytes crus da chave pública;
- `scopes` — juntos por vírgula, na ordem enviada;
- `token` — o mesmo de `auth` (`token` → `deviceToken` → `bootstrapToken`), ou vazio;
- `platform` e `deviceFamily` — **em minúsculas**; o gateway normaliza antes de
  conferir, e assinar com `Win32` faria a verificação falhar só no Windows;
- assinatura Ed25519 crua, em base64url; chave pública em base64url dos 32 bytes.

Um campo fora de ordem produz assinatura que não confere, e o gateway responde
`NOT_PAIRED` sem dizer por quê. É por isso que
`testes/openclaw-gateway.test.js` verifica a assinatura byte a byte.

### Como parear o crmclinica

```bash
npm run parear-openclaw          # gera a chave, conecta, pede pareamento
```

O comando imprime o `requestId`. No servidor, alguém aprova — é um ato humano
deliberado, e é assim que deve ser:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Rodando `npm run parear-openclaw` de novo, o gateway confirma e emite um
`deviceToken`. Guarde-o em `OPENCLAW_DEVICE_TOKEN`: com ele o worker conecta sem
depender do token compartilhado.

Escopos pedidos: `operator.read` (consultar o estado do canal) e `operator.write`
(enviar). Nada além — pedir mais seria pedir poder que o lembrete não usa.

### A chave privada

Vive em `.openclaw-identidade.json`, que o `.gitignore` cobre e o `npm test`
verifica. Em ambiente sem disco gravável (Vercel), vem de
`OPENCLAW_DEVICE_PRIVATE_KEY` — PEM direto ou em base64, porque painel de
variável costuma achatar as quebras de linha do PEM.

Quem tem essa chave fala pelo crmclinica com o orquestrador. Ela não entra no
repositório em hipótese alguma.

## Confirmação de entrega

`enviado` só depois de o gateway responder `ok` **com identificador de
mensagem** (`messageId`, `id`, `guid`, `toJid`…). Sem identificador, não há prova
de entrega.

Estas três situações **nunca** viram `enviado`:

| Situação | O que acontece |
| --- | --- |
| Timeout | falha com retry — a mensagem pode ter saído, e a `idempotencyKey` impede duplicar |
| Conexão caída | idem |
| Resposta `ok` sem identificador | falha com retry, código `entrega_nao_confirmada` |

Dispositivo não pareado e falta de escopo são falhas **permanentes**: insistir
não aprova ninguém, e retry só gastaria as tentativas.

## O que continua fora

`src/integracoes/openclaw.js` — o cliente de **eventos de conversa** — ainda fala
HTTP (`POST /eventos`), desenho que não corresponde ao transporte real. Ele não
foi migrado nesta rodada porque o inbox opera sem ele: sem integração, a conversa
fica com a equipe em vez de receber resposta automática, e nada se perde.

Quando for migrado, o caminho está pronto: `src/integracoes/openclaw-gateway.js`
já fala o protocolo, e o método de conversa é `chat.send` (visto no registro de
métodos do servidor).

## Arquivos deste repositório

| Arquivo | Papel |
| --- | --- |
| `src/integracoes/openclaw-gateway.js` | O protocolo: handshake, assinatura, RPC |
| `src/integracoes/openclaw-lembretes.js` | O adaptador de lembretes, sobre o gateway |
| `bin/parear-openclaw.js` | Pareamento do dispositivo |
| `testes/openclaw-gateway.test.js` | Protocolo e assinatura, sem rede |
| `testes/openclaw-lembretes.test.js` | O adaptador, com cliente injetado |
