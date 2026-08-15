# Design — Confiabilidade do crmclinica (P0/P1)

**Data:** 2026-08-14
**Origem:** `docs/auditorias/2026-08-14-auditoria-integral-crm.md`
**Escopo:** arquitetura-alvo para os achados P0 e P1. Não é plano de execução — o plano está em `docs/superpowers/plans/2026-08-14-confiabilidade-crm.md`.
**Estado:** proposta. Nada aqui foi implementado, exceto onde marcado **JÁ FEITO**.
**Revisão independente:** este design foi revisto por um auditor externo em 2026-08-14 (ver `docs/auditorias/2026-08-14-auditoria-integral-crm.md` §12). As premissas de §1, §2, §4, §5, §6, §7(a)(b)(d) e §8 foram confirmadas. Correções aplicadas em §3.2, §7 e §10, marcadas **[CORREÇÃO DA REVISÃO]**.

Este documento descreve o *destino*. Cada seção diz: qual problema resolve (com a referência ao achado), qual é o desenho-alvo, o que muda no código/banco, o que **não** vai mudar (para o desenho não virar reescrita), e como se prova que funcionou.

---

## Princípio geral: um único dono de transação por unidade de trabalho

O crmclinica já tem a abstração certa. `repositorio.comUsuario(quem, acao)` (`src/dados/repositorio.js:347-384`) abre `BEGIN`, registra `{client, usuarioId, claims}` no contexto assíncrono (365-368), roda `acao`, e faz `COMMIT` (370) ou `ROLLBACK` (372+). O helper `consultar` (`repositorio.js:273`) obedece: `contexto.atual()?.client ?? pool`.

O defeito estrutural é que **cinco métodos escapam desse contrato** abrindo `pool.connect()` próprio. Três deles (`registrarMensagem`, `definirEtiquetasDaConversa`, `definirDisponibilidades`) são violações; dois (`comUsuario` e `publicarPromptDaSerena`) são legítimos.

**Regra-alvo, sem exceção:** nenhum método do repositório que não seja o próprio `comUsuario` pode chamar `pool.connect()` sem antes consultar `contexto.atual()`. O padrão canônico já existe no código e é o de `publicarPromptDaSerena` (`repositorio.js:2197-2209`):

```
se existe transação ambiente:
    usa o client dela, NÃO emite BEGIN/COMMIT/ROLLBACK
senão:
    abre conexão própria com BEGIN/COMMIT/ROLLBACK e libera no finally
```

Consequência do desenho, e é deliberada: quando o método roda **dentro** de transação ambiente, ele **não** pode fazer `ROLLBACK` por conta própria em caso de "duplicado" ou situação benigna — abortaria escritas legítimas dos passos vizinhos. A correção já aplicada em `fix/p0-ingresso-whatsapp-transacao` acertou exatamente isso e serve de referência.

**Guarda-corpo permanente:** um teste de contrato que varre `src/dados/repositorio.js` e falha se aparecer um `pool.connect()` novo fora da allowlist (`comUsuario` e os métodos já auditados). Sem isso, a próxima pessoa reintroduz o mesmo bug.

---

## 1. Transação única para contato / conversa / mensagem / etiquetas / outbox

**Problema:** P0-1 (`registrarMensagem`, corrigido em branch não mesclada) e **P0-2** (`definirEtiquetasDaConversa`, sem correção em lugar nenhum). Cadeia real: `http.js:487-489` abre a transação → `atendimento.js:96` grava a mensagem → `atendimento.js:145` chama `sincronizarTemperatura` → `atendimento.js:753-766` → `repositorio.js:906-929` abre conexão isolada e faz `INSERT INTO conversa_etiquetas` contra uma conversa que ainda não commitou. FK `conversa_etiquetas.conversa_id` (`db/001_inbox.sql:107`) sem `DEFERRABLE` ⇒ transação inteira aborta.

**Arquitetura-alvo:** o ingresso de uma mensagem de WhatsApp é **uma** unidade atômica, do primeiro `INSERT` de contato até o `enfileirarTrabalhoDeOutbox`. Ou tudo entra, ou nada entra e o remetente pode reenviar (o webhook é idempotente por `chave_idempotencia` e por `mensagens_id_externo_uk`, então reenviar é seguro).

Nada de novo precisa ser inventado: a transação já existe e já é a única. O que muda é que **todos** os métodos chamados dentro dela passam a participar dela.

**Mudanças:**
- `src/dados/repositorio.js` — `registrarMensagem` (**JÁ FEITO** em `fix/p0-ingresso-whatsapp-transacao`, commit `f1064c0`, falta mesclar), `definirEtiquetasDaConversa`, `definirDisponibilidades`.
- `testes/ingresso-whatsapp-transacao.test.js` — estender a reprodução para cobrir o caminho **completo** de `receberMensagem` com contato novo, não só até `registrarMensagem`.
- Novo teste de contrato: allowlist de `pool.connect()`.

**Explicitamente NÃO faz parte deste desenho:**
- Tornar a FK `DEFERRABLE` — mascararia o defeito real (conexão errada) em vez de corrigi-lo, e enfraqueceria a integridade referencial para todo o resto do sistema.
- Quebrar o ingresso em várias transações — perderia a atomicidade que o comentário de `http.js:470-486` já defende conscientemente.
- Mexer em `publicarPromptDaSerena`, que já está correto.

**Prova:** teste contra Postgres real (`CRMCLINICA_TEST_DATABASE_URL`, nunca produção) que, com contato e conversa **novos**, faz o POST no webhook e exige 202 + linha em `mensagens` + linha em `conversa_etiquetas` + trabalho na `automacao_outbox`. Contra `repositorio-memoria.js` esse teste não prova nada (single-thread, sem MVCC) e não deve ser escrito lá.

---

## 2. Barreira final revalidada — preservar, formalizar, não reescrever

**Estado atual: CORRETO.** Isto está no design apenas para ficar registrado como invariante a proteger, não como coisa a mudar.

`entregarAoPaciente` chama `podeEntregarAgora(conversa.id)` em `atendimento.js:646`, dentro de `if (origem === 'serena')` (645), imediatamente antes de `canal.enviar` (692). `podeEntregarAgora` (`atendimento.js:612-630`) faz `repositorio.obterConversa` fresco — não reaproveita o objeto em memória — e é **fail-closed**: erro na releitura devolve `{permitido:false, motivo:'falha_ao_reler_controle'}` (616-618, 627-629). Quando bloqueia: audita `envio_abortado_por_controle` (651-656), marca `marcarEntregaFalhou` (663-667), reescalona se o motivo não for decisão humana recente (674-678), e `canal.enviar` nunca é chamado (680-682). Resposta de humano (`origem:'equipe'`, 565) não passa pela barreira — correto, não há geração assíncrona entre o clique e o envio. Vale igual no worker, porque o worker delega a mesma função (`automacao-outbox-servico.js:14-19`).

**Invariantes a manter (viram teste, não código novo):**
- I-1: nenhum caminho de envio com `origem === 'serena'` alcança `canal.enviar` sem passar por `podeEntregarAgora`.
- I-2: `podeEntregarAgora` sempre relê do banco; nunca aceita um objeto `conversa` de parâmetro.
- I-3: falha na releitura ⇒ não envia.
- I-4: bloqueio ⇒ `marcarEntregaFalhou` + auditoria, para a mensagem gravada não parecer entregue na tela.
- I-5: o worker não pode ter caminho de envio próprio que contorne `responderSePossivel`.

**A única mudança proposta:** um teste que percorre o grafo de chamadas e falha se surgir um segundo caminho até `canal.enviar`. Hoje isso é garantido por comentário e disciplina.

---

## 3. Idempotência efetivamente-uma-vez

### 3.1 Entrada — já é adequada, com uma lacuna nomeada

Duas camadas hoje: aplicação (`eventos_recebidos` com `ON CONFLICT (chave) DO NOTHING` e tratamento de corrida — quem perde o INSERT lê o recibo de quem ganhou, `repositorio.js:1475-1485`) e banco (`mensagens_id_externo_uk`, `db/001_inbox.sql:91`, usado com `ON CONFLICT (id_externo) DO NOTHING`, `repositorio.js:551-553`). A chave deriva de `versao|canal|tipo|id_externo` (`src/contratos/evento.js:72-77`), nunca do conteúdo — correto: reenvio do mesmo evento com texto reescrito continua sendo o mesmo evento.

**Lacuna:** não há nonce nem timestamp na assinatura HMAC (P2-5), então um request capturado é replayável para sempre. O desenho-alvo aceita isso como decisão consciente — a idempotência downstream neutraliza o efeito — e apenas **documenta** a decisão no código, em vez de fingir que a assinatura protege contra replay. Se um dia for decidido fechar isso, o desenho é: incluir `timestamp` no material assinado, rejeitar fora de uma janela (ex. 5 min), e manter a idempotência como está — nunca substituí-la pela janela.

### 3.2 Saída — assimetria real entre transportes

O gateway OpenClaw usa `idempotencyKey` de verdade (`canal-conversas.js:41-50`). A Evolution API, canal primário hoje, **recebe a chave e a descarta**: `canal-conversas.js:80` já faz `evolucao.enviar({ telefone: destino, texto, chave })`, mas `evolution-envio.js:28` desestrutura só `{ telefone, texto }`. Risco aceito e documentado em `evolution-envio.js:8-14`.

> **[CORREÇÃO DA REVISÃO]** A redação original dizia que a Evolution "nem recebe o parâmetro". Errado — o **chamador já passa a chave uniformemente**. Isso encolhe o escopo: a parte "assinatura uniforme no chamador" **já existe**; o trabalho real é só o adaptador da Evolution passar a usar a chave contra um registro local.

**Arquitetura-alvo:** `enviar` já recebe `chave` em todos os transportes; o que muda é o adaptador da Evolution passar a **usá-la**. Onde o transporte suporta idempotência (OpenClaw), usa. Onde não suporta (Evolution), o adaptador registra a chave num **registro local de envios** (tabela nova ou coluna em `automacao_outbox`) e, antes de chamar a API, verifica se aquela chave já resultou em envio confirmado. Não é idempotência de transporte — é idempotência de aplicação por cima de um transporte que não a oferece.

Isso vale menos que idempotência real, e o desenho reconhece: continua havendo a janela entre "API aceitou" e "registramos que aceitou". A defesa contra essa janela permanece sendo o `LEASE_MS` de 5 min (`automacao-outbox.js:56`) somado à classificação de entrega indeterminada (§5), que já impede retentativa automática do caso ambíguo.

---

## 4. Lease com fencing — já correto, formalizar

**Estado atual: CORRETO.** `reivindicarTrabalhosDeOutbox` usa `FOR UPDATE SKIP LOCKED` numa instrução única que já marca `processando` (`repositorio.js:2605-2622`) — sem intervalo entre selecionar e reservar. O achado N-9 (lease carimbado por lote inteiro, processado serialmente) **já foi corrigido**: `processarLote` renova por trabalho individual antes de processá-lo (`automacao-outbox-servico.js:200-210`), e `renovarReivindicacaoDeOutbox` só grava se `status='processando' AND reivindicado_por=$worker` (`repositorio.js:2652-2661`) — esse `AND` **é** o fencing: um worker que perdeu o trabalho para outro não consegue renovar, e sabe disso pelo número de linhas afetadas.

**Invariantes a manter:**
- I-6: reivindicar e marcar são a mesma instrução SQL.
- I-7: renovação é condicionada a `reivindicado_por = este worker`.
- I-8: renovação que afeta 0 linhas ⇒ o worker abandona o trabalho, **não** envia.

**Mudança proposta:** apenas tornar I-8 explícito no código (hoje depende do fluxo) e cobri-lo por teste de concorrência com dois workers contra Postgres real, no mesmo molde de `testes/lembretes-concorrencia.test.js`.

---

## 5. Retry, backoff e dead-letter — já correto, registrar

Backoff exponencial com teto (`automacao-outbox.js:16-18, 68-72`); esgotado vira `morto` com escalonamento humano automático (`automacao-outbox-servico.js:148-152`); presos há mais que `LEASE_MS` voltam à fila ou viram `morto` contando a tentativa (`repositorio.js:2697-2718`).

**Ponto de desenho que merece ficar explícito porque é sutil e certo:** entrega **indeterminada** (timeout/abort na chamada à Evolution, `evolution-envio.js:52-62`, só `TimeoutError`/`AbortError` — recusa de conexão e falha de DNS seguem retentáveis porque não chegaram a enviar) vira status terminal `incerto`, **nunca reagendado**. `concluirTrabalhoDeOutbox` limpa `reivindicado_por/em` para qualquer status ≠ `processando` (`repositorio.js:2682`), e nem `reivindicarTrabalhosDeOutbox` nem `liberarTrabalhosDeOutboxPresos` selecionam `incerto`. A equipe já foi escalonada antes de retornar (`atendimento.js:443`). Isso é exatamente o certo para uma clínica: em dúvida entre não mandar nada e mandar duas vezes ao paciente, chama um humano.

**Nenhuma mudança proposta.** O desenho registra estes como invariantes.

---

## 6. Chat ao vivo durável

**Problema:** P1-1 e P1-2. O barramento é um `Set` em memória de processo (`eventos-conversas.js:12-54`) rodando atrás de função serverless multi-instância (`api/index.js`, `vercel.json`), sem cursor de reconexão, com a conexão reciclada a cada 270s na Vercel (`http.js:1592-1595`), e com o único polling cobrindo a lista lateral (`app.js:1592`), não a thread aberta. E o evento sai **antes** do COMMIT (`atendimento.js:112` dentro de `comUsuario`).

O comentário em `eventos-conversas.js:6-10` — que justifica o desenho atual dizendo que o app não roda em serverless replicado — está factualmente errado e precisa ser corrigido junto com o código, senão a próxima pessoa vai confiar nele.

**Arquitetura-alvo: o banco é a fonte da verdade do fluxo de eventos; o SSE é só transporte de notificação.**

Três peças:

**(a) Sequência durável por conversa.** Toda mensagem já tem `id` monotônico em `mensagens`. O cursor do cliente passa a ser o maior `mensagem_id` que ele já desenhou naquela conversa (para a thread) e um cursor global de conversa para a lista. Não é preciso inventar tabela de eventos numa primeira etapa: `mensagens.id` já serve como sequência durável para o caso que dói (mensagem do paciente sumindo). Se depois for necessário cobrir eventos que não são mensagem (assumir, resolver, etiqueta), aí sim entra uma tabela `conversa_eventos` com `id bigserial` — mas isso é etapa posterior e não deve bloquear a correção da perda de mensagem.

**(b) Reconexão com recuperação.** O servidor passa a escrever `id: <mensagem_id>` em cada evento SSE (`eventos-conversas.js:25-34`). Na reconexão, o navegador manda `Last-Event-ID` (o `EventSource` faz isso sozinho) ou um parâmetro explícito na querystring, e a rota (`http.js:1533-1599`) **primeiro reenvia do banco tudo que veio depois daquele id**, depois inscreve a conexão no `Set`. Assim a lacuna entre a queda e a reabertura deixa de ser um buraco.

**(c) Rede de segurança independente do SSE.** Polling da **thread aberta**, não só da lista — no mesmo espírito do `setInterval(carregarConversas, 30000)` que já existe. Com cursor, o polling é barato: pergunta "tem coisa depois de X?" e quase sempre a resposta é não. Isso é o que torna o sistema correto mesmo se a instância Vercel que gravou não for a que segura a conexão SSE — o desenho **para de depender** de o emitter em memória alcançar o assinante certo. O emitter continua existindo como caminho rápido (latência baixa quando dá certo), mas deixa de ser a garantia.

**(d) Emissão depois do COMMIT.** `comUsuario` ganha uma fila de efeitos pós-commit: durante a transação, `atendimento.js` **enfileira** "avisar conversa X da mensagem Y" em vez de publicar direto; `comUsuario` drena a fila **depois** do `COMMIT` bem-sucedido, e a descarta no `ROLLBACK`. Isso mantém a intenção do comentário de `atendimento.js:109-111` ("anunciar assim que a mensagem existe no banco") e a torna verdadeira — hoje "existe no banco" ainda não vale para ninguém fora da transação.

**Explicitamente NÃO faz parte:** trocar SSE por WebSocket, introduzir Redis ou Pub/Sub externo, ou migrar o app para fora da Vercel. Nenhum dos três é necessário para eliminar a perda de mensagem, e cada um traz um projeto próprio.

**Prova:** o mesmo cenário já reproduzido (conectar → 2 mensagens → desconectar → 3ª mensagem sem ninguém ouvindo → reconectar) precisa passar a devolver a 3ª mensagem. Hoje devolve 0.

---

## 7. Fluxo de recuperação de senha completo

**Problema:** P1-3 (consumo check-then-act), P2-1 (duplo clique é o gatilho realista), P2-3 (timing, hoje inerte), P2-2 (rotas de senha sem rate limit).

O fluxo já está **quase todo certo** e o desenho preserva tudo que está bom: token de 256 bits (`contas.js:266`), só o hash persistido (`contas.js:18-20, 272`; `db/003_contas.sql:54`), expiração de 1h, token fora do log e removido do histórico do navegador (`app.js:2097`), resposta idêntica para conta existente e inexistente (provado em `contas-http.test.js:257-267`), rate limit em ambas as pontas (`limite.js:26-35` — recuperação 3/h por conta e 10/h por IP; redefinição 10/h por conta e **20/h por IP**, e como a rota não passa e-mail, o teto que vale é o de IP), limitador chamado antes de checar existência (`contas.js:260-261`), sessões revogadas só após sucesso (`contas.js:329`), link montado no servidor a partir de config validada, sem redirect controlável (`contas.js:277`, `config.js:260`).

> **[CORREÇÃO DA REVISÃO]** As citações de `contas.js` para o fluxo de redefinição estão 1-2 linhas deslocadas na auditoria: `redefinirSenha` começa em **306** (não 304), `obterRecuperacaoPorHash` em **310**, a checagem em memória em **312**, `atualizarUsuario` em **323**, `marcarRecuperacaoUsada` em **327**. O desenho de (a) não muda; só as âncoras.

**Arquitetura-alvo — quatro mudanças pontuais:**

**(a) Consumo atômico do token.** O `UPDATE ... WHERE id = $1 AND usado_em IS NULL` que hoje só marca (`repositorio.js:1845-1847`) passa a ser a **porta de entrada** do fluxo, com `RETURNING`. A ordem inverte:

```
1. UPDATE recuperacoes_senha
      SET usado_em = now()
    WHERE hash_token = $1 AND usado_em IS NULL AND expira_em > now()
   RETURNING usuario_id
2. se não retornou linha  → 400 "link inválido ou expirado"  (nada foi alterado)
3. validar situação da conta
4. trocar a senha
5. revogar sessões
6. auditar
```

Quem perder a corrida não retorna linha e não troca senha nenhuma. Passos 3-6 rodam dentro da mesma transação que o passo 1, para que uma falha em qualquer um deles devolva o token ao estado não-usado — senão um erro no meio queimaria o link do usuário sem trocar a senha dele.

**(b) Guarda de duplo clique no `#form-redefinir`** e nos demais formulários de autenticação, usando o padrão `disabled = true` + texto de progresso que **já existe** no arquivo (`app.js:1491-1507`, `1271-1278`, `2543`, `3609-3632`, `4125-4165`). Não é componente novo; é aplicar o padrão do próprio projeto onde ele foi esquecido. Isso remove o gatilho realista de (a) e melhora a percepção de resposta em ~20 formulários.

**(c) Normalizar o tempo de `/api/auth/recuperar`.** O envio SMTP sai do caminho da resposta: `pedirRecuperacao` para de `await`ar o handshake completo (`contas.js:278` → `email.js:54-127`) antes de retornar. Duas formas aceitáveis: enfileirar o e-mail (mesma ideia da outbox, se houver apetite) ou responder e disparar o envio sem bloquear, com o erro de envio indo para log/auditoria e nunca para a resposta. Como a resposta já é deliberadamente idêntica nos dois ramos, o tempo passa a ser também. Hoje o canal está inerte (SMTP desconfigurado) — a mudança é preventiva e deve entrar **antes** de o Edson configurar SMTP, não depois.

**(d) Rate limit nas rotas que verificam senha.** `trocarSenha` (`contas.js:153-192`) e `desativarSegundoFator` (`contas.js:391-411`) passam a chamar `limitador.exigirDentroDoLimite`, com chave por conta (aqui o usuário é conhecido, diferente de `redefinicao`, onde a rota só tem o token). O limitador já suporta isso (`limite.js:26-35`); falta apenas a chamada e a entrada de configuração da ação.

**Explicitamente NÃO faz parte:** mudar o formato do token, o tempo de expiração, o texto das respostas, o desenho do link, ou reativar o botão em produção. O botão continua escondido enquanto `configuracao.email.host`/`remetente` estiverem vazios (`rotas-autenticacao.js:89-95`, `app.js:1736-1737`) — isso é comportamento correto, não defeito.

---

## 8. Botões: contrato entre HTML e JS

**Problema:** P1-4 — `nav [data-tela]` (`app.js:47`) não alcança os botões em `index.html:233` e `:248`, que estão em `<main>` (188+), fora do `<nav>` (155-176). E P2-1/P2-6 — ausência sistemática de guarda de duplo clique e falhas silenciosas.

**Arquitetura-alvo:** `data-tela` vira um contrato global, não um detalhe de posição no DOM. Um único handler delegado em `document` trata qualquer elemento com `data-tela`, onde quer que esteja. Some a dependência de escopo CSS, e botões futuros funcionam por construção.

**O teste tem que mudar junto, senão o defeito volta.** `testes/botoes-orfaos.test.js:74` hoje verifica presença de string no HTML e afirma no comentário da linha 71 que o botão "tem handler de verdade" — falso positivo. O teste-alvo verifica a relação: para cada `data-tela` no HTML, existe um handler que o alcança **considerando o seletor usado**. Enquanto não houver jsdom no projeto (não há, e adicionar dependência é decisão à parte), a verificação viável é: o seletor de `app.js` não pode restringir escopo por ancestral quando o atributo aparece fora daquele ancestral no HTML.

**Guarda de duplo clique:** um helper único (`comBotaoOcupado(botao, fn)`) que encapsula `disabled = true` → texto de progresso → `finally` restaura, aplicado aos formulários listados em P2-1. Um só ponto de manutenção em vez de 20 cópias do mesmo bloco.

**Falhas silenciosas (P2-6):** onde o `catch` engole (`app.js:1743` logout, `:3110` encerrar voz, `:742` checkbox de etiqueta, `:2500-2502` autocomplete), o alvo é: ou a UI reverte ao estado real, ou avisa. O caso mais importante é o checkbox de etiqueta, que hoje fica mostrando um estado que o banco não tem. E `agir()` no inbox passa a repassar `erro.detalhe` em vez de sempre 'A ação não pôde ser concluída.'.

---

## 9. Observabilidade: correlacionar auditoria com requisição

**Problema:** P1-6. `audit_log` (`db/001_inbox.sql:145-153`) tem autor (`usuario_id`, nulo para ação automática — correto) e timestamp, mas **não** tem `origem` nem `correlation_id`. O `request_id` existe (`http.js:1373`) mas morre no log de acesso (`http.js:1378-1382`).

**Arquitetura-alvo:** duas colunas novas em `audit_log`, ambas anuláveis (migration aditiva, sem quebrar nada existente):
- `origem text` — de onde veio a ação: `webhook`, `worker_outbox`, `worker_lembretes`, `worker_google`, `painel`, `agente`, `cli`.
- `correlation_id text` — o `request_id` da requisição HTTP, ou um id gerado pelo worker no início de cada trabalho de outbox.

Ambas viajam pelo **mesmo contexto assíncrono** que já carrega `client`/`usuarioId`/`claims` (`repositorio.js:365-368`). `registrarAuditoria` (`repositorio.js:1494-1505`) lê do contexto exatamente como já faz com `usuarioId`. O chamador não precisa passar nada — é isso que evita que a coluna fique vazia por esquecimento, que é como `origem` acabaria se dependesse de cada `registrarAuditoria` lembrar.

`redigirAuditoria` (`src/seguranca/redator-auditoria.js`) continua governando `detalhe`, sem mudança. As duas colunas novas nunca recebem dado clínico — só identificadores técnicos.

**Não faz parte:** propagar `correlation_id` para o transporte externo (Evolution/OpenClaw), reter mais tempo, ou mudar o esquema de retenção — tudo isso é outro projeto.

---

## 10. Migrations e reconciliação de drift

**Problema:** P1-5. Objetos reais em produção sem arquivo de origem **em `db/*.sql`**: 53 policies `crm008_*`, 3 funções `SECURITY DEFINER` (`current_usuario_id`, `is_admin_master`, `is_colaborador`), 10 policies `restrict_*` para `authenticated`, e a view `v_metricas_uso_usuarios_dia`.

> **[CORREÇÃO DA REVISÃO — duas coisas mudam o desenho desta seção]**
> 1. **Não parta do zero.** O drift 008/009 já tem plano escrito e inventário: `docs/PLANO-RECONSTRUCAO-008-009.md` (snapshot real de 2026-08-08 via `pg_get_functiondef`, com o `CREATE OR REPLACE FUNCTION` de cinco funções, incluindo `current_usuario_id()` na linha 63) e a ferramenta versionada somente-leitura `ferramentas/extrair-definicoes-008.js`. A migration de reconciliação deve **partir da saída dessa ferramenta**, não de um inventário novo de memória.
> 2. **Os números não têm artefato.** As contagens (53/10/3/1, 40 tabelas com RLS, zero GRANT para `anon`/`authenticated`) não puderam ser reexecutadas por um segundo auditor e não estão salvas em lugar nenhum do repositório. **Pré-requisito do Commit 20:** rodar `node ferramentas/extrair-definicoes-008.js > extracao.json` e versionar a saída, antes de escrever qualquer SQL.
> 3. **Divergência de nomes não resolvida:** o snapshot de 2026-08-08 lista `is_gestor_or_admin()` e `is_atendente()`; a auditoria de agora nomeia `is_admin_master()` e `is_colaborador()`. Ou houve renomeação depois, ou um dos dois inventários está errado. Resolver **antes** de escrever a migration — errar o nome de função usada por policy quebra RLS.

**Arquitetura-alvo: o repositório passa a descrever o banco que existe.** Uma migration de reconciliação, **aditiva e idempotente**, que recria exatamente o que já está lá — de modo que aplicá-la num banco novo produza o mesmo schema de produção, e aplicá-la em produção seja no-op.

Regras do desenho:
- **Nada de `DROP`.** A migration documenta o que existe; decidir remover as `restrict_*` é outra decisão, outro commit, com autorização expressa.
- **`CREATE OR REPLACE` / `IF NOT EXISTS`** onde a sintaxe permite; onde não permite (policies), guarda condicional em `DO $$ ... $$` checando `pg_policies`.
- **Rollback correspondente**, no padrão que o repositório já usa (`db/032_..._rollback.sql`).
- `db/verificar.sql` ganha a checagem dos objetos reconciliados, para que `npm run verificar-banco` detecte drift futuro em vez de descobri-lo em auditoria.

**Ponto que o desenho registra explicitamente:** o papel `authenticated` **não tem GRANT de tabela nenhum** em todo o schema `public` — as policies `restrict_*` são código morto hoje. A migration de reconciliação não altera isso, e o comentário no arquivo precisa dizer que **dar GRANT a `authenticated` sem reavaliar essas policies é uma mudança de superfície de segurança**, não uma conveniência.

O ledger `supabase_migrations.schema_migrations` é inacessível ao papel `crmclinica_app` — a reconciliação não depende dele; parte do catálogo real, que é observável.

---

## 11. O que este design deliberadamente não toca

Para o escopo não crescer:

- Não introduz TypeScript, lint, bundler ou qualquer dependência de desenvolvimento. O projeto tem `devDependencies: {}` e uma única dependência de produção (`pg`); manter isso é uma virtude, não um débito.
- Não adiciona jsdom nem framework de teste de UI. A cobertura de UI continua estrutural, com o teste de botões corrigido para verificar a relação certa.
- Não troca o transporte de WhatsApp. Fica no OpenClaw/Evolution como está.
- Não reativa a Serena. Segue `ativa = false`.
- Não mexe em `storage`, retenção de auditoria, ou no fluxo de voz.
- Não reescreve o dispatcher de `http.js`. A separação "dentro/fora de transação" é deliberada e documentada em cada exceção.
- Não altera o desenho de RLS. As policies `crm008_*` são o RLS efetivo e funcionam; o problema é não estarem versionadas, não estarem erradas.

---

## 12. Mapa achado → seção deste design

| Achado | Seção | Estado |
|---|---|---|
| P0-1 `registrarMensagem` | §1 | **JÁ FEITO** em `fix/p0-ingresso-whatsapp-transacao` (`f1064c0`) — falta mesclar |
| P0-2 `definirEtiquetasDaConversa` | §1 | Só plano — **bloqueia a eficácia de P0-1** |
| P0-3 `definirDisponibilidades` | §1 | Só plano |
| P1-1 SSE perde mensagem | §6 (a)(b)(c) | Só plano |
| P1-2 SSE antes do COMMIT | §6 (d) | Só plano |
| P1-3 token check-then-act | §7 (a) | Só plano |
| P1-4 botões mortos | §8 | Só plano |
| P1-5 drift de schema | §10 | Só plano |
| P1-6 auditoria sem origem/correlation | §9 | Só plano |
| P2-1 duplo clique | §7 (b), §8 | Só plano |
| P2-2 rate limit em senha/2FA | §7 (d) | Só plano |
| P2-3 timing na recuperação | §7 (c) | Só plano |
| P2-4 idempotência Evolution | §3.2 | Só plano |
| P2-5 replay do webhook | §3.1 | Decisão consciente — documentar, não corrigir |
| P2-6/P2-7 falhas silenciosas | §8 | Só plano |
| Barreira final | §2 | **Já correto** — formalizar como invariante testada |
| Lease/fencing | §4 | **Já correto** (N-9 corrigido) — formalizar I-8 |
| Retry/dead-letter/incerto | §5 | **Já correto** — registrar |
