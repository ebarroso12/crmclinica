# Resumo do atendimento por equipe

Pedido de 11/09/2026:

> "resumos estão sendo repetidos e estão demais, envie resumos a cada duas horas; dê a opção de pausar os resumos por usuário, o admin pode fazer isso"
>
> "quem tem de receber resumo é só a equipe, somente a equipe, ou seja a equipe da clínica recebe da clínica e a equipe da Alpins recebe da Alpins"

Código: `src/dominio/resumo-atendimento.js` (janela, ritmo, montagem, entrega),
`src/dominio/destinatarios-resumo.js` (quem recebe), `src/dominio/numeros-internos.js`
(o que a equipe escreve não vira atendimento), `bin/worker-lembretes.js` (onde roda).
Banco: migration 047 (`usuarios.recebe_resumo` e `resumo_envios`, junto com a equipe dos
agentes). Correções da auditoria de 7f8275b marcadas como A1, M1–M3 e B1–B7.

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

**Trocar ou tirar o número zera a autorização (M3)**: a autorização vale para AQUELE
número. Quando os dígitos de DDI+DDD+número mudam (DDI vazio conta como 55) ou o número é
removido, a mesma gravação zera a autorização, a data e o autor e audita
`usuario.whatsapp_particular_revogado` com `{ motivo: 'numero_alterado' }`. Gravar o mesmo
número, formatado ou não, não revoga. A tela avisa que é preciso autorizar de novo.

Agente sem WhatsApp ativo: o resumo dele **não sai** — nunca pelo número da clínica
(invariante 2 de `docs/AGENTES.md`). O worker avisa no log uma vez.

`CRMCLINICA_RESUMO_DESTINATARIOS` **não decide mais quem recebe**. Continua lida como número
interno (o que esses números escrevem não vira contato) e pelo aviso-equipe.

## Janela e ritmo

- **Janela (A1; reconferência B-n1 e B-n2)**: uma conversa entra no resumo do seu grupo
  quando tem **entrada do contato ainda não resumida** (depois da marca `resumo_enviado_em`
  da própria conversa) **nas últimas 24 h**.
  - Quem impede repetir é a marca por conversa.
  - Quem protege o histórico é o teto de 24 h. Conversa antiga sem entrada nova nunca sai,
    nem com saída recente da equipe. O código anterior nunca resumia conversa de agente, e
    sem esse corte a primeira autorização de WhatsApp mandava o histórico inteiro. Com o
    worker parado por dias, entram só as entradas das últimas 24 h.
  - Por que não mais "relógio do grupo − intervalo − silêncio": essa janela perdia
    atendimento de dois jeitos.
    - **B-n1**: a sobra acima de 40 por resumo saía da janela no terceiro ciclo, e o rodapé
      "Mais N" não era cumprido (90 atendimentos saíam 40 + 40 + 0).
    - **B-n2**: a conversa com saídas por mais de intervalo + silêncio depois da última
      entrada esfriava já fora da janela e nunca era resumida.
  - Efeito colateral aceito: o primeiro resumo de um grupo pode trazer até 24 h de entradas
    nunca resumidas, no máximo 40 por resumo, com o resto nos seguintes.
- Uma conversa entra quando está em silêncio há `CRMCLINICA_RESUMO_SILENCIO_MIN` minutos
  (padrão 30; produção usa 120).
- **Um resumo por grupo** (a clínica; cada agente) a cada `CRMCLINICA_RESUMO_INTERVALO_MIN`
  (padrão 120), com os atendimentos pendentes: cabeçalho de cada contato, resumo da IA
  (ou o recorte de reserva), e no rodapé quantos atendimentos vieram.
- O relógio é o **último `resumo_enviado_em` do grupo no banco** — reiniciar o worker não
  antecipa nada (incidente das 04:55 de 11/09, 126 resumos).
- Mensagens de até ~3.500 caracteres, numeradas "(1/3)"; cada atendimento cai inteiro numa
  parte. Bloco longo é cortado por code point, sem partir emoji (B4). No máximo 40
  atendimentos por resumo; o rodapé avisa quantos ficaram para o seguinte.
- Conversa de agente usa prompt próprio (`resumo-agente-v1`), sem lead nem agenda da clínica.

## Duas cópias do worker e pool mínimo

`repositorio.executarComTravaDeResumo` usa `pg_try_advisory_xact_lock(47047001)` numa
transação e numa conexão só dela. A cópia que não pega a trava volta na hora, sem mandar
nada. A transação não escreve: as marcas saem pelas conexões normais e já estão confirmadas
quando a trava cai (no ROLLBACK, ou se a conexão morrer), então a cópia seguinte lê o relógio
atualizado. Vale também atrás de pooler em modo transação. Em produção, `crmclinica_app`
tem permissão de executar a função (conferido em 11/09, só leitura).

**Conexão da trava parada em transação (idle in transaction)**: a transação da trava fica
parada durante toda a varredura (IA, envios, marcas). O pg-pool tira o ouvinte de erro da
conexão emprestada; a trava põe o seu. Se a rede ou o pooler caírem nesse intervalo:

- o erro vai para o log;
- a conexão é descartada, e a trava cai junto;
- o worker segue;
- se outra cópia pegar a trava, o registro de envios impede reenviar.

Leitura de produção em 11/09:

- `idle_in_transaction_session_timeout = 0`, sem configuração por role para `crmclinica_app`;
- `idle_session_timeout = 0`;
- `statement_timeout = 120 s`, que vale só para instrução em execução, não para a transação
  parada.

**Se alguém configurar um `idle_in_transaction_session_timeout` curto no futuro, a varredura
de resumo precisa caber nele.** Do contrário, a trava cai no meio de todo ciclo longo. Duas
cópias podem então resumir juntas: o registro evita envio duplicado, mas a cópia que chega
depois conta como incerto (`resumo_envio_incerto`) o que a outra está enviando.

**Pool mínimo 2 (B6)**: a trava segura uma conexão durante toda a varredura e as consultas
usam outra. Com `CRMCLINICA_DB_POOL_MAX=1` o ciclo travaria até o timeout: o worker
registra o erro na subida e **não liga o resumo** (lembretes e o resto seguem). No VPS o
valor é 3.

## Registro de envios (M2)

A Evolution não recebe chave de idempotência. Cada envio (pessoa × parte) é reservado em
`resumo_envios` **antes** de sair — a tabela não guarda telefone nem texto; a chave é da
pessoa e do conteúdo da parte (ids das conversas e da última entrada, com hash):

- chave nova, ou que tinha `falhou` → reserva (`enviando`) e envia; depois grava `enviado`
  ou `falhou`;
- `enviado` → já chegou: não reenvia e conta como entregue;
- `enviando` encontrado depois → **incerto** (o processo morreu no meio, ou a Evolution não
  confirmou — timeout/ECONNRESET): não reenvia, mesma política de `evolution-envio.js`, e
  conta como entregue. **Deixa rastro (reconferência M-n1)**:
  - auditoria `resumo_envio_incerto` por destinatário e parte, com entidade `sistema` ou
    `agente` e detalhe `grupo`, `agente_id`, `usuario_id`, `conversas`, `parte` e `motivo`
    (`timeout` ou `reserva_orfa`), sem telefone e sem texto;
  - uma linha de log com grupo e conversas;
  - o total do ciclo no log do worker (`envio(s) incerto(s) neste ciclo`);
- sem registro (banco indisponível), não envia.

Um restart entre a parte 1 e a parte 2 não reenvia a parte 1 nem a incerta.

**Parada (SIGINT/SIGTERM) com teto total de 80 s (reconferência B-n3)**, abaixo do
`TimeoutStopSec` padrão do systemd (90 s). O lote corrente, o ciclo de resumo em andamento
(até 60 s) e o fechamento do pool dividem o mesmo prazo. `pool.end()` espera a conexão da
trava voltar, e ela só volta quando a varredura termina, por isso também corre contra o
prazo. Passando do prazo, o worker sai:

- o lote pela metade volta pelo lease de 5 min;
- o registro garante que o que ficou `enviando` não sai duas vezes.

Uma rede de segurança encerra com código 1 em 85 s se algo travar fora dessas esperas. Não é
preciso aumentar o `TimeoutStopSec` do serviço.

## Entrega, marca e auditoria — o que acontece em cada falha (B1)

Entrega **antes** de marcar. Um atendimento é marcado quando a parte em que ele estava
chegou a **pelo menos uma** pessoa (enviado ou incerto).

| Situação | O que acontece |
|---|---|
| Ninguém do grupo recebeu nada (canal fora do ar) | Nada é marcado, o relógio não anda: o ciclo seguinte (1 min) tenta de novo; as chaves com `falhou` voltam a ser tentadas |
| Uma parte não chegou a ninguém, outra parte do mesmo resumo chegou | O relógio anda, então a parte que falhou **espera o intervalo** e volta nos resumos seguintes enquanto a entrada tiver menos de 24 h; depois disso fica só na auditoria |
| Uma pessoa falhou e outra recebeu | O atendimento é marcado e não volta para quem falhou (auditoria "parcial") |
| Envio incerto | Não é repetido; o atendimento é marcado; auditoria `resumo_envio_incerto` |

A marca não esconde entrada que chegou depois do resumo montado
(`marcarResumoEnviado(id, { ultimaEntradaId })`).

**Auditoria (B5)**: a falha vira **um** registro por grupo — entidade `sistema` (clínica)
ou `agente` (id do agente), ação `resumo_nao_entregue` (há atendimento sem entrega) ou
`resumo_parcialmente_entregue`, com grupo, destinatários, `conversas_sem_entrega`,
`conversas_parciais`, `envios_falhados` e motivos distintos — e **no máximo um por grupo por
intervalo** no mesmo processo; com o canal fora do ar não se grava mais uma auditoria por
atendimento a cada minuto. O log do worker continua dizendo, a cada ciclo, quantos
atendimentos ficaram sem entrega.

**Sem telefone (B7)**: nos motivos, qualquer trecho de dígitos com separadores de telefone
("99294-3215", "(16) 99294-3215", "+55 16 99294-3215") que some 8 ou mais dígitos vira
`***`. Pausar e retomar: `resumo_pausado` / `resumo_retomado` (entidade `usuario`, detalhe só
com `usuario_id`).

## Números da equipe não viram atendimento

O resumo vai para o WhatsApp de cada pessoa; a resposta dela e o **eco** do próprio resumo
(`fromMe` da Evolution) chegam pelos webhooks. Todo WhatsApp **autorizado** de conta ativa —
com ou sem resumo ligado — é tratado como número interno:

- no ingresso da clínica (nada é gravado);
- no ingresso de agente (o agente não responde funcionário; nada é gravado);
- no eco, da clínica e do agente (`eco_interno_ignorado`);
- no sincronizador antigo do OpenClaw (modo A).

**Cache só para o SIM (M1)**: a lista do cadastro é lida no máximo uma vez por minuto por
processo, mas um NÃO do cache é conferido no banco na hora quando algo seria **criado**: no
eco, sempre; no ingresso, só quando o telefone ainda não é contato (contato existente não
pesa o webhook). Autorizar alguém e o resumo sair no minuto seguinte não cria mais contato
com o texto do resumo. Se o banco falhar, fica a última lista.

**Comparação em E.164 (B2)**: número do cadastro é comparado completo, com o DDD, só
normalizando o nono dígito brasileiro nas duas formas — cliente de outro DDD com o mesmo
final (551191230047 × 5516991230047) é atendido. A lista antiga do ambiente mantém a regra
de sufixo de 8 dígitos, só na clínica, como antes.

**Admin não testa o agente pelo próprio número (B3)**: quem tem WhatsApp autorizado — admin
inclusive — escrevendo para o número de um agente é tratado como equipe: nada é gravado e o
agente não responde. Para testar o agente pelo WhatsApp, use um número que não esteja
autorizado no cadastro (`docs/AGENTES.md`, "Colocar um agente no ar").

## Tela Usuários (admin)

- Botão **WhatsApp** em cada linha: abre o cartão com DDI (padrão 55), DDD e número,
  gravados pela edição completa que já existia (`PUT /api/usuarios/:id`, campo `whatsapp`,
  validação de `whatsappValido`: DDD de 2 dígitos e número de 8 ou 9; o erro aparece no
  cartão). DDD e número vazios tiram o WhatsApp do cadastro. Trocar ou tirar o número retira
  a autorização e o cartão avisa (M3).
- Chave **"WhatsApp autorizado para avisos e resumos"** no mesmo cartão, pela rota de P1-06
  (`POST /api/usuarios/:id/whatsapp-particular`, `{ "autorizado": true|false }`), com
  confirmação. A rota grava e audita quem autorizou e quando; o cartão mostra
  "Autorizado por <nome> em <data>". Sem número cadastrado, a chave fica desligada.
- O número em claro só aparece nesse cartão do admin; na lista de usuários, no painel e na
  auditoria, nunca. Depois de salvar ou autorizar, a lista e o painel recarregam — a pessoa
  passa de "sem WhatsApp" ou "não autorizado" para a lista de quem recebe.
- **Meu perfil não cadastra WhatsApp nem autoriza**: `PUT /api/perfil` só aceita nome e
  telefone livre (já era assim, e fica). Autorização é consentimento registrado pelo admin
  (P1-06). Atenção: a API antiga `GET /api/usuarios/gestao` (só admin, sem uso na tela)
  continua devolvendo os campos do cadastro **com o número de WhatsApp em claro** — além
  da ficha `GET /api/usuarios/:id`, que é a fonte do cartão de edição. Fora dessas duas
  rotas de admin, o número não sai sem máscara.
- Chave **"Recebe resumos"** por pessoa (`POST /api/usuarios/:id/recebe-resumo`,
  `{ "recebe_resumo": true|false }`, auditado).
- Aviso na linha de quem deveria receber e não recebe (sem WhatsApp ou sem autorização).
- Painel **"Quem recebe os resumos"** (`GET /api/usuarios/resumos`): destinatários efetivos
  de cada grupo com o número mascarado (`+55 16 9****-3215`), agente sem canal e quem está
  fora com o motivo.

## Publicação — nesta ordem (cada passo que toca produção com autorização própria)

1. **047 aplicada** no SQL Editor (`agente_equipe`, `usuarios.acesso_clinica`,
   `usuarios.recebe_resumo`, `resumo_envios`) e `npm run verificar-banco` verde. Sem ela, o
   login cai (`CAMPOS_USUARIO`) e o worker não reserva envio.
2. **Deploy da Vercel** (merge) — é ela que filtra os números internos no webhook e no eco —
   **antes** do worker novo.
3. **No VPS, parar TODAS as cópias do worker de lembretes** (a versão antiga não tem trava
   nem registro de envios) → `git pull` → conferir **`CRMCLINICA_DB_POOL_MAX` ≥ 2** no
   `.env` do worker (`CRMCLINICA_RESUMO_INTERVALO_MIN` é opcional, padrão 120).
4. **Com o worker parado**, o admin cadastra e autoriza os WhatsApps de quem deve receber
   (tela Usuários → WhatsApp → DDI, DDD, número → Salvar → "WhatsApp autorizado para avisos
   e resumos") e **espera 2 minutos** (validade do cache de números internos nas instâncias
   já quentes). O painel "Quem recebe os resumos" confirma.
   **Custo e resíduo desse cache (reconferência B-n4, sem mudança de comportamento):**
   - no **eco**, todo "não é da equipe" do cache é conferido no banco: **uma consulta por
     eco** de número fora da equipe;
   - no **ingresso**, **contato que já existe não é reconferido**: um número autorizado há
     menos de 1 minuto que já era contato ainda é tratado como cliente (a mensagem entra na
     conversa dele) até o cache da instância vencer.

   É por isso que este passo espera 2 minutos com o worker parado. Leitura de agregados em
   produção (11/09): 4 usuários ativos, **nenhum** com WhatsApp cadastrado ou autorizado —
   até este passo, ninguém recebe resumo; a lista `CRMCLINICA_RESUMO_DESTINATARIOS` não é
   usada como reserva, por decisão.
5. **Subir o worker** e conferir no log `[resumo] por equipe, um a cada … min`. Se aparecer
   `CRMCLINICA_DB_POOL_MAX=… é pouco para o resumo`, o resumo está desligado.

## Riscos e resíduos conhecidos

- A trava segura uma conexão do pool do worker enquanto o resumo sai (daí o mínimo 2).
- `listarUltimosEnviosDeResumo` agrega `conversas` inteira a cada ciclo com pendências
  (233 linhas em produção em 11/09).
- A limitação de auditoria (uma por grupo por intervalo) vive no processo: reiniciar o
  worker pode antecipar uma auditoria — nunca um envio.
- Parte que falhou para todos volta a cada resumo do grupo enquanto a entrada tiver menos de
  24 h (no máximo ~12 tentativas com intervalo de 2 h); depois fica só na auditoria.
- **`resumo_envios` cresce sem limpeza** (resíduo aceito na reconferência de acesso).
  - **Crescimento:** cerca de uma linha por pessoa × parte a cada resumo do grupo. Com
    intervalo de 2 h são até 12 resumos por grupo por dia; com 5 pessoas e 1–2 partes, dá
    ~60–120 linhas por dia por grupo (~22–44 mil por ano). A linha é pequena (chave, ids,
    status, datas), sem telefone e sem texto.
  - **Sem limpeza no código:** o `crmclinica_app` não tem DELETE na tabela (a reconferência
    viu `42501`) e não ganha só por isso.
  - **Índice:** já existe por `usuario_id` (`resumo_envios_usuario_idx`), para a FK com
    CASCADE.
  - **Rotina futura sugerida** (com autorização própria, como toda escrita em produção):
    - um job do dono das tabelas apaga linhas com `criado_em < now() - interval '30 days'`;
    - o registro só protege contra reenviar o mesmo resumo, e nenhuma conversa volta ao
      resumo depois de 24 h (a janela), então 30 dias é folga;
    - a mesma mudança cria o índice por `criado_em` que o job precisar.
- Funcionário que também seja cliente/paciente, escrevendo do WhatsApp autorizado dele, não
  é atendido automaticamente (é tratado como equipe).
