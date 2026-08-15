# Plano — Confiabilidade do crmclinica

**Data:** 2026-08-14
**Origem:** `docs/auditorias/2026-08-14-auditoria-integral-crm.md`
**Design:** `docs/superpowers/specs/2026-08-14-confiabilidade-crm-design.md`
**Branch de trabalho sugerida:** `fix/*` a partir de `main`, uma por bloco. Nunca commit direto em `main`.

## Como ler este plano

Cada item traz:
- **Estado** — `JÁ FEITO` (com a branch/commit), `SÓ PLANO`, ou `JÁ CORRETO` (nada a implementar, só proteger com teste).
- **O que muda** — arquivos exatos.
- **Teste que prova** — o que precisa existir e passar. Sem isso o item não está pronto.

## Regras operacionais que valem para todo item

Do `CLAUDE.md` deste projeto:

- Correção é **aditiva**. Nada de `reset`, `rebase`, `amend`, `force push`, `git clean`.
- Antes de alterar código: `git status --short`, `git branch --show-current`, `git log -8 --oneline --decorate`, confirmar branch ≠ `main`, registrar BASE_SHA.
- Antes de commit: `git diff --check`, `npm run verificar`, `npm test`, `git diff --stat`, revisar só os arquivos da tarefa. **Um assunto por commit.**
- `npm run verificar` é 111× `node --check` — **prova sintaxe, não comportamento**. Nenhum item abaixo pode ser dado como pronto com base nele. (Reconferido pela revisão independente: exit 0, 111 checks.)
- **Baseline correto de `npm test` nesta branch: 1091 testes, 1091 pass, 0 fail** — reexecutado pela revisão independente. Onde este plano dizia "1092", era o número da branch `fix/p0-ingresso-whatsapp-transacao`, que adiciona um arquivo cujo teste, sem `CRMCLINICA_TEST_DATABASE_URL`, é um **corpo vazio** que passa. Corrigido nos Commits 25 e 28.
- **Revisão independente:** ver `docs/auditorias/2026-08-14-auditoria-integral-crm.md` §12. Correções aplicadas abaixo estão marcadas **[CORREÇÃO DA REVISÃO]**.
- `push`, PR, merge, deploy e migration em produção **exigem autorização expressa do Edson**. Este plano produz commits locais e, no máximo, PR em modo draft.
- Nenhum teste novo pode apontar para o banco de produção. Testes contra Postgres usam `CRMCLINICA_TEST_DATABASE_URL` num banco separado — que **ainda não existe** neste ambiente e precisa ser provisionado antes dos itens marcados com ⚠.
- Conferir a raiz do repo por arquivos-lixo antes de commitar (armadilha dos hooks via `cmd /c`; hoje há um `res.write('` não rastreado na raiz).

---

## Propriedade de arquivos e paralelismo

> **[CORREÇÃO DO COMANDO DE 2026-08-14]** A versão anterior deste plano tratava blocos como paralelizáveis sem conferir os arquivos que cada um toca. Não são independentes:
>
> - mexer em `automacao_outbox` (Commit 8) toca **`src/dados/repositorio.js` e migrations**;
> - criar `test:pg`/`test:integracao` (Commit 24) toca **`package.json`**;
> - os Commits 1, 2 e 3 tocam **o mesmo `src/dados/repositorio.js`**;
> - os Commits 13, 14, 16, 18 e 19 tocam **o mesmo `public/app.js`**.
>
> **Regra:** em cada momento, **um único agente** é dono de cada um destes:
>
> | Recurso | Regra |
> |---|---|
> | `src/dados/repositorio.js` | um dono por vez |
> | `public/app.js` | um dono por vez |
> | `src/servidor/http.js` | um dono por vez |
> | `package.json` | um dono por vez |
> | numeração das migrations | **reservar o número antes** de abrir qualquer branch paralela |
>
> Migration nova reserva o próximo número livre (hoje: `033`) **antes** de a branch existir, e o número reservado é anotado aqui. Duas branches paralelas criando `033_*.sql` diferentes é um conflito que só aparece no merge, quando já é caro.
>
> **Contexto operacional:** o Edson usa **GPT/Codex em paralelo** no mesmo repositório e no mesmo banco. A branch `fix/botoes-data-tela` (commit `8e6ec19`) do Codex **não existe neste clone** — o que confirma que há mais de um checkout ativo. Antes de qualquer merge, alinhar quem é dono de quê.

---

# Bloco A — P0: o webhook do WhatsApp

Este bloco é o único que muda comportamento hoje quebrado em produção. **Os commits A1 e A2 são inseparáveis na prática:** A1 sozinho não faz o webhook funcionar para contato novo.

---

## Commit 1 — `registrarMensagem` participa da transação ambiente

**Estado: JÁ FEITO** — branch `fix/p0-ingresso-whatsapp-transacao`, commit `f1064c0` ("fix(webhook): P0 - registrarMensagem participa da transacao ambiente"). **Não mesclada** em `main` nem em `fix/auditoria-integral-crm-sem-deploy`.

**O que mudou:** `src/dados/repositorio.js` (61 linhas) + `testes/ingresso-whatsapp-transacao.test.js` (111 linhas, novo). Diff verificado: nenhum outro arquivo tocado.

**Desenho aplicado:** se `contexto.atual()` existe, reusa `ambiente.client` sem `BEGIN`/`COMMIT` próprios; se não existe, mantém conexão isolada com transação própria. No caso "mensagem duplicada" com transação ambiente, **não** faz `ROLLBACK` — correto, abortaria escritas legítimas vizinhas.

**Revisão desta auditoria:** correção **correta**, mas **incompleta** — ver Commit 2. Nota menor sem impacto: dentro do client ambiente usa `cliente.query(...)` direto em vez da fila `consultarNoCliente`; o driver `pg` já serializa queries na mesma conexão, então não há corrida.

**Teste que prova (já existe):** `testes/ingresso-whatsapp-transacao.test.js`, contra Postgres real. Reproduz o 500 antes do fix e o 202 depois. Contra `repositorio-memoria.js` não provaria nada — sem conexões, sem MVCC.

> **[CORREÇÃO DA REVISÃO — este item NÃO tem teste provando, hoje]** `CRMCLINICA_TEST_DATABASE_URL` não está definida neste ambiente. Sem ela, o arquivo cai no ramo `if (!URL_DE_TESTE)` e registra um teste de **corpo vazio** chamado "PULADO", que passa e conta +1 no total (é a diferença 1091 → 1092 entre esta branch e a do fix). Ou seja: o "vermelho/verde contra Postgres real" citado no commit `f1064c0` **não é reexecutável por ninguém neste ambiente** — é afirmação do autor, não artefato. O defeito P0-1 em si segue confirmado por leitura de código. **Consequência para o rollout: o Commit 24 (banco de teste) deixa de ser "pré-requisito dos itens ⚠" e passa a ser pré-requisito de mesclar o Bloco A**, senão o merge do P0 vai para produção com prova que ninguém consegue reproduzir.

**Ação:** mesclar **junto com** o Commit 2, nunca sozinho — e **só depois** do Commit 24, com o teste rodando de verdade.

> **[CORREÇÃO DO COMANDO DE 2026-08-14 — `f1064c0` NÃO está provado]** O commit não pode ser tratado como validado. O protocolo obrigatório antes de reaproveitá-lo é, nesta ordem:
>
> 1. **inspecionar o diff** (feito: toca só `src/dados/repositorio.js` e adiciona `testes/ingresso-whatsapp-transacao.test.js`; nenhum outro arquivo);
> 2. **preservar a parte correta** — o desenho (`contexto.atual()?.client` quando há transação ambiente, conexão própria quando não há) está certo e é reaproveitável;
> 3. **reproduzir o defeito contra a base SEM a correção**, em Postgres real — ou seja, ver o `mensagens_conversa_id_fkey` acontecer de verdade;
> 4. **só então** validar a correção no mesmo Postgres real;
> 5. **não chamar o commit de validado até a prova ser reexecutável** por outra pessoa, num comando só.
>
> Enquanto os passos 3-5 não acontecerem, o estado honesto de `f1064c0` é: **correção plausível, revisada por leitura, sem prova executável**.

---

## Commit 2 — `definirEtiquetasDaConversa` participa da transação ambiente

**Estado: SÓ PLANO.** Não existe em branch nenhuma. **Sem este commit, o Commit 1 não resolve o erro 500.**

**Por quê:** `src/dados/repositorio.js:906-929` abre `pool.connect()` próprio. A cadeia `http.js:487-489` (transação) → `atendimento.js:145` (`sincronizarTemperatura`, incondicional, antes do desvio de `despachoEmSegundoPlano`) → `atendimento.js:753-766` → `repositorio.js:907` executa `INSERT INTO conversa_etiquetas` numa conexão que não enxerga a conversa ainda sem COMMIT. FK `db/001_inbox.sql:107` sem `DEFERRABLE` ⇒ transação aborta. Para conversa nova o INSERT **sempre** roda (`leads.js:61-63` devolve `atividade_recente`; `conversas.js:41-47` nunca devolve array vazio).

**O que muda:** `src/dados/repositorio.js` — mesmo padrão do Commit 1.

**Teste que prova:** ⚠ estender `testes/ingresso-whatsapp-transacao.test.js` para percorrer o caminho **inteiro** de `receberMensagem` com contato **novo**, e exigir, na mesma transação: 202 + linha em `mensagens` + linha em `conversa_etiquetas` + trabalho em `automacao_outbox`. Contra Postgres real. O teste tem que **falhar** com o Commit 1 aplicado e o 2 não — é esse o ponto.

---

## Commit 3 — `definirDisponibilidades` participa da transação ambiente + teste de contrato

**Estado: SÓ PLANO.** Impacto hoje é **HIPÓTESE** (nenhum caminho de chamada encontrado que crie profissional e defina disponibilidade na mesma transação). Entra por consistência e para fechar a classe de defeito.

**O que muda:** `src/dados/repositorio.js:1887-1908`; novo teste de contrato em `testes/`.

**Teste que prova:** teste estático que lê `src/dados/repositorio.js`, conta as ocorrências de `pool.connect()` e falha se aparecer alguma fora da allowlist (`comUsuario` na linha ~352 e `publicarPromptDaSerena`, os dois legítimos). Hoje são 5: 352, 546, 907, 1888, 2211. Depois dos commits 1-3, os três defeituosos passam a consultar `contexto.atual()` primeiro. O teste é o que impede a reintrodução.

---

## Commit 4 — Barreira final da Serena: teste de invariante

**Estado: JÁ CORRETO no código.** Não há bug. Este commit só transforma disciplina em teste.

**O que já funciona** (`atendimento.js`): `podeEntregarAgora` chamada em `:646`, dentro de `if (origem === 'serena')` (`:645`), antes de `canal.enviar` (`:692`); relê do banco (`:615`); fail-closed (`:616-618, 627-629`); ao bloquear audita `envio_abortado_por_controle` (`:651-656`), marca `marcarEntregaFalhou` (`:663-667`), reescalona quando cabe (`:674-678`), e não envia (`:680-682`). Vale igual no worker (`automacao-outbox-servico.js:14-19`).

**O que muda:** só `testes/` — invariantes I-1 a I-5 do design §2.

**Teste que prova:** com a Serena desligada **entre** a decisão inicial e o envio (mock do orquestrador que altera o estado da conversa no meio da geração), `canal.enviar` não é chamado nenhuma vez, a mensagem fica marcada `entrega_falhou`, e há linha de auditoria `envio_abortado_por_controle`. Mesmo teste rodado pelo caminho síncrono e pelo worker.

---

## Commit 5 — Cancelamento de geração em voo

**Estado: SÓ PLANO — e a primeira pergunta é se precisa existir.**

Hoje **não há** cancelamento: uma geração de IA já disparada roda até o fim e é descartada pela barreira final (Commit 4). Isso é seguro para o paciente — nada indevido é enviado — e custa apenas tokens de IA de uma resposta que será jogada fora.

**Decisão proposta:** **não implementar cancelamento agora.** O ganho é custo de IA, não segurança, e o mecanismo (AbortController propagado até o orquestrador) adiciona superfície de falha num caminho que hoje está comprovadamente correto. Registrado aqui para que a ausência seja uma decisão, não um esquecimento.

**Se um dia for feito, o teste que provaria:** com "PARAR SERENA" acionado durante a geração, o orquestrador recebe `abort` e a requisição HTTP à IA é encerrada antes de completar — verificável por contador de chamadas no mock, não só por ausência de envio (ausência de envio já é garantida pela barreira, e provaria a coisa errada).

---

# Bloco B — Entrada, fila e envio

---

## Commit 6 — Idempotência de entrada: teste de corrida + comentário correto sobre replay

**Estado: JÁ CORRETO no código.** Duas camadas: `eventos_recebidos` com `ON CONFLICT (chave) DO NOTHING` e tratamento de corrida (`repositorio.js:1475-1485`), e `mensagens_id_externo_uk` (`db/001_inbox.sql:91`) com `ON CONFLICT DO NOTHING` (`repositorio.js:551-553`). Chave derivada de `versao|canal|tipo|id_externo` (`contratos/evento.js:72-77`), nunca do conteúdo.

**O que muda:** `testes/`; e um comentário em `src/integracoes/openclaw.js` deixando explícito que a assinatura HMAC **não** protege contra replay (não há nonce nem timestamp — P2-5) e que a defesa é a idempotência downstream. Hoje isso não está escrito em lugar nenhum, e a próxima pessoa pode achar que está coberto.

**Teste que prova:** ⚠ dois POSTs simultâneos no webhook com o **mesmo** `id_externo`, contra Postgres real: exatamente 1 linha em `mensagens`, exatamente 1 trabalho em `automacao_outbox`, ambas as respostas 2xx. Precisa ser Postgres — em memória não há corrida.

---

## Commit 7 — Outbox: teste do enfileiramento dentro da transação

**Estado: JÁ CORRETO no código.** `enfileirarTrabalhoDeOutbox` (`atendimento.js:180-185`) roda dentro da transação do webhook; `automacao_outbox.chave_idempotencia` é UNIQUE (`db/031_automacao_outbox.sql:56`, confirmado no banco real); índice de fila `automacao_outbox_fila_idx` presente.

**O que muda:** `testes/`.

**Teste que prova:** ⚠ se a transação do webhook der ROLLBACK (falha forçada depois do enfileiramento), **não** sobra trabalho na `automacao_outbox` — a fila não pode ter trabalho para uma mensagem que não existe. Postgres real.

---

## Commit 8 — Worker, lease e fencing: conclusão condicional + token monotônico

**Estado: SÓ PLANO — o problema NÃO está fechado.**

> **[CORREÇÃO DO COMANDO DE 2026-08-14 — este item dizia "JÁ CORRETO" e estava errado]** A versão anterior deste plano afirmava que o `AND reivindicado_por = $worker` da **renovação** já era o fencing. Não é: cobre a renovação, não a conclusão. Verificado lendo o código agora:
>
> ```js
> // src/dados/repositorio.js:2685 — concluirTrabalhoDeOutbox
> await consultar(`UPDATE automacao_outbox SET ${partes.join(', ')} WHERE id = $1`, valores);
> ```
>
> A conclusão filtra **apenas por `id`**. Não confere `status`, não confere `reivindicado_por`, não tem token de posse, e não usa `RETURNING` — ou seja, **não há como saber se afetou zero linhas**. Um worker cujo lease expirou e cujo trabalho já foi retomado por outro consegue, hoje, marcar `concluido`/`morto`/`incerto` por cima do trabalho do dono atual, e o método ainda devolve o objeto lido depois (`obterTrabalhoDeOutbox`), o que faz o chamador acreditar que deu certo.

**O que muda, exatamente:**

1. **Migration nova** (número reservado no Commit 20 — ver regra de numeração no bloco "Propriedade de arquivos"): coluna `posse_token bigint NOT NULL DEFAULT 0` em `automacao_outbox`. Monotônica: incrementada a cada reivindicação bem-sucedida (`posse_token = posse_token + 1`), nunca reiniciada. Aditiva, com rollback próprio.
2. **`reivindicarTrabalhosDeOutbox`** (`repositorio.js:2605`) — incrementar e **devolver** `posse_token` junto com o trabalho. O worker passa a carregar o token da posse que conquistou.
3. **`concluirTrabalhoDeOutbox`** (`repositorio.js:2665-2687`) — assinatura passa a exigir `{ worker, posseToken }`, e o `UPDATE` vira condicional com `RETURNING`:

   ```sql
   UPDATE automacao_outbox SET ...
    WHERE id = $1
      AND status = 'processando'
      AND reivindicado_por = $worker
      AND posse_token = $posseToken
   RETURNING *
   ```

   **Zero linhas afetadas ⇒ posse perdida.** Nesse caso o worker antigo **não conclui, não reagenda e não sobrescreve**: devolve um resultado explícito de posse perdida, e o chamador abandona o trabalho em silêncio (sem erro fatal — perder a posse é normal, não é falha).
4. **Renovação periódica durante operação longa** — hoje `automacao-outbox-servico.js:200-210` renova **antes** de iniciar cada trabalho. Uma chamada de IA que passe de `LEASE_MS` (5 min) perde a posse no meio sem ninguém perceber. Passa a haver renovação periódica **durante** a operação (timer que renova em ~1/3 do lease), e renovação que afeta 0 linhas ⇒ **aborta a operação em voo e não envia**.
5. **`reagendarTrabalhoDeOutbox`/`liberarTrabalhosDeOutboxPresos`** — auditar pelo mesmo critério: qualquer escrita de um worker sobre um trabalho precisa provar posse.

**Teste que prova:** ⚠ dois workers concorrentes contra Postgres real, no molde de `testes/lembretes-concorrencia.test.js`, cobrindo a sequência exata exigida:

1. worker A reivindica (recebe `posse_token = N`);
2. lease de A vence;
3. worker B recupera o trabalho e recebe `posse_token = N+1`;
4. A tenta concluir com o token N ⇒ **rejeitado** (0 linhas, resultado "posse perdida"), e o registro **não** muda;
5. B conclui com o token N+1 ⇒ **aceito**;
6. complementar: A com operação longa não consegue renovar após a retomada de B e **não** chama `canal.enviar`.

Além disso: cada trabalho é processado por exatamente um worker; `canal.enviar` é chamado no máximo uma vez por trabalho.

---

## Commit 9 — Retry, backoff e dead-letter: teste

**Estado: JÁ CORRETO no código.** Backoff exponencial com teto (`automacao-outbox.js:16-18, 68-72`); esgotado → `morto` + escalonamento humano (`automacao-outbox-servico.js:148-152`); presos → fila ou `morto` contando a tentativa (`repositorio.js:2697-2718`).

**O que muda:** `testes/`.

**Teste que prova:** falha repetida atinge `morto` no número esperado de tentativas, com intervalos crescentes e escalonamento humano registrado; trabalho `processando` há mais que `LEASE_MS` volta à fila com a tentativa contada. Pode rodar em memória para o backoff (regra pura) e precisa de Postgres ⚠ para `liberarTrabalhosDeOutboxPresos`.

---

## Commit 10 — Prevenção de duplicidade: entrega indeterminada nunca retentada

**Estado: JÁ CORRETO no código.** `TimeoutError`/`AbortError` na Evolution marcam `erro.indeterminado` (`evolution-envio.js:52-62`) — e só esses dois; recusa de conexão e falha de DNS continuam retentáveis, porque não chegaram a enviar. Propaga `entregaIncerta` (`atendimento.js:451`) → `'incerto'` (`automacao-outbox.js:115-117`) → status terminal (`concluirTrabalhoDeOutbox`, `repositorio.js:2682`; nem `reivindicar` nem `liberarPresos` selecionam `incerto`). Equipe escalonada antes de retornar (`atendimento.js:443`).

**O que muda:** `testes/`.

**Teste que prova:** timeout na chamada à Evolution ⇒ trabalho fica `incerto`, `canal.enviar` **não** é chamado de novo em nenhum ciclo posterior do worker, e há escalonamento humano. Contraste no mesmo teste: `ECONNREFUSED` ⇒ trabalho volta à fila e **é** retentado.

---

## Commit 11 — Canal Evolution: chave de idempotência na assinatura de envio

**Estado: SÓ PLANO — escopo menor do que o descrito originalmente.** P2-4. Hoje o OpenClaw usa `idempotencyKey` (`canal-conversas.js:41-50`) e a Evolution **recebe a chave e a descarta**: `canal-conversas.js:80` já faz `evolucao.enviar({ telefone: destino, texto, chave })`, e `evolution-envio.js:28` desestrutura só `{ telefone, texto }`; risco aceito e documentado (`evolution-envio.js:8-14`).

> **[CORREÇÃO DA REVISÃO]** A redação original ("a Evolution não recebe nem o parâmetro") levava a planejar trabalho já feito. `canal-conversas.js` **já passa a chave uniformemente** — não precisa mudar por causa disto.

**O que muda:** `src/integracoes/evolution-envio.js` (aceitar e **usar** a `chave` que já chega), registro local de envios confirmados por chave — coluna em `automacao_outbox` ou tabela dedicada, decidido junto com a migration do Commit 18.

**Nota honesta:** isso é idempotência de aplicação por cima de um transporte que não a oferece; a janela entre "API aceitou" e "registramos" continua existindo.

> **[CORREÇÃO DO COMANDO DE 2026-08-14]** A frase anterior — "a defesa dessa janela permanece sendo o `LEASE_MS` + a classificação `incerto`" — **está retirada**. Lease de cinco minutos **não** resolve a janela pós-aceite: ele impede que dois workers disputem o mesmo trabalho, e não tem relação nenhuma com o fato de a Evolution já ter aceitado um envio que a gente não registrou. Tratar lease como defesa dessa janela é justamente o raciocínio que produz mensagem duplicada para o paciente.
>
> **O que de fato vale como regra:** falha de rede **depois** de um possível aceite é **resultado indeterminado**, e resultado indeterminado:
> - **nunca** é retentado cegamente;
> - é registrado como estado incerto explícito (já existe: `incerto`, Commit 10);
> - deve ser **reconciliado pelo identificador devolvido pela Evolution** sempre que ele existir — consultar o estado real do envio antes de qualquer decisão, em vez de adivinhar;
> - quando a reconciliação não for possível (sem identificador, endpoint indisponível), o trabalho **fica** incerto e vai para revisão humana. Não há reenvio automático.
>
> A idempotência local (chave própria + registro de envios confirmados) continua valendo, mas como **redução** da janela, não como fechamento dela.

**Escopo adicional trazido por esta correção:** desenhar a reconciliação por identificador da Evolution — onde o `id` da mensagem devolvido pela API é persistido, e qual endpoint permite consultá-lo depois. **Ainda não verificado** se a Evolution devolve identificador utilizável nesse caminho de erro; isso é pré-requisito de implementação e está registrado como hipótese, não como fato.

**Teste que prova:** duas chamadas de envio com a **mesma** chave ⇒ a API da Evolution é chamada **uma** vez (mock contando chamadas); com chaves diferentes ⇒ duas. Mais: falha de rede após aceite ⇒ trabalho `incerto`, **zero** reenvio automático em qualquer ciclo posterior, escalonamento humano registrado, e — quando houver identificador — uma tentativa de reconciliação registrada antes de qualquer decisão.

---

# Bloco C — Chat ao vivo

---

## Commit 12 — SSE: emissão só depois do COMMIT

**Estado: SÓ PLANO.** P1-2. Ordem atual confirmada: `comUsuario` faz `BEGIN` (`repositorio.js:354`) → `acao` (365-368) → `COMMIT` (370); `atendimento.js:112` publica no meio. Mesmo padrão em `atendimento.js:399, 515, 555, 728`.

**O que muda:** `src/dados/repositorio.js` (fila de efeitos pós-commit no `comUsuario`, drenada após o COMMIT e descartada no ROLLBACK), `src/dominio/atendimento.js` (enfileirar em vez de publicar direto), `src/servidor/eventos-conversas.js` se a interface do emissor mudar.

**Teste que prova:** transação que falha **depois** do ponto de emissão não entrega evento SSE nenhum ao assinante; transação que conclui entrega exatamente um. Roda com servidor real e assinante SSE de verdade (o molde do script de reprodução usado na auditoria serve).

---

## Commit 13 — SSE: cursor e recuperação na reconexão

**Estado: SÓ PLANO.** P1-1, parte (a)+(b). Hoje: nenhum campo `id:` (`eventos-conversas.js:25-34`), rota não lê `Last-Event-ID` (`http.js:1533-1599`), cliente sem cursor (`app.js:1549`), reconexão só reabre 5s depois (`app.js:1569-1574`).

**O que muda:** `src/servidor/eventos-conversas.js` (escrever `id:`), `src/servidor/http.js` (ler `Last-Event-ID`/querystring e reenviar do banco o que veio depois, **antes** de inscrever a conexão), `public/app.js` (guardar e enviar o cursor). Primeira etapa usa `mensagens.id` como sequência durável — sem tabela nova.

**Teste que prova:** exatamente o cenário já reproduzido na auditoria, invertendo o resultado: conectar → 2 mensagens → desconectar → 3ª mensagem sem ninguém ouvindo → reconectar com cursor ⇒ **a 3ª mensagem chega**. Hoje esse mesmo script devolve `0` eventos.

> **[CORREÇÃO DO COMANDO DE 2026-08-14 — requisitos obrigatórios do SSE]**
>
> 1. **Cursor durável, global e monotônico.** `mensagens.id` serve como primeira etapa, mas precisa ser tratado como sequência global monotônica de verdade — não pode ser um contador por conexão nem por conversa.
> 2. **O cliente persiste o último cursor** (não basta guardar em variável que morre com a aba) e **repassa o cursor explicitamente ao criar um novo `EventSource`**. Confiar só no `Last-Event-ID` automático do navegador não cobre o caso de recriação manual da conexão, que é o que o `app.js` faz hoje.
> 3. **Replay antes da inscrição.** O servidor reenvia do banco tudo que veio depois do cursor **antes** de inscrever a conexão no emitter em memória. Inverter essa ordem cria buraco (evento que chega entre a leitura e a inscrição) ou duplicata.
> 4. **Autorização e isolamento por usuário/clínica valem no replay também.** O replay lê do banco: precisa passar pelas mesmas regras de RLS/papel da listagem normal, não pode virar porta lateral para ver conversa de outro.
> 5. **Proibido token de autenticação na querystring.** Nem `?token=`, nem `?access_token=`. URL vaza em log de servidor, em histórico e em `Referer`. A autenticação do SSE é same-origin: preferencialmente **cookie `HttpOnly`**, ou um endpoint equivalente que não exponha credencial na URL. Isso pode exigir mudança no `app.js` — que **está fora do escopo desta sessão** e entra no Lote 2.
> 6. **O cursor de mensagens cobre mensagens, e só.** Mudanças de **assumir**, **resolver**, **controle da Serena** e **estado de entrega** não são mensagens e não aparecem nesse cursor. Se essas mudanças devem aparecer ao vivo — e devem —, cada uma precisa de **evento durável próprio**, com sua própria sequência. Um cursor único de `mensagens.id` dando conta de tudo é ilusão de cobertura.
>
> **Teste que prova (ampliado):** desconexão → gravação durante a ausência → reconexão com cursor → **replay completo** (nenhum evento perdido) e **sem duplicidade** (nenhum evento entregue duas vezes). Mais: uma sessão de outro usuário não recebe no replay nada que não poderia ver na listagem normal.

---

## Commit 14 — Thread aberta com rede de segurança independente do SSE

**Estado: SÓ PLANO.** P1-1, parte (c). Hoje só a lista lateral tem polling (`app.js:1592`, 30s); a thread aberta só é rebuscada quando chega evento SSE da `conversaAberta` (`app.js:1564-1566`).

**O que muda:** `public/app.js` — polling da thread aberta com cursor (pergunta barata "tem coisa depois de X?"). É isto que faz o sistema parar de depender de o emitter em memória alcançar o assinante certo, que é o cerne do problema com serverless multi-instância.

**Também neste commit:** corrigir o comentário de `src/servidor/eventos-conversas.js:6-10`, que afirma que a rota não roda em serverless replicado — contrariado por `api/index.js:1-6`, `vercel.json` e `src/config.js:190-200`. Comentário errado é armadilha para a próxima pessoa.

**Teste que prova:** com o emitter SSE **desligado** (simulando a instância que gravou ser outra), a thread aberta passa a exibir a mensagem nova dentro do intervalo de polling. Este é o teste que cobre a hipótese H3 (perda entre instâncias Vercel) sem precisar de duas lambdas reais — ele torna o cenário irrelevante em vez de tentar reproduzi-lo.

---

# Bloco D — Recuperação de senha e autenticação

---

## Commit 15 — Consumo atômico do token de recuperação

**Estado: SÓ PLANO.** P1-3. Hoje `contas.js:306-338`: SELECT (**310**) → checagem em memória (**312**) → troca de senha incondicional (**323**) → só então `UPDATE ... WHERE usado_em IS NULL` (**327** → `repositorio.js:1845-1847`). **[CORREÇÃO DA REVISÃO — as âncoras da auditoria estavam 1-2 linhas deslocadas; o conteúdo de cada passo confere.]**

**O que muda:** `src/seguranca/contas.js` (inverter a ordem: consumir primeiro com `RETURNING`, e só depois validar situação, trocar senha, revogar sessões, auditar — tudo na mesma transação), `src/dados/repositorio.js` (novo método de consumo atômico), `src/dados/repositorio-memoria.js` (paridade).

**Teste que prova:** ⚠ duas requisições **concorrentes** a `POST /api/auth/redefinir` com o mesmo token, contra Postgres real: exatamente uma responde sucesso, a outra responde 400, e a senha final é a da que teve sucesso. Este teste **não pode** rodar em `repositorio-memoria.js` — é single-thread e daria verde sem provar nada, que é exatamente por que a hipótese H1 continua não confirmada hoje.
Teste complementar: falha simulada **depois** do consumo (ex. erro ao revogar sessões) devolve o token ao estado não-usado — o link do usuário não pode ser queimado sem a senha ter trocado.

> **[CORREÇÃO DO COMANDO DE 2026-08-14 — restrições que valem para todo o Bloco D]**
>
> 1. **Nenhuma senha real é lida, trocada ou desconfigurada** em qualquer teste ou implementação deste bloco. Só usuários, e-mails, senhas e tokens sintéticos, em banco de teste descartável. Nada de mexer em conta de produção — nem a do master.
> 2. **Uma transação só.** Consumo do token + atualização da senha + revogação das sessões + registro de auditoria participam da **mesma** transação. Não é aceitável consumir o token numa transação e trocar a senha em outra: falha no meio queima o link do usuário sem trocar a senha.
> 3. **Exatamente uma requisição vence** entre duas concorrentes. É o critério de aceite, não um detalhe do teste.
> 4. **Proibido remover o `await` do envio de e-mail e deixá-lo em segundo plano.** Numa função serverless da Vercel, trabalho que continua depois da resposta HTTP não tem garantia de execução — é o mesmo defeito de raiz do `setImmediate` que o PR #32 removeu do webhook. O envio precisa ser **aguardado com timeout controlado**, ou enfileirado numa **outbox durável de e-mail** (mesma disciplina do `automacao_outbox`). Não existe terceira opção.
> 5. **O botão "Esqueci minha senha" é requisito obrigatório da interface** — não some, não fica condicionado a SMTP configurado. Implementado e testado localmente. (Ver o achado registrado na auditoria: hoje `/api/auth/opcoes` devolve `recuperacao_por_email:false` sem SMTP e o JS esconde o botão; a rota e o fluxo existem e funcionam.)
> 6. **Sem SMTP, a entrega de e-mail fica marcada como NÃO VALIDADA.** Nada de simular sucesso de entrega. O teste prova o fluxo (token gerado, hash persistido, link montado, consumo atômico); a entrega em si permanece explicitamente não provada até haver um provedor configurado — e isso tem que aparecer no relatório, não ser silenciado.
> 7. **Nenhum e-mail real é enviado** nesta e nas próximas fases locais. Nenhum secret de SMTP/Resend é alterado.

---

## Commit 16 — Guarda de duplo clique nos formulários

**Estado: SÓ PLANO.** P2-1. Remove o gatilho realista do Commit 15.

**O que muda:** `public/app.js` — helper único `comBotaoOcupado(botao, fn)` (`disabled = true` → texto de progresso → `finally` restaura), aplicado a: `#form-login` (1599), `#form-recuperar` (1675), `#form-redefinir` (1695), `#form-cadastro` (1649), `#form-trocar-senha` (2012), `#ativar-2fa` (2040), `#form-confirmar-2fa` (2051), `#desativar-2fa` (2067), `#form-resposta` (1235), `#botao-nota` (1245), `#form-ficha` (1320), `#horario-salvar` (3913), `#form-prompt` (3326), `#form-regra` (3351), `#form-contato` (3377), `#form-perfil` (1992), `#form-novo-usuario` (1922), `#ia-gerar-relatorio` (1079), `#assistente-perguntar` (1107), ações de compromisso (2630-2651), `#serena-voz-iniciar` (3118, P2-7).

O padrão **já existe no projeto** (`app.js:1491-1507`, `1271-1278`, `2543`, `3609-3632`, `4125-4165`) — não é invenção, é aplicar onde foi esquecido.

**Teste que prova:** estrutural (sem jsdom no projeto): para cada seletor da lista, o bloco do handler contém a chamada ao helper. Fraco por natureza — a prova real é o teste de concorrência do Commit 15, que cobre a consequência que importa.

---

## Commit 17 — Rate limit e tempo constante nas rotas de senha

**Estado: SÓ PLANO.** P2-2 e P2-3.

**O que muda:** `src/seguranca/contas.js` — `trocarSenha` (153-192) e `desativarSegundoFator` (391-411) passam a chamar `limitador.exigirDentroDoLimite` com chave por conta (o usuário é conhecido nessas rotas, diferente de `redefinicao`, onde a rota só tem o token — `rotas-autenticacao.js:237-242`); e `pedirRecuperacao` (257-303) para de `await`ar o handshake SMTP completo antes de responder (`contas.js:278` → `email.js:54-127`). `src/seguranca/limite.js` — entradas de configuração das ações novas.

**Sobre o timing:** hoje o canal está **inerte** porque `configuracao.email.host` está vazio em produção (`email.js:139-148` cai no modo log). A correção é **preventiva** e precisa entrar **antes** de o Edson configurar SMTP, não depois.

**Teste que prova:** N+1 tentativas de `POST /api/auth/senha` com senha atual errada ⇒ a N+1ª é recusada pelo limitador, não pelo scrypt. Para o timing: com remetente SMTP mockado com atraso artificial, o tempo de resposta de `/api/auth/recuperar` para conta existente e inexistente fica dentro da mesma faixa.

---

## Commit 18 — Botões `data-tela` e teste que não dá falso positivo

**Estado: RESERVADO PARA REVISÃO INDEPENDENTE — não implementar aqui.**

> **[CORREÇÃO DO COMANDO DE 2026-08-14]** Esta correção **já foi feita pelo Codex** e está aguardando revisão:
> - branch local do Codex: `fix/botoes-data-tela`
> - commit local: `8e6ec19`
> - sem push, sem deploy
> - revisão ainda **pendente**
>
> **Não duplicar esta alteração.** Duas correções independentes do mesmo defeito, em branches diferentes, viram conflito na hora de juntar — e é exatamente o risco de ter duas ferramentas trabalhando no mesmo repositório.
>
> **Verificação feita nesta sessão:** `git branch --all --list "*botoes*"` não retorna nada, e `git show 8e6ec19` responde `unknown revision`. Ou seja, **essa branch e esse commit não existem neste clone** — o Codex trabalha em outro checkout. Consequência prática: antes de qualquer merge, esse trabalho precisa ser trazido para cá (ou revisado lá), senão ele não entra. **Não é um problema a resolver nesta sessão**, mas não pode ser esquecido no rollout.
>
> Os **demais** botões e as falhas silenciosas de UI (Commit 19) continuam no plano, para fase posterior.

**Contexto original do achado (mantido para a revisão):** P1-4.

**O que muda:** `public/app.js` — handler delegado em `document` para qualquer `data-tela`, substituindo/complementando `document.querySelectorAll('nav [data-tela]')` (`app.js:47`). `testes/botoes-orfaos.test.js` — parar de verificar só presença de string (`:74`) e passar a verificar a **relação** entre o atributo no HTML e o alcance do seletor no JS; corrigir o comentário da linha 71, que afirma falsamente que o botão tem handler.

**Contexto:** `index.html:233` e `:248` estão em `<main>` (188+), fora do `<nav>` (155-176). Clique não faz nada, sem erro e sem log.

**Teste que prova:** para cada `data-tela` presente em `public/index.html`, existe handler que o alcança considerando o seletor usado em `app.js`. O teste tem que **falhar** no código de hoje — se passar antes da correção, está errado como o atual.

---

## Commit 19 — Falhas silenciosas de UI

**Estado: SÓ PLANO.** P2-6.

**O que muda:** `public/app.js` — checkboxes de `#ficha-etiquetas` (742) revertem visualmente em erro (hoje a tela fica divergindo do banco, que é o pior dos casos); `agir()` do inbox repassa `erro.detalhe` em vez de sempre `'A ação não pôde ser concluída.'`; autocomplete de paciente (2500-2502) avisa em vez de esconder a lista; encerrar voz (3110) e logout (1743) deixam de engolir o erro em silêncio (logout pode continuar não bloqueando a UI, mas o erro precisa aparecer em algum lugar).

**Teste que prova:** estrutural — os `catch` citados deixam de ser `() => {}` vazios. Baixa força probatória; é melhoria de diagnosticabilidade, não correção de bug funcional.

---

# Bloco E — Banco, migrations e observabilidade

---

## Commit 20 — Migration de reconciliação do drift + rollback

**Estado: SÓ PLANO.** P1-5. **Não aplicar em produção sem autorização expressa do Edson.** O commit produz o arquivo; aplicar é decisão separada.

> **[CORREÇÃO DA REVISÃO — pré-requisitos que faltavam neste commit]**
> 1. **Não parta de inventário de memória.** Já existem `docs/PLANO-RECONSTRUCAO-008-009.md` (snapshot real de 2026-08-08, com `CREATE OR REPLACE FUNCTION` de cinco funções via `pg_get_functiondef`) e a ferramenta versionada somente-leitura `ferramentas/extrair-definicoes-008.js`. O drift 008/009 **não é um achado novo** — está documentado desde 2026-08-06/08.
> 2. **Antes de escrever SQL, gerar artefato:** `node ferramentas/extrair-definicoes-008.js > extracao.json`, versionado. Os números 53/10/3/1 da auditoria **não puderam ser reexecutados por um segundo auditor** e não existem como arquivo em lugar nenhum.
> 3. **Resolver a divergência de nomes:** o snapshot de 2026-08-08 traz `is_gestor_or_admin()` e `is_atendente()`; a auditoria de agora nomeia `is_admin_master()` e `is_colaborador()`. Escrever policy apontando para função com nome errado quebra RLS. Resolver **antes** do SQL.

**O que muda:** nova migration `db/0XX_reconciliacao_drift.sql` + `db/0XX_reconciliacao_drift_rollback.sql`, aditiva e idempotente, descrevendo o que **já existe** em produção:
- 53 policies `crm008_*` (as quatro por operação nas tabelas centrais);
- 3 funções `SECURITY DEFINER` com `search_path=''`: `current_usuario_id()`, `is_admin_master()`, `is_colaborador()` — hoje `db/018` só faz REVOKE/GRANT sobre elas, sem o `CREATE`;
- 10 policies `restrict_*` para o papel `authenticated`, **com comentário no arquivo** registrando que hoje são código morto (o papel não tem GRANT de tabela nenhum em todo o `public`) e que **dar GRANT a `authenticated` é mudança de superfície de segurança**;
- view `v_metricas_uso_usuarios_dia`.

Nada de `DROP`. Remover as `restrict_*` é outra decisão, outro commit, outra autorização.
`db/verificar.sql` ganha a checagem desses objetos, para `npm run verificar-banco` detectar drift futuro.

**Teste que prova:** ⚠ aplicar a migration num banco Postgres **vazio e separado** e comparar o catálogo resultante com o inventário levantado do banco real (só `pg_policies`, `pg_proc`, `information_schema`). Aplicar duas vezes seguidas tem que ser no-op. `npm run verificar-banco` passa antes e depois.

---

## Commit 21 — `audit_log` com origem e correlation_id

**Estado: SÓ PLANO.** P1-6. Migration aditiva; **aplicar em produção exige autorização**.

**O que muda:** migration nova adicionando `origem text` e `correlation_id text` (ambas anuláveis) a `audit_log` (`db/001_inbox.sql:145-153`) + rollback; `src/dados/contexto.js` e `src/dados/repositorio.js` (`comUsuario` carrega os dois no contexto assíncrono, junto de `client`/`usuarioId`/`claims` em `repositorio.js:365-368`; `registrarAuditoria` em `repositorio.js:1494-1505` lê do contexto exatamente como já faz com `usuarioId`); `src/servidor/http.js` (propagar o `request_id` que já é gerado em `:1373` e hoje morre no log de acesso em `:1378-1382`); workers de `bin/` geram correlation próprio por trabalho.

Ler do contexto, e não de parâmetro, é o que evita que a coluna fique vazia por esquecimento de cada chamador.

`redigirAuditoria` (`src/seguranca/redator-auditoria.js`) segue governando `detalhe`, sem mudança. As colunas novas nunca recebem dado clínico.

**Teste que prova:** uma requisição HTTP que gera auditoria produz linha com `origem='painel'` e `correlation_id` igual ao `request_id` da resposta; um trabalho de outbox produz `origem='worker_outbox'` com correlation próprio. Verificável em memória e ⚠ contra Postgres para a migration.

---

## Commit 22 — RLS e superfície de exposição: teste de regressão

**Estado: JÁ CORRETO no estado atual.** Varredura completa de `information_schema.role_table_grants`: `anon` e `authenticated` **não têm GRANT de tabela nenhum** em todo o schema `public` — o REVOKE de `db/007_hardening.sql:287-294` segue em vigor. Todas as 40 tabelas com `rowsecurity = true`. A conexão da aplicação usa `crmclinica_app` com `rolbypassrls = false`.

**O que muda:** `db/verificar.sql` e/ou `bin/verificar-banco.js` — checagem que falha se algum GRANT a `anon`/`authenticated` aparecer.

**Teste que prova:** `npm run verificar-banco` falha se o GRANT existir. Esta é a única defesa automática contra o risco R6 (alguém dar GRANT sem reavaliar as policies `restrict_*` do Commit 20).

---

## Commit 23 — Estado desejado × estado efetivo

**Estado: PARCIALMENTE JÁ FEITO.**

Já existe e funciona: `GET /api/diagnostico` (`src/dominio/diagnostico.js:54`, sondas em `diagnostico-sondas.js` — banco, RLS, migrations, fila, canal, Evolution, Serena, Google, worker, outbox), agregando o pior nível por área; heartbeat por banco (`bin/worker-heartbeat.js`, tabela `system_heartbeats`) com `/api/resumo` lendo só heartbeat e nunca pingando serviço interno (`http.js:1473-1516`, comentário 1479-1489 documenta o incidente que motivou isso).

**O que falta (SÓ PLANO):** o diagnóstico não compara **desejado × efetivo** para o drift do Commit 20 — ele checa migrations, mas não os objetos que existem sem arquivo. Adicionar sonda que reporte objetos de RLS/view sem origem versionada.

**Teste que prova:** com um objeto plantado no banco de teste que não existe em `db/*.sql`, a sonda reporta divergência; sem ele, reporta ok.

---

# Bloco F — Testes, integração e rollout

---

## Commit 24 — Provisionar banco de teste separado

**Estado: SÓ PLANO — e é pré-requisito de todos os itens marcados ⚠.**

Hoje **não existe** banco de teste configurado neste ambiente; `CRMCLINICA_TEST_DATABASE_URL` só é usada por `testes/contrato-repositorio.test.js` e `testes/lembretes-concorrencia.test.js`. O único Postgres alcançável é o de produção, que está fora de escopo para escrita. É por isso que P0-2, P1-3 e várias corridas permanecem não reproduzidas.

**O que muda:** documentação de como subir o banco de teste (Docker local ou projeto Supabase separado), `package.json` (script `test:pg` que só roda os testes que exigem Postgres), e um `skip` explícito e **ruidoso** quando a variável não está definida — hoje o risco é o teste sumir em silêncio e dar falsa sensação de cobertura.

**Teste que prova:** `npm run test:pg` roda a suíte de Postgres e falha alto (não pula) quando `CRMCLINICA_TEST_DATABASE_URL` está ausente e o operador pediu explicitamente a suíte de Postgres.

> **[CORREÇÃO DO COMANDO DE 2026-08-14 — regras duras do banco de teste]**
>
> 1. **Criar projeto ou branch Supabase remoto NÃO está autorizado.** Exige apresentar custo e receber autorização nova e expressa. Não fazer por conta própria.
> 2. **Lista negra absoluta.** Nunca usar como banco de teste:
>    - `umvpwqqjzpxwuxdnnxzy` (produção);
>    - `rkdvvynxxerqpjzetmse` (projeto legado — também proibido sem confirmação expressa);
>    - qualquer URL que não seja **comprovadamente descartável**.
>    O harness precisa **recusar** essas URLs por verificação programática, não por disciplina de quem executa.
> 3. **Sem `CRMCLINICA_TEST_DATABASE_URL`, o caminho é fechado:** implementar apenas o harness, fazer o comando falhar de forma clara, **não executar a correção P0**, informar exatamente o que falta, e **PARAR**. Foi exatamente o que aconteceu na sessão de 2026-08-14 — ver Commit 24-A abaixo.
> 4. **Nada de teste vazio contando como sucesso.** Um arquivo que, sem a variável, registra um caso de corpo vazio chamado "PULADO" e passa é pior que não existir: infla o total e simula cobertura. Ver Commit 25 e a correção do Commit 1.

---

## Commit 24-A — Harness `test:pg` (ENTREGUE em 2026-08-14)

**Estado: JÁ FEITO** — branch `fix/auditoria-integral-crm-sem-deploy`. Implementado sob a autorização "APROVADO PARA IMPLEMENTAÇÃO LOCAL, SEM DEPLOY", que determinou explicitamente: sem Postgres isolado, entregar esta fase e parar.

**O que faz:** `npm run test:pg` roda só os testes que exigem Postgres real e **falha com exit ≠ 0** quando `CRMCLINICA_TEST_DATABASE_URL` está ausente — nunca pula em silêncio. Recusa por verificação programática qualquer URL que aponte para os projetos proibidos. Nenhuma credencial em log.

**Arquivos:** `ferramentas/exigir-banco-de-teste.js` (porteiro), `testes/exigir-banco-de-teste.test.js` (8 testes do próprio porteiro), `package.json` (script `test:pg` + os dois arquivos novos em `verificar`).

**Provas executadas em 2026-08-14:**

| Cenário | Resultado |
|---|---|
| sem a variável | exit 1, com instruções de como subir um Postgres descartável |
| variável apontando para `umvpwqqjzpxwuxdnnxzy` (produção) | exit 1, recusado, motivo explícito |
| variável apontando para `rkdvvynxxerqpjzetmse` (legado) | exit 1, recusado, motivo explícito |
| banco descartável local | aceito |
| não-URL / outro esquema | recusado antes de qualquer conexão |
| descrição da URL em log | não revela usuário, senha nem host completo |

**Achado colateral, corrigido na mesma sessão:** os dois arquivos novos derrubaram `testes/auditoria.test.js` → "nenhuma chave real está versionada". O detector (`auditoria.test.js:154`, padrão `postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@`) pegou as **URLs de exemplo fictícias**. A correção foi nos arquivos novos — montar as URLs em pedaços, em tempo de execução — e **não** no detector. Enfraquecer um detector para acomodar um caso "de mentira" é como ele para de detectar o caso de verdade. Vale registrar que o guarda do projeto funcionou exatamente como devia.

**O que ainda falta (bloqueia o Bloco A inteiro):** um Postgres descartável de verdade. Enquanto ele não existir, os Commits 1, 2 e 3 **não podem ser implementados nem mesclados** — a prova não seria reexecutável por ninguém.

---

## Commit 25 — Flaky de `testes/inbox-http.test.js`

**Estado: SÓ PLANO, causa não investigada.** Passa 31/31 isolado; numa das duas rodadas de hoje falhou junto com a suíte inteira (**1091** testes nesta branch). Suspeita não verificada: colisão de porta ou de estado global entre arquivos sob paralelismo do `node --test`. **[CORREÇÃO DA REVISÃO]** O revisor independente rodou `npm test` completo e obteve **1091 pass / 0 fail / exit 0** — o flaky **não reapareceu**. Segue como relato de sessão não reproduzido, com 1 de 3 rodadas conhecidas vermelha.

**O que muda:** provavelmente `testes/auxiliar.js` (isolamento de porta/estado por arquivo) e/ou `testes/inbox-http.test.js`.

**Teste que prova:** 10 execuções consecutivas de `npm test` completo, todas verdes no total vigente da branch (**1091/1091** hoje; 1092 só na branch do fix do P0-1, por causa do teste-placeholder "PULADO"). Enquanto isso não for verdade, qualquer vermelho da suíte é ambíguo — e suíte ambígua é pior que suíte lenta.

---

## Commit 26 — Scripts de qualidade que hoje não existem

**Estado: SÓ PLANO.**

Confirmado ausente: lint, typecheck, build, script isolado de `integracao`/`e2e`, audit de dependência. `devDependencies: {}`; única dependência de produção é `pg`. `npm run verificar` é 111× `node --check`.

**O que muda:** `package.json` — separar `test:unit` / `test:integracao` / `test:e2e` a partir do que já existe misturado em `node --test "testes/**/*.test.js"`, e um `audit` (`npm audit`, sem dependência nova).

**Deliberadamente fora:** ESLint, Prettier, TypeScript. Um projeto com uma dependência de produção e zero de desenvolvimento tem uma virtude que não deve ser trocada por conveniência de estilo sem o Edson decidir.

**Teste que prova:** os scripts novos rodam e classificam corretamente; `npm test` continua rodando tudo.

---

## Commit 27 — E2E do caminho crítico

**Estado: PARCIALMENTE JÁ FEITO.** Existe `testes/e2e-fluxo-critico.test.js`.

**O que falta (SÓ PLANO):** ⚠ um E2E contra Postgres real cobrindo, de ponta a ponta, o caminho que esta auditoria mostrou quebrado: mensagem de WhatsApp de **contato novo** → 202 → contato + conversa + mensagem + etiqueta + trabalho de outbox na **mesma** transação → worker reivindica → barreira final → envio (mock de canal) → mensagem de saída gravada → evento SSE entregue ao assinante **depois do commit**. Com a variação: "PARAR SERENA" acionado no meio ⇒ nada sai, mensagem marcada `entrega_falhou`, auditoria registrada.

Este é o teste que amarra os Blocos A, B e C. Se ele passar, os três P0/P1 principais estão fechados de verdade.

**Teste que prova:** ele mesmo. Precisa falhar hoje.

---

## Commit 28 — Rollout e reversão

**Estado: SÓ PLANO. Nada aqui é executado por agente sem autorização expressa do Edson.**

Ordem proposta de entrega, do que dói mais para o que dói menos:

1. **Bloco A (commits 1+2+3) juntos.** Nunca o 1 sozinho — resolveria a linha errada. Reversão: `git revert` dos três; nenhuma mudança de schema envolvida, reversão é limpa.
2. **Bloco C (12+13+14).** Reversão: `git revert`; o cliente volta a depender só do SSE, que é o estado de hoje. Sem mudança de schema na primeira etapa (usa `mensagens.id`).
3. **Bloco D (15+16+17+18+19).** O 15 é o único com risco funcional real (muda a ordem de um fluxo de senha); entregar sozinho, com o 16 junto. Reversão: `git revert`; sem schema.
4. **Bloco E (20+21+22+23).** Migrations — **cada aplicação em produção exige autorização expressa e nominal**, com rollback correspondente pronto **antes** de aplicar. A 20 é declarativa e idempotente (aplicá-la deve ser no-op em produção); a 21 adiciona colunas anuláveis, reversível por `DROP COLUMN` no rollback.
5. **Bloco B (6..11)** e **Bloco F (24..27)** podem intercalar — são majoritariamente teste, exceto o 11 (Evolution), que depende da decisão de schema do 20/21.

**Critério de pronto por bloco:** `npm run verificar` verde **e** `npm test` verde dez vezes seguidas no total vigente da branch (**1091/1091** na base de hoje, Commit 25) **e** o teste específico do bloco falhando antes / passando depois. `npm run verificar` sozinho **não** conta como prova de nada. **[CORREÇÃO DA REVISÃO]** Acrescentar um critério que faltava: **nenhum teste que "prova" um item pode ser um teste que degrada em corpo vazio quando falta variável de ambiente.** Hoje `testes/ingresso-whatsapp-transacao.test.js` faz exatamente isso — e é o único "prova" do Bloco A. Por isso o Commit 24 sobe para pré-requisito do Bloco A, não só dos itens ⚠.

**Reversão de emergência:** todos os commits de código são revertíveis por `git revert` — a história é aditiva, nada de reset/rebase/amend/force push. Migrations têm rollback correspondente no padrão que o repo já usa (`db/032_..._rollback.sql`). Nenhum commit deste plano remove dado.

---

# Resumo: o que já está feito × o que é só plano

| # | Item | Estado |
|---|---|---|
| 1 | `registrarMensagem` na transação | **JÁ FEITO (código)** — `fix/p0-ingresso-whatsapp-transacao` `f1064c0`, não mesclada. **Sem teste reexecutável neste ambiente** (o teste degrada em corpo vazio sem `CRMCLINICA_TEST_DATABASE_URL`) — mesclar só depois do Commit 24 |
| 2 | `definirEtiquetasDaConversa` na transação | SÓ PLANO — **sem ele o item 1 não resolve o 500** |
| 3 | `definirDisponibilidades` + contrato de `pool.connect()` | SÓ PLANO |
| 4 | Barreira final da Serena | JÁ CORRETO — falta teste de invariante |
| 5 | Cancelamento de geração em voo | SÓ PLANO — **proposta é não fazer**; barreira já cobre a segurança |
| 6 | Idempotência de entrada | JÁ CORRETO — falta teste de corrida + comentário sobre replay |
| 7 | Outbox transacional | JÁ CORRETO — falta teste de ROLLBACK |
| 8 | Worker, lease, fencing | JÁ CORRETO (N-9 corrigido) — falta I-8 explícito + teste de 2 workers |
| 9 | Retry / backoff / dead-letter | JÁ CORRETO — falta teste |
| 10 | Entrega indeterminada nunca retentada | JÁ CORRETO — falta teste |
| 11 | Idempotência no canal Evolution | SÓ PLANO — escopo menor: `canal-conversas.js` **já passa a chave**; falta só o adaptador usá-la |
| 12 | SSE depois do COMMIT | SÓ PLANO |
| 13 | SSE com cursor e recuperação | SÓ PLANO |
| 14 | Polling da thread aberta + comentário corrigido | SÓ PLANO |
| 15 | Token de recuperação atômico | SÓ PLANO |
| 16 | Guarda de duplo clique | SÓ PLANO |
| 17 | Rate limit + tempo constante | SÓ PLANO |
| 18 | Botões `data-tela` + teste honesto | SÓ PLANO |
| 19 | Falhas silenciosas de UI | SÓ PLANO |
| 20 | Migration de reconciliação do drift | SÓ PLANO — aplicar exige autorização. **Pré-requisito novo:** gerar/versionar `extracao.json` e resolver a divergência `is_admin_master`/`is_colaborador` × `is_gestor_or_admin`/`is_atendente` antes de escrever SQL |
| 21 | `audit_log` com origem e correlation | SÓ PLANO — aplicar exige autorização |
| 22 | Regressão de RLS/GRANT | JÁ CORRETO hoje — falta checagem automática |
| 23 | Estado desejado × efetivo | PARCIAL — diagnóstico e heartbeat existem; falta sonda de drift |
| 24 | Banco de teste separado | SÓ PLANO — **pré-requisito de tudo marcado ⚠** |
| 25 | Flaky de `inbox-http` | SÓ PLANO — causa não investigada |
| 26 | Scripts de qualidade | SÓ PLANO |
| 27 | E2E do caminho crítico | PARCIAL — existe `e2e-fluxo-critico.test.js`; falta o E2E contra Postgres |
| 28 | Rollout e reversão | SÓ PLANO — nada executado sem autorização |
