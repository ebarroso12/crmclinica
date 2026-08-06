# ADR: Transporte de Mensagens e Controle da Serena

## Contexto

O projeto CRMClinica utiliza o OpenClaw como orquestrador e a Serena como agente de IA. Recentemente, a integração do cliente de eventos de conversa (`src/integracoes/openclaw.js`) foi migrada de um endpoint HTTP inexistente (`POST /eventos`) para o gateway WebSocket, usando `sessions.list`, `chat.send` e `chat.history`.

No entanto, o fluxo real mapeado revela uma ambiguidade arquitetural e um risco grave de duplicação. O WhatsApp do paciente já está conectado ao OpenClaw, que gerencia a sessão. O fluxo atual é:

1. O paciente envia uma mensagem no WhatsApp.
2. O OpenClaw recebe e adiciona ao `chat.history` da sessão.
3. O worker do CRM (`sincronia-conversas.js`) lê o histórico via polling (`sessions.list` + `chat.history`) e importa a mensagem para o banco de dados.
4. O CRM processa a mensagem e chama `atendimento.responderSePossivel()`.
5. `responderSePossivel()` invoca `orquestrador.despacharEvento()`.
6. O novo `despacharEvento()` (migrado para WebSocket) envia **novamente** o texto da mensagem do paciente para a mesma sessão usando `chat.send`.
7. O OpenClaw recebe o `chat.send`, a Serena processa a mensagem e gera uma resposta no `chat.history`.
8. O CRM, ao fazer polling novamente, importa a resposta da Serena.

Este fluxo introduz uma duplicação potencial, pois a mensagem original do paciente já ingressou no OpenClaw pelo canal do WhatsApp, e o CRM a reenvia via `chat.send`. A chave de idempotência do CRM não identifica a mensagem original do WhatsApp (que entrou por outro mecanismo), gerando risco de a Serena responder duas vezes ou de o histórico ficar inconsistente.

Precisamos definir qual componente controla a conversa e o transporte das mensagens.

## Opções

### Arquitetura A: OpenClaw controla a conversa

Neste desenho, o OpenClaw é o ponto focal da comunicação com o paciente, e a Serena atua diretamente sobre os eventos que chegam do WhatsApp.

**Fluxo:**
* WhatsApp → OpenClaw/Serena → paciente
* OpenClaw → sincronização → CRM
* CRM fornece ferramentas (via MCP) e persiste resultados.

Neste desenho, o CRM **não chama `chat.send`** para repetir a mensagem do paciente. A Serena responde autonomamente dentro do OpenClaw, e o CRM atua como observador (importando o histórico) e provedor de contexto/ferramentas. O controle de ligar/desligar a Serena é feito via `config.set` (política do canal), já implementado em `openclaw-politica.js`.

### Arquitetura B: CRM controla a conversa

Neste desenho, o CRM é o ponto focal. O OpenClaw não responde diretamente pelo canal do WhatsApp.

**Fluxo:**
* WhatsApp → CRM
* CRM → sessão interna da Serena (sem canal atrelado)
* CRM → canal do WhatsApp (usando `canal-conversas.js`)

Neste desenho, o OpenClaw atua apenas como um motor de IA "headless". O CRM recebe a mensagem, envia para a Serena (via `chat.send` em uma sessão de painel/dashboard), aguarda a resposta, e então o próprio CRM envia a resposta para o WhatsApp.

## Vantagens e Riscos

### Arquitetura A (OpenClaw controla)
* **Vantagens:** Aproveita a infraestrutura nativa do OpenClaw para lidar com o WhatsApp; a Serena tem acesso direto ao contexto completo; latência menor para o paciente (a resposta não passa pelo polling do CRM).
* **Riscos:** O CRM pode perder o controle fino sobre o momento exato da resposta; a sincronização de conversas pode sofrer atrasos (polling de 1 minuto).

### Arquitetura B (CRM controla)
* **Vantagens:** O CRM tem controle absoluto sobre cada mensagem; evita duplicação de forma determinística; a lógica de escalonamento humano é mais fácil de impor (o CRM simplesmente não chama a Serena).
* **Riscos:** Maior latência (mensagem → polling CRM → chat.send Serena → polling resposta → send WhatsApp); complexidade extra para manter sessões "sombra" no OpenClaw; subutiliza as capacidades do OpenClaw.

## Decisão

**Adotaremos a Arquitetura A.**

A evidência do código mostra que o projeto foi desenhado para a Arquitetura A:
1. `sincronia-serena.js` usa `openclaw-politica.js` para ligar/desligar a Serena diretamente no gateway (via `dmPolicy`). Se a Arquitetura B fosse a intenção, o CRM simplesmente pararia de enviar mensagens para a Serena, sem precisar alterar a configuração do gateway.
2. `sincronia-conversas.js` já foi construído para ler as respostas da Serena (`assistant`) diretamente do histórico e importá-las para o CRM.
3. O servidor MCP (`bin/mcp-crmclinica.js`) já está integrado para que a Serena, rodando no OpenClaw, chame o CRM para agendar consultas e qualificar leads.

Portanto, o OpenClaw já controla a conversa. O erro na migração recente foi tentar fazer o CRM "empurrar" a mensagem do paciente de volta para a Serena via `chat.send`, criando um loop.

## Consequências

1. O método `despacharEvento` em `openclaw.js` não deve usar `chat.send` para reenviar a mensagem do paciente. Em vez disso, como o OpenClaw já está processando a mensagem autonomamente, o CRM não precisa "despachar" o evento de recebimento de mensagem para o OpenClaw gerar uma resposta.
2. A integração `openclaw.js` original (HTTP) foi construída baseada em um webhook (`POST /eventos`) que orquestraria a IA de fora. Com a adoção da Arquitetura A, o orquestrador (OpenClaw) já faz isso internamente. O CRM atua fornecendo ferramentas (MCP) e controlando o estado (ligado/desligado via `openclaw-politica.js`).
3. O fluxo de `atendimento.responderSePossivel()` precisa ser ajustado para não tentar "empurrar" a mensagem para o OpenClaw, mas sim confiar que a Serena já respondeu (ou responderá) e que o `sincronia-conversas.js` importará essa resposta.

## Fluxo Final

1. **WhatsApp** envia mensagem.
2. **OpenClaw** recebe. Se `dmPolicy` for `open` (Serena ligada), a Serena gera a resposta e envia de volta ao WhatsApp.
3. **Worker do CRM** roda `sincronizarConversas()`:
   * Lê `sessions.list` e `chat.history`.
   * Importa a mensagem do paciente (`user`) para o CRM.
   * Importa a resposta da Serena (`assistant`) para o CRM.
4. **Atendimento** (`receberMensagem`):
   * Grava no banco, qualifica leads, processa opt-outs.
   * Não chama mais `orquestrador.despacharEvento()` para forçar uma resposta, pois a Serena já atua no canal.

## Componentes Removidos
* A chamada a `orquestrador.despacharEvento()` dentro de `atendimento.responderSePossivel()` para o tipo `conversa.mensagem_recebida` se torna redundante para gerar respostas, pois a Serena já está conectada ao canal.

## Componentes Mantidos
* `sincronia-conversas.js` (polling do histórico).
* `openclaw-politica.js` (controle de ligar/desligar a Serena).
* Servidor MCP (ferramentas para a Serena).
* `canal-conversas.js` (envio de mensagens pela equipe humana).

## Teste de Aceitação
1. Uma mensagem enviada pelo paciente gera exatamente 1 registro de entrada no CRM.
2. A Serena gera exatamente 1 resposta no WhatsApp.
3. A resposta da Serena gera exatamente 1 registro de saída no CRM.
4. Não há duplicação de mensagens `user` ou `assistant` no histórico do OpenClaw.
