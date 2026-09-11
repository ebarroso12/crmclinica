# Agentes de atendimento configuráveis

Agente = um assistente de atendimento completo, montado pela tela e não por
código: perfil, trabalho, treinamentos, configurações, ações de inatividade e
canais. É o mesmo formato do construtor de agentes que a equipe já usava numa
plataforma externa — trazido para dentro do CRM, com o CRM como fonte de
verdade da conversa.

O primeiro agente é o **Agente Alpins** (vendedor da Loja Alpins e secretário
do TOP 1922 — Track 3 Colinas), com os dados em
[`configuracao/agentes/alpins.json`](../configuracao/agentes/alpins.json).

## Onde a Serena fica

A Serena continua exatamente como está: conversa da clínica, caminho do
OpenClaw, interruptor/pausa/plantão/horário próprios. Agentes novos rodam num
**motor nativo do CRM**, que usa o gateway multi-IA (`src/ia/gateway.js`) —
catálogo, fallback técnico, telemetria e idempotência que já existem.

## Invariantes (não quebram)

1. **Conversa sem `agente_id` é da clínica** e segue o caminho de hoje, sem
   nenhuma diferença de comportamento.
2. **Conversa de agente nunca é respondida pela Serena/OpenClaw e nunca sai
   pelo número da clínica.** O envio vai pela instância da Evolution do canal
   do agente. Sem essa via disponível, a entrega falha com erro — **nunca**
   cai para o gateway do OpenClaw (que é o WhatsApp da clínica).
3. Interruptor, pausa, plantão e horário da Serena **não** afetam agentes.
   Cada agente tem o próprio `status`: só `ativo` responde. `treinamento` e
   `desativado` gravam a mensagem e não respondem.
4. Controles por conversa continuam valendo para agentes: assumida por humano,
   atribuída, resolvida, pausa temporária — e a barreira final
   (`podeEntregarAgora`) relê o controle antes de todo envio.
5. Idempotência: a resposta gerada para um inbound tem `id_externo`
   `agente:{agente_id}:resposta:{conversa_id}:{mensagem_entrada_id}` (partes
   seguintes: sufixo `:p2`, `:p3`…), e a chamada de IA usa a mesma chave.
6. Mesmo contato falando com a clínica e com um agente = **conversas
   separadas** (a busca de conversa aberta é escopada por agente).
7. Conversa de agente **não** entra no funil de leads da clínica, na lista de
   bloqueio da secretária, nos lembretes de consulta nem no resumo automático
   para a equipe da clínica.
8. Nada de conteúdo de conversa em auditoria — só ids e motivos técnicos.

## Esquema (migration 046 — aplicar ANTES do deploy do código)

O código novo consulta `conversas.agente_id`. Publicar o código antes da
migration quebraria o inbox. Ordem obrigatória: aplicar 046 no Supabase →
confirmar com leitura → merge/deploy.

### `agentes`

| coluna | tipo | regra |
|---|---|---|
| id | bigserial PK | |
| slug | text UNIQUE NOT NULL | `^[a-z0-9-]{2,40}$` |
| nome | text NOT NULL | 1–80 |
| descricao | text | ≤ 160 ("Vendedor em …") |
| status | text NOT NULL DEFAULT 'desativado' | `ativo`, `treinamento`, `desativado` |
| comunicacao | text NOT NULL DEFAULT 'normal' | `formal`, `normal`, `descontraida` |
| comportamento | text NOT NULL DEFAULT '' | ≤ 20000 |
| finalidade | text NOT NULL DEFAULT 'suporte' | `suporte`, `vendas`, `pessoal` |
| empresa_nome | text | ≤ 120 |
| empresa_site | text | ≤ 300 |
| empresa_descricao | text | ≤ 2000 |
| provedor | text | NULL = padrão do catálogo |
| modelo | text | NULL = padrão do catálogo |
| configuracoes | jsonb NOT NULL DEFAULT '{}' | ver abaixo |
| criado_em / atualizado_em | timestamptz | |

### `agente_comportamentos` (histórico do comportamento)

`id`, `agente_id` (FK CASCADE), `comportamento` text, `criado_por` (FK usuarios
SET NULL), `criado_em`. Uma linha por alteração do comportamento — é o que a
tela chama de "Histórico" e permite restaurar.

### `agente_treinamentos`

`id`, `agente_id` (FK CASCADE), `tipo` (`texto`, `website`, `documento`,
`video`), `titulo` (≤ 200), `conteudo` text NOT NULL (≤ 50000), `origem`
(URL ou nome do arquivo, ≤ 500), `status` (`treinado`, `erro`), `criado_em`,
`atualizado_em`.

### `agente_acoes_inatividade`

`id`, `agente_id` (FK CASCADE), `apos_minutos` int (1–10080), `acao`
(`interagir`, `finalizar`), `instrucao` (≤ 512, obrigatória em `interagir`),
`ordem` int. UNIQUE (`agente_id`, `apos_minutos`).

### `agente_canais`

`id`, `agente_id` (FK CASCADE), `canal` (`whatsapp`, `instagram`),
`instancia` text NOT NULL (≤ 100 — nome da instância da Evolution no WhatsApp),
`ativo` boolean DEFAULT true, UNIQUE (`canal`, `lower(instancia)`) — a busca do
dono não diferencia maiúsculas, então a unicidade também não pode.

### `conversas.agente_id`

`bigint NULL REFERENCES agentes(id) ON DELETE RESTRICT`, com índice parcial
`WHERE agente_id IS NOT NULL`. **RESTRICT, não SET NULL**: apagar um agente
com `SET NULL` transformaria as conversas dele em conversas da clínica, e a
mensagem seguinte do cliente iria para a Serena e sairia pelo número da
clínica. Agente sai de uso por `status = 'desativado'`, nunca por DELETE.

RLS/GRANT no mesmo desenho de `db/045` (política `app_trabalho` para
`crmclinica_app`, REVOKE de `anon`/`authenticated`). Par `_rollback.sql`.

### `configuracoes` (jsonb) — chaves e padrão

| chave | padrão | efeito |
|---|---|---|
| `transferir_para_humano` | true | o agente pode passar a conversa para a equipe |
| `resumo_ao_transferir` | true | ao transferir, grava nota privada com resumo |
| `usar_emojis` | false | instrução + limpeza de emoji na saída |
| `assinar_nome` | false | acrescenta "— {nome}" ao fim da resposta |
| `restringir_temas` | true | recusa assunto fora do trabalho/treinamentos |
| `dividir_resposta` | false | quebra resposta longa em várias mensagens |
| `consultar_dados_contato` | true | nome/telefone do contato entram no contexto |
| `busca_inteligente` | true | seleciona os treinamentos relevantes à conversa |
| `fuso` | `America/Sao_Paulo` | data/hora atual dada ao modelo |
| `tempo_resposta_segundos` | 10 | espera antes de responder (agrupa rajadas) |
| `limite_interacoes` | 20 | respostas automáticas por conversa; `null` = sem limite |
| `acao_limite` | `transferir` | `transferir` ou `finalizar` ao atingir o limite |
| `horario` | null | mesma forma da grade da Serena; `null` = sempre |

## Contratos entre as peças

### Repositório (`repositorio.js` e `repositorio-memoria.js`, mesmos nomes)

Forma de agente devolvida por todos os métodos que devolvem agente:

```js
{
  id, slug, nome, descricao, status, comunicacao, comportamento, finalidade,
  empresa_nome, empresa_site, empresa_descricao, provedor, modelo,
  configuracoes,            // objeto já mesclado com os padrões acima
  criado_em, atualizado_em,
  canais: [{ id, canal, instancia, ativo }],
  acoes_inatividade: [{ id, apos_minutos, acao, instrucao, ordem }],
}
```

| método | devolve |
|---|---|
| `listarAgentes()` | agentes (ordem por nome) |
| `obterAgente(id)` | agente ou `null` |
| `obterAgentePorSlug(slug)` | agente ou `null` |
| `obterAgentePorCanal(canal, instancia, { incluirInativos = false })` | agente dono do canal (só canal ativo, salvo `incluirInativos`), ou `null` |
| `criarAgente(dados, { usuarioId })` | agente (slug duplicado → erro com `status = 409`); comportamento inicial não vazio já entra no histórico |
| `atualizarAgente(id, campos, { usuarioId })` | agente; se `comportamento` mudou, grava histórico |
| `listarHistoricoDeComportamento(agenteId, { limite = 20 })` | `[{ id, comportamento, criado_por, criado_em }]` mais recente primeiro |
| `listarTreinamentos(agenteId)` | `[{ id, tipo, titulo, conteudo, origem, status, criado_em, atualizado_em }]` |
| `criarTreinamento(agenteId, dados)` | treinamento |
| `removerTreinamento(agenteId, treinamentoId)` | `true`/`false` |
| `definirAcoesDeInatividade(agenteId, acoes)` | lista nova (substitui todas) |
| `definirCanaisDoAgente(agenteId, canais)` | lista nova (substitui; canal+instância de outro agente → erro `status = 409`) |
| `encontrarOuCriarConversaAberta(contatoId, canal, { agenteId = null } = {})` | conversa aberta **do mesmo escopo** (`agente_id` igual, `null` = clínica) ou nova já com `agente_id` |
| `contarRespostasDaAutomacao(conversaId)` | nº de mensagens `autor_tipo='automacao'` não privadas |
| `listarConversasDeAgenteParaInatividade({ limite = 50 })` | `[{ conversa_id, agente_id, ultima_mensagem_id, ultima_mensagem_em, ultima_mensagem_autor }]` — conversas abertas com agente, não assumidas, sem atribuição, cuja última mensagem não privada é da automação |
| `enfileirarTrabalhoDeOutbox({ …, disponivelEm = null })` | igual a hoje; `disponivelEm` agenda o trabalho |

`obterConversa`/`listarConversas` passam a trazer `agente_id` e `agente_nome`.
`listarConversasEscalonadasSemDono` e a busca de conversas para o resumo da
equipe ignoram conversas com agente.

### Motor (`src/dominio/agentes/motor.js`)

```js
criarMotorDeAgentes({ gateway, agora = () => new Date() }) → {
  decidir(conversa, agente)                      // { responder, motivo }
  gerarResposta({ agente, treinamentos, mensagens, contato, chaveIdempotencia })
    // → { partes: string[], transferir: boolean, motivo: string|null, provedor, modelo }
  gerarResumo({ agente, mensagens, chaveIdempotencia })       // → string
  gerarFollowup({ agente, treinamentos, mensagens, contato, instrucao, chaveIdempotencia })
    // → { partes: string[] }
}
// funções puras exportadas para teste:
montarInstrucoes, selecionarTreinamentos, interpretarSaida, dividirResposta,
normalizarConfiguracoes, CONFIGURACOES_PADRAO
```

`mensagens` = linhas de `mensagens` (`autor_tipo`, `conteudo`, `criado_em`,
`privada`, `tipo`). O motor ignora privadas e de sistema. O modelo responde em
JSON `{"resposta": "...", "transferir_para_humano": false, "motivo": ""}`;
saída que não for JSON vira texto puro (nunca erro).

`decidir` devolve, nesta ordem: `agente_nao_encontrado`, `agente_{status}`
quando não `ativo`, os motivos de `decidirAutomacao` (conversa) e
`fora_do_horario`.

### Evolution com várias instâncias

- `normalizarEventoEvolution(payload, { instanciaPadrao })` inclui
  `instancia` (campo `instance` do webhook da Evolution). O formato novo de
  `id_externo` (`whatsapp:{instancia}:{remetente}:{id}`) só vale quando
  `instanciaPadrao` é informada e difere da instância. **O servidor não
  informa `instanciaPadrao`**: se `EVOLUTION_INSTANCE` da Vercel não bater
  exatamente com o nome que a Evolution manda, a própria clínica passaria a
  gerar outro `id_externo` e a deduplicação com a ponte do OpenClaw quebraria.
  O `key.id` do WhatsApp é gerado por mensagem, e a mesma mensagem não chega
  por duas instâncias; o `remetente` na chave já separa conversas.
- **Quem é dono da mensagem** é decidido no atendimento, não no formato:
  `obterAgentePorCanal(canal, instancia, { incluirInativos: true })`. Achou
  agente → conversa do agente (mesmo com o canal desligado, que só impede o
  envio). Não achou → caminho da clínica, idêntico ao de hoje.
- `normalizarEcoDeEnvioEvolution` inclui `instancia`.
- `validarEvento` aceita `instancia` opcional (≤ 100) sem mudar a chave de
  idempotência.
- `evolution-envio.enviar({ telefone, texto, instancia })` e `enviarMidia`
  usam `instancia` quando informada.
- `canal-conversas.enviar({ …, instancia })`: com instância informada, **só**
  Evolution — sem fallback para o gateway do OpenClaw.

### API (`src/servidor/rotas-agentes.js` + `src/dominio/agentes/servico.js`)

Permissões: `agentes:ler` (admin, gestor) e `agentes:gerenciar` (admin).

| rota | permissão |
|---|---|
| `GET /api/agentes` | ler — lista + catálogo de modelos |
| `POST /api/agentes` | gerenciar |
| `GET /api/agentes/:id` | ler — agente + treinamentos + histórico |
| `PUT /api/agentes/:id` | gerenciar — perfil, trabalho, modelo, configurações; `status` igual ao atual é ignorado e diferente é recusado com 409 (pausar e retomar são rotas próprias) |
| `POST /api/agentes/:id/comportamento/:historicoId/restaurar` | gerenciar |
| `POST /api/agentes/:id/treinamentos` | gerenciar — `texto`, `documento` (texto), `website` (URL buscada no servidor) |
| `DELETE /api/agentes/:id/treinamentos/:treinamentoId` | gerenciar |
| `PUT /api/agentes/:id/inatividade` | gerenciar |
| `PUT /api/agentes/:id/canais` | gerenciar |
| `POST /api/agentes/:id/teste` | gerenciar — conversa de teste, sem gravar nem enviar |
| `GET /api/agentes/aguardando` | ler — conversas de agente esperando a equipe, por agente (selo do menu) |
| `GET /api/agentes/:id/equipe` | ler — quem atende o agente (047) |
| `POST /api/agentes/:id/equipe` | gerenciar — corpo `{ usuario_id }`; repetir não duplica; auditado `agente_equipe_adicionado` |
| `DELETE /api/agentes/:id/equipe/:usuarioId` | gerenciar — auditado `agente_equipe_removido`; quem não estava é 404 |
| `POST /api/usuarios/:id/acesso-clinica` | `usuarios:gerenciar` — corpo `{ acesso_clinica }`; admin é 409; auditado `acesso_clinica_alterado` |
| `GET /api/conversas/escopo` | `conversas:ler` — `{ clinica, agentes }` para as abas da tela |

Toda rota de LEITURA de agente (lista, detalhe, operação, WhatsApp, equipe,
aguardando) passa pelo escopo da migration 047: agente fora da equipe de quem
pede responde 404 e some das listas. Gerenciar é do admin, que vê todos.
| `GET /api/agentes/:id/operacao` | ler — status e quem mudou, números de hoje/7 dias, aguardando, recentes |
| `GET /api/agentes/:id/whatsapp` | ler — estado da instância do agente na Evolution (rota lenta) |
| `POST /api/agentes/:id/whatsapp/conectar` | gerenciar — `{ numero? }`: código de pareamento e QR (rota lenta) |
| `POST /api/agentes/:id/pausar` | gerenciar — `{ motivo? }`: status `desativado`, audita `agente_pausado` |
| `POST /api/agentes/:id/retomar` | gerenciar — sem corpo: status `ativo`, audita `agente_retomado` |

Treinamento por website: só `https`, recusa host local/privado, teto de
tamanho e de tempo, HTML reduzido a texto.

`GET /api/conversas` aceita `agente`: vazio = todas, `clinica` = só as sem
agente, id = só daquele agente; valor inválido é 400. A linha do inbox mostra o
nome do agente como primeiro selo, e a conversa aberta diz "atendida pelo
<agente>" — a thread não assina a resposta do agente como "Serena".

## Painel de operação

A página do agente segue o desenho da tela da Serena, porque é assim que a
equipe já opera a Serena:

1. Cartões de estado: **AGENTE** (Atendendo / Pausado, desde quando, por quem,
   motivo), **WHATSAPP** (estado da instância na Evolution, número e perfil),
   **ENTREGA** (última resposta e última falha `agente_resposta_nao_entregue`)
   e **AGUARDANDO VOCÊ**.
2. **Aguardando você**: conversas que o agente **transferiu para a equipe** e
   que ainda estão **sem responsável** — `transferir` (fluxo.js) grava
   `assumida_por_humano = true` com `atribuido_a` nulo, e esse é o recorte.
   Escalonamento por falha (`agente_escalonada`) **não** entra: `escalonar()`
   não marca a conversa como assumida. A conversa sai quando alguém clica
   "Assumir" ou responde como equipe (responder assume a conversa de agente
   sem responsável). A fila de escalonadas da clínica exclui conversa de
   agente de propósito — sem este bloco, o cliente que pediu gente não
   aparecia para ninguém. O mesmo total vira selo no menu Agentes (atualiza a
   cada minuto).
3. **WhatsApp do agente**: "Conectar WhatsApp" pede à Evolution o código de
   pareamento (com o número) e o QR da instância do canal. O painel **não**
   cria nem apaga instância e **não** mexe em webhook — isso é feito uma vez,
   no servidor. A apikey nunca vai ao navegador
   (`src/integracoes/evolution-instancia.js`).
4. **Controle da automação**: Pausar (motivo opcional, até 200 caracteres) e
   Retomar. A 046 não tem estado "pausado": pausar grava `desativado`, que
   para quem responde cliente tem o mesmo efeito. Retomar sempre pede
   confirmação lembrando de desligar o atendimento do número em outra
   plataforma (GPTMaker) antes — os dois ligados = resposta dupla. O status
   saiu do formulário do perfil: salvar o comportamento nunca muda quem responde.
5. Números de hoje (meia-noite em São Paulo) e dos últimos 7 dias, contados
   pela auditoria das conversas do agente; conversas recentes com botão para
   abrir na tela Conversas.
6. Abas de configuração, na ordem da Serena: Testar o agente, Horário de
   atendimento, Comportamento no ar (com as Versões), Treinamentos; depois
   Trabalho, Configurações, Ações de inatividade e Canais.

O painel nunca recebe conteúdo de mensagem: a API devolve contagens, horários,
nome/telefone do contato e estado — sem prévia. Falha da Evolution vira estado
`erro` no cartão, nunca derruba a página.

Resíduo conhecido: dois administradores pausando no mesmo instante gravam duas
auditorias `agente_pausado` (o status fica certo); a atualização do agente não
é condicional.

Resíduos da auditoria independente (documentados, não corrigidos nesta entrega):

- B4 — o seletor "quem atende" do inbox continua montado depois de sair da conta sem recarregar a página: o próximo usuário vê as opções até recarregar.
- B5 — `resumirOperacaoDoAgente` não tem corte de tempo no WHERE (a "última" ocorrência varre toda a auditoria das conversas do agente); cresce com o histórico.
- B7 — nada impede cadastrar no canal do agente a mesma instância da clínica (`EVOLUTION_INSTANCE`); isso passaria as conversas da clínica para o agente.

## Sinais da clínica não misturam agente

Métricas (`src/dominio/metricas.js`), a view `vw_serena_por_dia` (db/026) e o
alerta crítico do centro operacional contam `escalonada`,
`respondida_pela_automacao`, `automacao_silenciada` e `resposta_nao_entregue`.
O fluxo do agente audita com nomes próprios — `agente_escalonada`,
`agente_respondida`, `agente_automacao_silenciada`,
`agente_resposta_nao_entregue`, `agente_sem_resposta` — e a fila de SLA
(`listarConversasAguardando`) ignora conversa de agente. Resíduo conhecido: a
outbox, ao expirar ou esgotar um trabalho, escala pelo `escalonar` padrão
(`escalonada`), porque não sabe de quem é a conversa. Também não filtram agente,
e ficam como resíduo documentado: `vw_primeira_resposta` e os picos de
atendimento (db/026 e `metricasPicos`), e o alerta de trabalhos mortos/incertos da
outbox no centro operacional. A equipe assumindo ou falhando ao responder numa
conversa de agente audita `agente_assumida_por_humano` /
`agente_resposta_nao_entregue`.

## Ações de inatividade no worker

A varredura roda no `bin/worker-outbox.js` em relógio PRÓPRIO (uma passada
por minuto, até 20 conversas, teto de 20 s), nunca dentro do ciclo da fila: uma
ação "interagir" chama a IA, e com o provedor lento seguraria o lote da
clínica. Cursor por id de conversa: nenhuma conversa fica para sempre fora. O teto
é conferido ENTRE conversas: uma conversa cuja IA percorre o catálogo inteiro pode
passar dele (até ~30 s por modelo). Dimensione `TimeoutStopSec` da unit do worker
com folga (ex.: 300 s); matar no meio deixa a mensagem de "interagir" gravada e
não enviada — nunca duplicada.

## Posse do trabalho da outbox

O lease da outbox (5 min) protege pelo tempo. O fluxo do agente confere e renova
a posse antes de cada parte entregue (`renovarPosse`); se outro worker já retomou,
para sem entregar e a outbox não conclui o trabalho (`outbox_lease_perdido`). A
posse é conferida antes de QUALQUER efeito: depois da geração, antes de escalar
por falha, no começo de cada parte (antes de gravar, escalar por divergência ou
entregar) e antes de transferir.

Resíduo conhecido: numa retomada, a resposta a uma mensagem NOVA do cliente pode
sair no meio das partes que faltavam — a outbox pega trabalhos por
`disponivel_em`, e a espera da retentativa pode ser maior que o tempo de resposta
do agente. Nada se perde nem duplica; só a ordem fica estranha.

## Colocar um agente no ar — nesta ordem

Cada passo abaixo que toca produção exige autorização própria.

1. Aplicar a migration 046 no SQL Editor do Supabase e confirmar com leitura
   (tabelas, RLS, policies, grants) usando a credencial da aplicação.
   Antes de aplicar, no mesmo editor:
   - `SELECT to_regclass('public.agentes'), to_regclass('public.agente_canais'),
     to_regclass('public.agente_canais_instancia_uk'), to_regclass('public.agentes_id_seq');`
     — todos precisam voltar NULL. Objeto já existente com outra forma seria
     pulado em silêncio pelo `IF NOT EXISTS`.
   - `SELECT pid, state, now() - xact_start AS idade, left(query, 80) FROM pg_stat_activity
     WHERE datname = current_database() AND xact_start IS NOT NULL ORDER BY xact_start;`
     — transação longa segura o `ALTER TABLE conversas`. A migration tem
     `lock_timeout` de 5 s: se estourar, nada muda; espere e aplique de novo.
   - Fora do pico de atendimento.
   Depois de aplicar, `npm run verificar-banco` precisa acusar a 046 inteira
   (tabelas, `conversas.agente_id` com FK RESTRICT, índice de canal e SELECT da
   aplicação em `agentes`) — sem isso, não publique o código.
2. Definir `EVOLUTION_INSTANCIAS_CLINICA` com o nome **exato** da instância da
   clínica, na Vercel **e** no `.env` do VPS (são cópias separadas).
   **Nome errado cala a Serena para todo paciente** que chega pela Evolution:
   cada mensagem vira `instancia_sem_agente` e vai para a equipe. O valor de
   `EVOLUTION_INSTANCE` entra na lista sozinho; mesmo assim, logo depois, mande
   uma mensagem de teste para o número da clínica e confira que a Serena responde
   e que não surge `instancia_sem_dono` no `audit_log`.
3. Merge e deploy.
4. Cadastrar o agente e o canal (`npm run semear-agentes -- --arquivo=… --aplicar`
   ou pela tela), ainda `desativado`.
5. Criar a instância do agente na Evolution e ligar o webhook dela (instância
   nova nunca vem com webhook ligado) — só DEPOIS do passo 4, senão as primeiras
   mensagens chegam sem dono.
6. Chaves de IA no `.env` do VPS e reiniciar `crmclinica-outbox.service`;
   confirmar pelo heartbeat no banco.
7. Testar pela aba Teste, depois ligar o agente (`status = 'ativo'`).

## Quem vê o quê (migration 047)

Decisões do Dr. Edson (11/09/2026). A regra mora num lugar só,
`src/seguranca/escopo.js`, e é aplicada no servidor; a tela só evita oferecer o
que responderia 403.

- **Admin vê tudo, sempre**: clínica e todos os agentes, com ou sem marca.
- **"Vê a clínica"** (`usuarios.acesso_clinica`, padrão `true`): quem tem a
  marca vê a clínica. Desmarcada = **colaborador** (na tela: "Colaborador (só
  agentes)"): só as conversas dos agentes em que a pessoa está na **equipe**.
  Sem equipe nenhuma, não vê nada — a tela Usuários avisa.
- **Equipe do agente** (`agente_equipe`): conversa de agente só para quem está
  na equipe daquele agente. Gestor e atendente da clínica fora da equipe não
  veem a conversa, a prévia, o agente nem o painel dele (404).
- **Papel continua valendo**: o escopo diz SOBRE O QUÊ; `rbac.js` diz O QUE.
  Colocar um atendente na equipe não dá a ele `agentes:ler`.
- **Lido do banco a cada requisição**, nunca do token: tirar alguém da equipe
  ou tirar a clínica vale na requisição seguinte. O chat ao vivo renova o escopo
  da conexão a cada minuto (janela máxima de 60 s para quem já está com a aba
  aberta). O admin não consulta nada.
- **Quem não vê a clínica** só alcança `ROTAS_SEM_CLINICA` (conta própria,
  Conversas, contatos dos agentes dele e Agentes). O resto responde
  `403 sem_acesso_clinica` antes de qualquer rota: fila de SLA, tarefas,
  notificações, resumo do painel Hoje, liberar em massa, leads, agenda (inclusive
  a da conversa), temperatura e encerramento de conversa, métricas, IA, Serena,
  Instagram, auditoria, bloqueios, sincronia, lembretes, usuários, cadastro,
  exclusão, restauração, duplicatas e qualidade de contatos. É lista de
  permissão: rota nova nasce fechada para o colaborador.
- **Conversa fora do escopo** responde 404 em toda sub-rota, numa trava única
  antes de despachar e de ler o corpo. Lista com filtro forjado
  (`?agente=` de fora) volta vazia.
- **Contatos** (decisão 11/09): a base é **compartilhada** para quem vê a
  clínica, com **selos automáticos** calculados das conversas — "Clínica"
  (conversa sem agente ou nenhuma conversa) e um selo por agente com quem o
  contato conversou — e filtro Todas / Clínica / agente. Nada é gravado; a tabela
  `etiquetas` (manual, de conversa) não é usada. Quem vê a clínica vê o selo do
  Alpins mesmo fora da equipe, mas não a conversa nem a prévia. Quem não vê a
  clínica só vê contato com conversa de agente da equipe, **nunca** o selo
  "Clínica" (seria dizer que o cliente é paciente), sem notas, observações,
  atributos nem agenda.
- **Chat ao vivo**: replay, push e releitura usam o mesmo `veConversaDe`. Desde
  a 047 o gestor também depende do `agente_id` da conversa: uma consulta por
  evento (como já acontecia com atendente) e, em erro, nega.

### Telas

- **Conversas**: abas "Clínica | <agente>", abrindo em Clínica; quem só tem um
  contexto não vê abas. O painel Hoje só aparece para quem vê a clínica.
- **Menu do colaborador**: Conversas, Contatos e Meu perfil.
- **Usuários (admin)**: "Vê a clínica" no cadastro e na lista, selo
  "Colaborador (só agentes)", equipes da pessoa e aviso "Não vê nada" quando
  falta equipe.
- **Agentes → agente → Equipe**: lista, colocar (admin) e tirar com
  confirmação. Admin não entra na lista de candidatos (sempre vê).

### Publicação (cada passo com autorização própria)

1. Aplicar `db/047_equipe_de_agentes.sql` no SQL Editor do Supabase, fora do
   pico (lock curto em `usuarios`, `lock_timeout` de 5 s). Antes:
   `SELECT to_regclass('public.agente_equipe')` precisa voltar NULL.
2. `npm run verificar-banco` com a credencial da aplicação: tabela, coluna,
   grants (sem UPDATE/TRUNCATE), política, FKs em cascata e o gatilho.
   **Sem a 047 aplicada, o código novo derruba o login** (`CAMPOS_USUARIO` lê
   `acesso_clinica`) — nunca publique antes.
3. Merge e deploy.
4. Marcar os usuários (quem não vê a clínica) e montar as equipes.

Risco de quem já está logado: a marca e a equipe valem na requisição seguinte;
só o chat ao vivo pode levar até 60 s. A tela (menu e abas) de uma aba aberta
antes da mudança só se ajusta ao recarregar — o servidor já recorta.

Resíduos conhecidos: a notificação "Resposta da Serena reprovada" não diz de
qual conversa é (não vaza agente, mas é da clínica e o colaborador não a vê);
o painel de um admin que abre a aba de um agente não mostra o painel Hoje.

## Voltar atrás

1. **Antes de reverter o deploy**, desligue o webhook e a instância do agente na
   Evolution. O código antigo não conhece agente: com conversa de agente aberta
   e webhook ligado, ele reaproveitaria a conversa do agente e a Serena
   responderia o cliente pelo número da clínica.
2. Reverta o deploy (versão anterior do código).
3. A 046 pode ficar aplicada: é compatível com o código antigo enquanto não
   existir conversa de agente. O rollback (`db/046_agentes_rollback.sql`)
   recusa rodar enquanto existir QUALQUER conversa com `agente_id` — inclusive
   resolvida, porque o resumo automático do código antigo não filtra status e
   mandaria conversa de cliente do agente para a equipe da clínica. **Resolver
   não basta:** é preciso exportar e remover essas conversas antes.

## Fora desta entrega (fase 2)

Intenções (chamadas a APIs externas), lembretes marcados pelo agente, resposta
em áudio, agenda do Google pelo agente, servidores MCP, departamentos,
moderação de conteúdo, Instagram do agente, extração de PDF (documento entra
como texto) e treinamento por vídeo.
