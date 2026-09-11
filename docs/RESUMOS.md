# Resumo do atendimento por equipe

Pedido de 11/09/2026:

> "resumos estão sendo repetidos e estão demais, envie resumos a cada duas horas; dê a opção de pausar os resumos por usuário, o admin pode fazer isso"
>
> "quem tem de receber resumo é só a equipe, somente a equipe, ou seja a equipe da clínica recebe da clínica e a equipe da Alpins recebe da Alpins"

Código: `src/dominio/resumo-atendimento.js` (ritmo, montagem, entrega),
`src/dominio/destinatarios-resumo.js` (quem recebe), `src/dominio/numeros-internos.js`
(o que a equipe escreve não vira atendimento), `bin/worker-lembretes.js` (onde roda).
Banco: migration 047 (`usuarios.recebe_resumo`, junto com a equipe dos agentes).

## Por que repetia

1. A chave de idempotência da IA era `resumo:conversa:<id>`: o cache do gateway devolvia
   para sempre o texto do **primeiro** resumo da conversa. Agora a chave leva a última
   entrada do contato: `resumo:conversa:<id>:entrada:<id da mensagem>` (+ versão do prompt).
2. A fila reenfileirava com `resumo_enviado_em < ultima_msg_em`, e `ultima_msg_em` anda
   também com a **saída**: cada resposta da equipe ou da automação a um lead já resumido
   mandava o mesmo resumo de novo. Agora só **entrada do contato** depois do último resumo
   devolve a conversa à fila.

## Quem recebe

| Conversa | Recebe | Sai pelo número |
|---|---|---|
| da clínica (sem agente) | admin (sempre) + gestor/atendente com "Vê a clínica" | da clínica |
| de um agente | só quem está na **Equipe** daquele agente — admin só se estiver nela | do agente (`agente_canais`, WhatsApp ativo) |

Em todos os casos a pessoa precisa de:

- conta ativa, liberada (`situacao = 'ativo'`) e não excluída;
- **"Recebe resumos"** ligado (`usuarios.recebe_resumo`, padrão sim; só o admin muda);
- **WhatsApp no cadastro** (DDI/DDD/número) **com a autorização de uso** registrada
  (P1-06, `whatsapp_particular_autorizado`).

Por que a autorização: o aviso-equipe (commit 49a5456) não lê o cadastro — usa a lista do
ambiente —, e a única regra que o sistema tem para mandar mensagem ao número particular de
alguém é essa autorização explícita, com quem e quando autorizou. Número sem autorização não
recebe. O campo livre `usuarios.telefone` não é usado.

Agente sem WhatsApp ativo: o resumo dele **não sai** — nunca pelo número da clínica
(invariante 2 de `docs/AGENTES.md`). O worker avisa no log uma vez.

`CRMCLINICA_RESUMO_DESTINATARIOS` **não decide mais quem recebe**. Continua lida como número
interno (o que esses números escrevem não vira contato) e pelo aviso-equipe.

## Ritmo

- Uma conversa entra quando está em silêncio há `CRMCLINICA_RESUMO_SILENCIO_MIN` minutos
  (padrão 30; produção usa 120).
- **Um resumo por grupo** (a clínica; cada agente) a cada `CRMCLINICA_RESUMO_INTERVALO_MIN`
  (padrão 120), com todos os atendimentos pendentes: cabeçalho de cada contato, resumo da IA
  (ou o recorte de reserva), e no rodapé quantos atendimentos vieram.
- O relógio é o **último `resumo_enviado_em` do grupo no banco** — reiniciar o worker não
  antecipa nada (incidente das 04:55 de 11/09, 126 resumos).
- Mensagens de até ~3.500 caracteres, numeradas "(1/3)"; cada atendimento cai inteiro numa
  parte. No máximo 40 atendimentos por resumo; o resto vai no seguinte (o rodapé avisa).
- Conversa de agente usa prompt próprio (`resumo-agente-v1`), sem lead nem agenda da clínica.

## Duas cópias do worker

`repositorio.executarComTravaDeResumo` usa `pg_try_advisory_xact_lock(47047001)` numa
transação e numa conexão só dela. A cópia que não pega a trava volta na hora, sem mandar
nada. A transação não escreve: as marcas saem pelas conexões normais e já estão confirmadas
quando a trava cai (no ROLLBACK, ou se a conexão morrer), então a cópia seguinte lê o relógio
atualizado. Vale também atrás de pooler em modo transação. Em produção, `crmclinica_app`
tem permissão de executar a função (conferido em 11/09, só leitura).

## Entrega, marca e auditoria

- Entrega **antes** de marcar. Um atendimento só é marcado se a parte em que ele estava
  chegou a **pelo menos uma** pessoa; o resto continua na fila para o ciclo seguinte (que não
  espera o intervalo, porque nada foi marcado).
- A marca não esconde entrada que chegou depois do resumo montado
  (`marcarResumoEnviado(id, { ultimaEntradaId })`).
- Falha vai para `audit_log`: `resumo_nao_entregue` ou `resumo_parcialmente_entregue`
  (entidade `conversa`), com grupo, quantos destinatários, confirmados, falhados e motivos —
  sem telefone (sequência longa de dígitos vira `***`).
- Pausar e retomar: `resumo_pausado` / `resumo_retomado` (entidade `usuario`, detalhe só com
  `usuario_id`).

## Números da equipe não viram atendimento

O resumo vai para o WhatsApp de cada pessoa; a resposta dela e o **eco** do próprio resumo
(`fromMe` da Evolution) chegam pelos webhooks. Todo WhatsApp **autorizado** de conta ativa —
com ou sem resumo ligado — é tratado como número interno:

- no ingresso da clínica (nada é gravado);
- no ingresso de agente (o agente não responde funcionário; nada é gravado);
- no eco, da clínica e do agente (`eco_interno_ignorado`);
- no sincronizador antigo do OpenClaw (modo A).

A lista do cadastro é lida no máximo uma vez por minuto por processo; se o banco falhar,
fica a última lista. A lista do ambiente continua valendo só na clínica, como antes.

## Tela Usuários (admin)

- Botão **WhatsApp** em cada linha: abre o cartão com DDI (padrão 55), DDD e número,
  gravados pela edição completa que já existia (`PUT /api/usuarios/:id`, campo `whatsapp`,
  validação de `whatsappValido`: DDD de 2 dígitos e número de 8 ou 9; o erro aparece no
  cartão). DDD e número vazios tiram o WhatsApp do cadastro.
- Chave **"WhatsApp autorizado para avisos e resumos"** no mesmo cartão, pela rota de P1-06
  (`POST /api/usuarios/:id/whatsapp-particular`, `{ "autorizado": true|false }`), com
  confirmação. A rota grava e audita quem autorizou e quando; o cartão mostra
  "Autorizado por <nome> em <data>". Sem número cadastrado, a chave fica desligada.
- O número em claro só aparece nesse cartão do admin; na lista de usuários, no painel e na
  auditoria, nunca. Depois de salvar ou autorizar, a lista e o painel recarregam — a pessoa
  passa de "sem WhatsApp" ou "não autorizado" para a lista de quem recebe.
- **Meu perfil não cadastra WhatsApp nem autoriza**: `PUT /api/perfil` só aceita nome e
  telefone livre (já era assim, e fica). Autorização é consentimento registrado pelo admin
  (P1-06). A API antiga `GET /api/usuarios/gestao` (só admin, sem uso na tela) continua
  devolvendo os campos do cadastro.
- Chave **"Recebe resumos"** por pessoa (`POST /api/usuarios/:id/recebe-resumo`,
  `{ "recebe_resumo": true|false }`, auditado).
- Aviso na linha de quem deveria receber e não recebe (sem WhatsApp ou sem autorização).
- Painel **"Quem recebe os resumos"** (`GET /api/usuarios/resumos`): destinatários efetivos
  de cada grupo com o número mascarado (`+55 16 9****-3215`), agente sem canal e quem está
  fora com o motivo.

## Publicação — paradas obrigatórias

1. **047 no SQL Editor antes do deploy** (já exigida pela separação clínica × agentes; agora
   inclui `recebe_resumo`, que o login passa a ler). `npm run verificar-banco` depois.
2. **Logo depois do deploy, o admin cadastra e autoriza o WhatsApp de quem deve receber;
   até lá ninguém recebe resumo.** Tela Usuários → botão WhatsApp em cada pessoa → DDI, DDD,
   número → Salvar → "WhatsApp autorizado para avisos e resumos". O painel "Quem recebe os
   resumos" confirma. Leitura de agregados em produção (11/09): 4 usuários ativos,
   **nenhum** com WhatsApp cadastrado ou autorizado. A lista `CRMCLINICA_RESUMO_DESTINATARIOS`
   não é usada como reserva, por decisão; o worker avisa no log enquanto um grupo não tiver
   ninguém.
3. `CRMCLINICA_RESUMO_INTERVALO_MIN` é opcional (padrão 120) no `.env` do worker de lembretes;
   reiniciar o worker depois do deploy.

## Riscos e resíduos conhecidos

- Falha total de canal: o ciclo seguinte (1 min) tenta de novo e grava auditoria de novo —
  mesmo comportamento de antes, agora por atendimento pendente.
- `listarUltimosEnviosDeResumo` agrega `conversas` inteira a cada ciclo com pendências
  (233 linhas em produção em 11/09).
- A trava segura uma conexão do pool do worker enquanto o resumo sai.
- Funcionário que também seja cliente/paciente, escrevendo do WhatsApp autorizado dele, não
  é atendido automaticamente (é tratado como equipe).
- Mudança no cadastro leva até 1 minuto para valer como número interno em cada processo.
