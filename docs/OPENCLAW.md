# OpenClaw — endpoint técnico

Registro do que foi **descoberto por sondagem** da instância pública
`https://openclaw.edsonbarrosojr.com.br`, e do que **continua desconhecido**.
Nada aqui é suposição apresentada como fato.

## Confirmado

| Item | Evidência |
| --- | --- |
| A instância está de pé | `GET /health` e `GET /healthz` → `{"ok":true,"status":"live"}` |
| A interface é uma SPA chamada "OpenClaw Control" | `<title>OpenClaw Control</title>` |
| O transporte técnico é **WebSocket**, não REST | CSP da página: `connect-src 'self' ws: wss:`; nenhum caminho REST responde |
| O proxy aceita upgrade WebSocket | `Upgrade: websocket` devolve **101** em `/`, `/ws`, `/gateway`, `/socket` |
| A porta interna padrão é `18789` | string `ws://127.0.0.1:18789` no bundle da interface |
| A porta 18789 **não** está exposta publicamente | conexão direta na porta não responde — fica atrás do proxy |
| A autenticação usa token (e opcionalmente senha) e um id de sessão | parâmetros `gatewayUrl`, `token`, `password`, `gatewaySessionId` |
| Não existe REST em `/api`, `/api/v1` ou `/openapi.json` | todos devolvem **404** |

Endpoint registrado em `.env.exemplo`:

```text
OPENCLAW_API_URL=wss://openclaw.edsonbarrosojr.com.br
```

A URL `/chat?session=…` **não** é API: é a interface de sessão da SPA, e nunca foi
usada como endpoint técnico neste código.

## Não confirmado — e por isso não implementado

Alguns nomes de método aparecem no bundle da interface — `chat.history`,
`chat.abort`, `chat.updating`, `session.message` — mas **o envelope do protocolo não
foi determinado**: não se sabe o formato da mensagem (há `id`? é JSON-RPC? os campos
ficam em `params`?), nem a sequência do handshake de autenticação.

Implementar o cliente WebSocket a partir desses fragmentos seria adivinhar o
protocolo — exatamente o mesmo erro que inventar a URL. Por isso **não foi feito**.

### Consequência para os lembretes

Os lembretes de agendamento (24h e 2h) estão implementados por inteiro — fila
persistente, worker, retry, opt-out, auditoria — e operam em **dry-run**: a fila
processa e nenhuma mensagem sai. O adaptador
(`src/integracoes/openclaw-lembretes.js`) carrega uma constante
`PROTOCOLO_CONFIRMADO = false`, e enquanto ela for falsa, pedir envio real
devolve `openclaw_protocolo_desconhecido` em vez de improvisar um envelope.

Isso é deliberado: um envio "bem-sucedido" contra um formato inventado marcaria
`enviado` na fila sem entregar nada, e o erro só apareceria quando um paciente
reclamasse de não ter recebido. Detalhes em [`LEMBRETES.md`](LEMBRETES.md).

### Consequência para o código

`src/integracoes/openclaw.js` hoje fala **HTTP** (`POST /eventos`). Esse desenho
não corresponde ao transporte real e precisará ser trocado por um cliente WebSocket
quando o protocolo for conhecido.

O impacto é contido de propósito: a integração está isolada num arquivo só, atrás de
duas funções (`despacharEvento` e `verificarSaude`). Todo o resto do crmclinica —
inbox, banco, interface — não sabe qual transporte está por trás e não muda.

Enquanto isso, o sistema opera com a integração ausente: a conversa fica com a equipe
em vez de receber resposta automática, e nada se perde.

## Como fechar esta lacuna

Uma destas, em ordem de preferência:

1. **Documentação oficial** do protocolo do gateway OpenClaw;
2. **Captura de uma sessão real** na aba de rede do navegador com a interface aberta — as primeiras mensagens revelam handshake e envelope;
3. **Acesso ao servidor** `193.203.182.112` para ler a configuração do gateway.

Nenhuma delas foi possível aqui: não há credencial do gateway nem acesso ao servidor.
Nenhuma alteração foi feita nesse servidor.
