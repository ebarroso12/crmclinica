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
| `PUT /api/agentes/:id` | gerenciar — perfil, trabalho, modelo, status, configurações |
| `POST /api/agentes/:id/comportamento/:historicoId/restaurar` | gerenciar |
| `POST /api/agentes/:id/treinamentos` | gerenciar — `texto`, `documento` (texto), `website` (URL buscada no servidor) |
| `DELETE /api/agentes/:id/treinamentos/:treinamentoId` | gerenciar |
| `PUT /api/agentes/:id/inatividade` | gerenciar |
| `PUT /api/agentes/:id/canais` | gerenciar |
| `POST /api/agentes/:id/teste` | gerenciar — conversa de teste, sem gravar nem enviar |

Treinamento por website: só `https`, recusa host local/privado, teto de
tamanho e de tempo, HTML reduzido a texto.

## Sinais da clínica não misturam agente

Métricas (`src/dominio/metricas.js`), a view `vw_serena_por_dia` (db/026) e o
alerta crítico do centro operacional contam `escalonada`,
`respondida_pela_automacao`, `automacao_silenciada` e `resposta_nao_entregue`.
O fluxo do agente audita com nomes próprios — `agente_escalonada`,
`agente_respondida`, `agente_automacao_silenciada`,
`agente_resposta_nao_entregue`, `agente_sem_resposta` — e a fila de SLA
(`listarConversasAguardando`) ignora conversa de agente. Resíduo conhecido: a
outbox, ao expirar ou esgotar um trabalho, escala pelo `escalonar` padrão
(`escalonada`), porque não sabe de quem é a conversa.

## Ações de inatividade no worker

A varredura roda no `bin/worker-outbox.js` em relógio PRÓPRIO (uma passada
por minuto, até 20 conversas, teto de 20 s), nunca dentro do ciclo da fila: uma
ação "interagir" chama a IA, e com o provedor lento seguraria o lote da
clínica. Cursor por id de conversa: nenhuma conversa fica para sempre fora.

## Colocar um agente no ar — nesta ordem

Cada passo abaixo que toca produção exige autorização própria.

1. Aplicar a migration 046 no SQL Editor do Supabase e confirmar com leitura
   (tabelas, RLS, policies, grants) usando a credencial da aplicação.
2. Definir `EVOLUTION_INSTANCIAS_CLINICA` com o nome **exato** da instância da
   clínica, na Vercel **e** no `.env` do VPS (são cópias separadas).
3. Merge e deploy.
4. Cadastrar o agente e o canal (`npm run semear-agentes -- --arquivo=… --aplicar`
   ou pela tela), ainda `desativado`.
5. Criar a instância do agente na Evolution e ligar o webhook dela (instância
   nova nunca vem com webhook ligado) — só DEPOIS do passo 4, senão as primeiras
   mensagens chegam sem dono.
6. Chaves de IA no `.env` do VPS e reiniciar `crmclinica-outbox.service`;
   confirmar pelo heartbeat no banco.
7. Testar pela aba Teste, depois ligar o agente (`status = 'ativo'`).

## Fora desta entrega (fase 2)

Intenções (chamadas a APIs externas), lembretes marcados pelo agente, resposta
em áudio, agenda do Google pelo agente, servidores MCP, departamentos,
moderação de conteúdo, Instagram do agente, extração de PDF (documento entra
como texto) e treinamento por vídeo.
