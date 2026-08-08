# Contrato de eventos

Toda informação que entra no crmclinica vindo de fora — canal, formulário ou tarefa concluída
pelo orquestrador — atravessa `src/contratos/evento.js`. Nada chega ao CRM sem passar por aqui.

## Formato aceito

```json
{
  "tipo": "mensagem.recebida",
  "canal": "whatsapp",
  "id_externo": "wa:9821",
  "remetente": "5516999999999",
  "nome": "Marina Souza",
  "texto": "Quero saber sobre a primeira consulta",
  "origem": "landing-page",
  "ocorrido_em": "2026-08-01T12:00:00.000Z"
}
```

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `tipo` | não (padrão `mensagem.recebida`) | um de: `mensagem.recebida`, `lead.criado`, `agendamento.solicitado`, `tarefa.concluida` |
| `canal` | sim | um de: `whatsapp`, `instagram`, `site`, `formulario`, `interno` |
| `id_externo` | sim | identificador do evento no sistema de origem, até 200 caracteres |
| `remetente` | sim | telefone, e-mail ou identificador do contato, até 120 caracteres |
| `nome` | não | até 160 caracteres |
| `texto` | só em `mensagem.recebida` | até 8000 caracteres |
| `origem` | não | campanha, formulário ou ponto de entrada, até 80 caracteres |
| `ocorrido_em` | não (padrão: agora) | data válida; normalizada para ISO 8601 em UTC |

Campos desconhecidos são descartados. `canal` e `tipo` são normalizados para minúsculas, e
todo texto tem espaços das pontas removidos.

## Idempotência

```text
chave = sha256( versão | canal | tipo | id_externo )
```

A chave depende só da **identidade** do evento, nunca do conteúdo. Consequências:

- reenviar o mesmo evento com o texto corrigido devolve o recibo original — não abre segunda conversa;
- o mesmo `id_externo` em canais ou tipos diferentes são eventos distintos, como esperado;
- a chave é estável entre processos e reinícios: não depende de relógio nem de aleatoriedade.

O registro (`src/armazenamento/idempotencia.js`) hoje vive em memória, com janela de 24 horas e
teto de entradas. A interface tem três métodos — `consultar`, `registrar`, `tamanho` — para que
a troca por uma tabela no banco não toque em mais nada.

## Recepção HTTP

`POST /api/eventos`

A ordem das checagens é deliberada, do mais barato e mais desconfiado para o mais caro:

1. **teto de bytes** — acima do limite a leitura para e a resposta é `413`;
2. **assinatura HMAC-SHA256** sobre o corpo bruto, comparada em tempo constante — inválida, `401`;
3. **interpretação do JSON** — malformado, `400`;
4. **contrato** — campo faltando ou inválido, `400` com o nome do campo;
5. **idempotência** — chave já vista devolve `200` com `duplicado: true`;
6. **aceite** — `202` com o recibo.

A assinatura é conferida **antes** do `JSON.parse`: nada não autenticado é interpretado.

Cabeçalho aceito: `x-openclaw-assinatura` (ou `x-openclaw-signature`), no formato
`sha256=<hex>`; o prefixo é opcional.

Sem segredo configurado, o desenvolvimento local aceita eventos sem assinatura. Em produção,
a ausência do segredo torna a rota indisponível (`503`) em vez de aceitar tráfego não verificado.

### Ingresso exclusivo do WhatsApp

`POST /api/canais/whatsapp/eventos` usa o mesmo contrato e a mesma ordem de
validação, mas uma credencial e um adaptador próprios:

- segredo `WHATSAPP_WEBHOOK_SECRET`;
- cabeçalho `x-whatsapp-assinatura` (ou `x-whatsapp-signature`);
- aceita somente `canal=whatsapp`;
- carimba `estrategia_ia=crm_despacha` no servidor;
- recusa qualquer payload que reivindique `openclaw_gerencia`.

Essa separação é uma barreira de autoridade: possuir a credencial do webhook
genérico não concede o direito de fazer o CRM acionar uma resposta no WhatsApp.

## Respostas

| Código | Situação |
| --- | --- |
| `202` | evento aceito e registrado |
| `200` | evento duplicado; devolve o recibo original |
| `400` | corpo vazio, JSON inválido ou fora do contrato |
| `401` | assinatura ausente ou inválida |
| `405` | método diferente de POST |
| `413` | corpo acima do teto |
| `503` | produção sem segredo de webhook configurado |

Recibo de aceite:

```json
{
  "aceito": true,
  "duplicado": false,
  "chave_idempotencia": "…",
  "tipo": "mensagem.recebida",
  "canal": "whatsapp",
  "recebido_em": "2026-08-01T12:00:01.000Z",
  "encaminhamento": "orquestrador"
}
```

`encaminhamento` vale `orquestrador` quando a integração está configurada e
`apenas_registrado` quando não está — o evento nunca é perdido em silêncio.

## Versionamento

O contrato carrega `versao` e ela entra no cálculo da chave. Mudança incompatível sobe a versão,
o que naturalmente separa as chaves antigas das novas sem risco de colisão.
