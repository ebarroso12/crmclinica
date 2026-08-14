# Auditoria integral do crmclinica — 2026-08-14

**Branch auditada:** `fix/auditoria-integral-crm-sem-deploy` (HEAD `27c7edb0dc311ac7985fd82bbe46b0c568e12ca4`, criada a partir de `main`)
**Remote:** `https://github.com/ebarroso12/crmclinica`
**Modo:** somente leitura de código e configuração. Nenhum arquivo de produção foi alterado, nenhum deploy, nenhuma migration aplicada, nenhuma escrita no banco real.
**Acesso ao banco real:** apenas catálogo (`information_schema`, `pg_catalog`, `pg_indexes`, `pg_policies`, `pg_proc`, `pg_constraint`) e contagens agregadas, com o papel `crmclinica_app` (`rolbypassrls = false`). Nenhuma linha de `mensagens`, `contatos`, `usuarios`, `sessoes` ou qualquer tabela de negócio foi lida.

Sete frentes de auditoria trabalharam em paralelo: autenticação/senha, webhook/outbox/Serena, banco/migrations, botões de UI, chat ao vivo, segurança/interferência, baseline/arquitetura. Este documento consolida os achados.

**Regra de leitura deste documento:** cada afirmação vem marcada como **CONFIRMADO** (com evidência arquivo:linha, e quando existe, reprodução executada), **HIPÓTESE** (deduzida do código mas não reproduzida) ou **REFUTADO** (a preocupação foi investigada e não se sustenta). Nada foi promovido de hipótese a confirmado sem evidência trazida por um auditor.

> **Revisão independente (2026-08-14, auditor externo).** Um revisor que não participou das sete frentes releu os três documentos, reabriu cada `arquivo:linha` citado, reexecutou `npm run verificar` e `npm test`, e reproduziu por conta própria o cenário de perda de SSE. **O resumo da revisão está na seção 12, no fim deste arquivo.** Correções pontuais foram aplicadas em linha, marcadas com **[CORREÇÃO DA REVISÃO]**. Achados P0-1, P0-2, P0-3, P1-1, P1-2, P1-3, P1-4, P1-6, P2-1 a P2-7 foram confirmados. Cinco afirmações de evidência foram refutadas e quatro rebaixadas por falta de prova reproduzível — todas identificadas na seção 12.

---

## 1. Resumo executivo

O crmclinica é um CRM clínico completo e funcional — inbox com SSE, kanban de leads, agenda com constraint de exclusão no banco, automação de IA (Serena) com interruptor durável, outbox transacional, sincronia com Google Calendar, RBAC, 2FA obrigatório para master/admin, RLS ligada em todas as 40 tabelas. A qualidade defensiva do código é alta: SQL sempre parametrizado, XSS coberto por `textContent`/`escapar()`, sem cookie de sessão (logo sem CSRF clássico), sem segredo em log, barreira final de envio revalidada contra o banco e fail-closed.

O que a auditoria encontrou de fato:

**Um P0 vivo e não corrigido em lugar nenhum:** `definirEtiquetasDaConversa` (`src/dados/repositorio.js:907`) abre conexão própria com `pool.connect()` em vez de participar da transação ambiente. É chamada dentro da mesma transação do ingresso de WhatsApp, para toda conversa nova, e bate em violação de FK. É exatamente o mesmo defeito de `registrarMensagem` que já foi corrigido na branch `fix/p0-ingresso-whatsapp-transacao` — só que um passo adiante no mesmo fluxo. **Aplicar só a correção existente não resolve o 500 da primeira mensagem de um contato novo.**

**Um P0 já corrigido mas não mesclado:** `registrarMensagem` (`src/dados/repositorio.js:545`) na branch `fix/p0-ingresso-whatsapp-transacao` (commit `f1064c0`), com teste de reprodução contra Postgres real. A correção foi revisada nesta auditoria e está correta — porém incompleta pelo motivo acima.

**Chat ao vivo perde mensagem em silêncio.** O barramento SSE é um `Set` em memória de processo (`src/servidor/eventos-conversas.js:12-54`), rodando atrás de função serverless multi-instância na Vercel, sem cursor de reconexão e sem polling da conversa aberta. Perda comprovada com servidor real rodando localmente, mesmo dentro de uma única instância.

**Dois botões mortos na tela "Hoje"** (`public/index.html:233` e `:248`) — seletor `nav [data-tela]` não os alcança. O teste que deveria pegar isso (`testes/botoes-orfaos.test.js:74`) dá falso positivo porque só verifica string no HTML.

**Drift de banco real, não versionado em `db/`:** 53 policies `crm008_*`, 3 funções `SECURITY DEFINER`, 10 policies `restrict_*` para o papel `authenticated` e a view `v_metricas_uso_usuarios_dia` existem em produção e **não existem em nenhum arquivo `db/*.sql`** deste repositório.
> **[CORREÇÃO DA REVISÃO]** A redação original dizia "**não documentado**". Isso é falso para a parte 008/009: o drift das funções e das 53 policies `crm008_*` **já está documentado** em `docs/PLANO-RECONSTRUCAO-008-009.md` (com snapshot real de 2026-08-08 e o `CREATE OR REPLACE FUNCTION` de cinco delas), em `docs/AUDITORIA-FINAL-2026-08-06.md:57-58`, em `docs/SEGURANCA.md:234` e em `db/010_lembretes.sql:3-8`, e existe ferramenta versionada de extração somente-leitura (`ferramentas/extrair-definicoes-008.js`, inclusive dentro de `npm run verificar`). O que é **novo** nesta auditoria são só os itens (b) `restrict_*` e (c) `v_metricas_uso_usuarios_dia`, que não aparecem em nenhum desses documentos. O problema real permanece: nada disso está em `db/*.sql`, então restaurar só de `db/` continua produzindo schema diferente.

**O que NÃO se confirmou:** SQL injection, XSS explorável, CSRF, enumeração de usuário por corpo/status, segredo em log, secret JWT fraco, open-redirect no link de recuperação — todos investigados e refutados com evidência.

---

## 2. Mapa da arquitetura

### 2.1 Entradas do sistema

| Entrada | Arquivo:linha | Observação |
|---|---|---|
| Standalone / VPS | `src/index.js:1-127` | `npm run iniciar`; carrega `.env` (10-17), escolhe repositório Postgres ou memória (35-47), mata o processo se config inválida em produção (61), exige conexão segura/RLS (69-76) |
| Serverless Vercel | `api/index.js:1-51` | Exporta `criarAplicacao(...)` direto como handler; reaproveita pool entre invocações (41). `vercel.json` reescreve `/api/:caminho*` → `/api/index` |
| Workers | `bin/worker-outbox.js`, `bin/worker-lembretes.js`, `bin/worker-google-outbox.js`, `bin/worker-heartbeat.js` | Processos separados no VPS (serviços systemd) |

### 2.2 Dispatcher central

Toda rota passa por `tratarRequisicao` em `src/servidor/http.js:1369` (arquivo de 1751 linhas). Ordem relevante:

- cabeçalhos de segurança fixos em toda resposta (`http.js:80-89`: `nosniff`, `X-Frame-Options: DENY`, CSP `default-src 'self'`);
- lista fechada de estáticos, sem travessia de caminho (`http.js:71-78`);
- log de acesso sem corpo/telefone/usuário (`http.js:1376-1382`);
- `/health` sem autenticação, expõe `rls_efetivo` sem credencial (`http.js:1398-1435`);
- identificação Bearer uma vez por requisição (`http.js:1438`);
- **gate de 2FA pendente** bloqueia todo `/api/*` exceto `/api/auth/*` (`http.js:1444-1450`), antes de qualquer rota de negócio;
- rotas deliberadamente **fora de transação**, cada uma com comentário justificando: voz da Serena (1454-1471), `/api/resumo` via heartbeat (1473-1516), auditoria (1518-1525), SSE (1533-1599), autenticação (1611, motivo: rate limit não pode ser desfeito por ROLLBACK), webhooks (1613-1635), `/api/agente/acao` (1643-1646), laboratório da Serena (1648-1651);
- todo o resto passa por `comIdentidade` → transação com o usuário declarado ao banco (`http.js:1655-1658`).

### 2.3 Fluxo do WhatsApp (caminho crítico)

```
Evolution / OpenClaw
  → POST /api/canais/whatsapp/eventos            http.js:1624
  → receberMensagemDoWhatsapp                    http.js:516
  → receberEventoAssinado                        http.js:354
      HMAC-SHA256 do corpo BRUTO, timingSafeEqual  openclaw.js:54-60, http.js:361-374
      (2ª porta: token na querystring, só Evolution) http.js:507-514, 375-380
      normalizarEventoEvolution                  evolution-webhook.js:63
      validarEvento + exigirEstrategiaDoAdaptador  contratos/evento.js:84, 160
  → repositorio.comUsuario(null, processarEGravarRecibo)   http.js:487-489   [TRANSAÇÃO ÚNICA]
      consultarEvento (dedupe de entrada)        http.js:435
      atendimento.receberMensagem                atendimento.js:72
          encontrarOuCriarContato/Conversa       atendimento.js:85-94
          registrarMensagem                      atendimento.js:96   ← P0-1
          emissor.publicarMensagem (SSE)         atendimento.js:112  ← P1-3 (antes do COMMIT)
          sincronizarTemperatura
            → definirEtiquetasDaConversa         atendimento.js:145  ← P0-2
          enfileirarTrabalhoDeOutbox             atendimento.js:180-185
      registrarEvento (recibo)                   http.js:466
  → 202 só depois do COMMIT                      http.js:491

bin/worker-outbox.js  (processo separado)
  → processarLote                                automacao-outbox-servico.js:188
      reivindicarTrabalhos (FOR UPDATE SKIP LOCKED)  repositorio.js:2605
      renovarReivindicacao por trabalho          automacao-outbox-servico.js:200-210
      atendimento.responderSePossivel            atendimento.js:213
          podeResponder (1ª leitura)             atendimento.js:220-222
          orquestrador.despacharEvento (IA)      atendimento.js:368
          registrarMensagem da resposta          atendimento.js:389
          entregarAoPaciente                     atendimento.js:406
              podeEntregarAgora — BARREIRA FINAL atendimento.js:612, chamada em 646
              canal.enviar                       atendimento.js:692 / canal-conversas.js:70-92
```

### 2.4 Domínio

34 arquivos em `src/dominio/`. Núcleo do caminho auditado: `atendimento.js` (decide resposta automática e escalonamento), `serena-servico.js` (liga/desliga/pausa/plantão, sem cache — relê a config do banco a cada `podeResponder`, `serena-servico.js:155-164`, comentário 12-15 explica que cache de 30s significaria meio minuto de respostas depois do "PARAR"), `automacao-outbox.js` (regras puras da fila) + `automacao-outbox-servico.js` (worker), `conversas.js`/`serena.js` (regras puras de decisão), `agenda-servico.js` + `agenda.js`, `diagnostico.js` + `diagnostico-sondas.js`.

### 2.5 Ferramental (baseline formal, executado nesta branch)

| Item | Estado | Evidência |
|---|---|---|
| `node` / `npm` | v24.15.0 / 12.0.2 | executado |
| `npm run verificar` | **exit 0**, mas é apenas 111× `node --check` — só sintaxe | `package.json:24`, contagem programática: 111 checks |
| `npm test` | `node --test "testes/**/*.test.js"` — **1091 testes, 1091 pass, 0 fail** nesta branch | `package.json:23`; reexecutado pela revisão independente, exit 0 |
| lint | **não existe** | `devDependencies: {}` no `package.json` |
| typecheck | **não existe** | projeto é JS puro, `"type": "commonjs"` |
| build | **não existe** | `main` aponta direto para `src/index.js` |
| script `integracao` / `e2e` isolado | **não existe** | e2e vive misturado dentro de `npm test` |
| audit de dependência | **não existe** como script | única dependência de produção: `pg: ^8.22.0` |

**CONFIRMADO:** `npm run verificar` limpo **não é prova de comportamento** — é parse de sintaxe. Nenhum achado deste documento se apoia nele.

**Higiene do repositório:** `git status --short` na branch mostra, além de `.claude/worktrees/`, `"DOCUMENTO CRM/"` e `scripts/`, um arquivo-lixo não rastreado chamado `res.write('` na raiz — exatamente a armadilha documentada em `CLAUDE.md` (hooks globais executam via `cmd /c` e o `>` de arrow function vira redirecionamento). Não foi apagado por esta auditoria (apagar arquivo exige autorização expressa), mas **não deve ser commitado**.

---

## 3. Achados por gravidade

### P0-1 — `registrarMensagem` abria conexão própria dentro da transação do webhook

- **Status:** CONFIRMADO e **já corrigido** na branch `fix/p0-ingresso-whatsapp-transacao` (commit `f1064c0`) — **não mesclada** em `main` nem nesta branch de auditoria.
- **Evidência do defeito nesta branch:** `src/dados/repositorio.js:545-602` — `registrarMensagem` chama `pool.connect()` (linha 546) e faz `BEGIN`/`COMMIT` próprios, ignorando `contexto.atual()?.client`.
- **Contraste com o padrão correto:** o helper `consultar` usa `contexto.atual()?.client ?? pool` (`src/dados/repositorio.js:273`); `comUsuario` registra `{client, usuarioId, claims}` no contexto (`repositorio.js:347-384`, especificamente 365-368); `publicarPromptDaSerena` (`repositorio.js:2197-2209`) já fazia o if/else correto antes do fix.
- **Causa raiz:** contato e conversa recém-criados existem apenas dentro da transação ainda sem `COMMIT`. Uma conexão isolada não os enxerga (MVCC). O `INSERT INTO mensagens` bate em `mensagens_conversa_id_fkey` (`db/001_inbox.sql:74`, confirmado idêntico no banco real) e a requisição devolve HTTP 500.
- **Reprodução:** `testes/ingresso-whatsapp-transacao.test.js` (existe só na branch do fix) contra Postgres real via `CRMCLINICA_TEST_DATABASE_URL`. **Não** contra `repositorio-memoria.js`, que é single-thread e não tem conexões nem MVCC — não provaria nada.
  > **[CORREÇÃO DA REVISÃO]** Essa reprodução **não é reexecutável neste ambiente hoje**, e o documento original não dizia isso. `CRMCLINICA_TEST_DATABASE_URL` não está definida (confirmado), e sem ela o arquivo cai no ramo `if (!URL_DE_TESTE)` e registra um teste **vazio** chamado "PULADO" — que passa e conta como +1 no total. É por isso que a branch do fix reporta 1092 e esta reporta 1091. Consequência honesta: **o "vermelho/verde contra Postgres real" do commit `f1064c0` é hoje uma afirmação do autor do commit, não um artefato que um segundo auditor consiga reproduzir.** O achado P0-1 em si (o `pool.connect()` na linha 546) permanece CONFIRMADO por leitura; o que não se sustenta como prova reproduzível é a execução do teste. Ver Commit 24 do plano — provisionar o banco de teste é pré-requisito de tudo.
- **Escopo real:** só contato/conversa **novos**. Contato e conversa já existentes (commitados por requisição anterior) nunca sofreram o problema.
- **Revisão da correção (2 auditores independentes):** correta. Usa `contexto.atual()?.client` quando há transação ambiente; cai para conexão isolada com `BEGIN`/`COMMIT`/`ROLLBACK` quando não há; e no caso "mensagem duplicada" com transação ambiente **não** faz `ROLLBACK` — o que está certo, pois abortaria escritas legítimas de contato/conversa/outbox na mesma transação. Diff verificado: toca **apenas** `src/dados/repositorio.js` e adiciona `testes/ingresso-whatsapp-transacao.test.js` (61 e 111 linhas).
- **Nota menor, não é bug:** ao reaproveitar o client ambiente, o fix usa `cliente.query(...)` direto em vez da fila `consultarNoCliente`/`filasPorCliente` que o resto do repositório usa. O driver `pg` já serializa `.query()` concorrentes na mesma conexão (`node_modules/pg/lib/client.js`, `_queryQueue`/`_pulseQueryQueue`), então não há corrida real — é inconsistência de padrão interno.
- **Arquivos que mudam:** `src/dados/repositorio.js`, `testes/ingresso-whatsapp-transacao.test.js`.

---

### P0-2 — `definirEtiquetasDaConversa` tem o MESMO bug, no MESMO fluxo, e não está corrigido em lugar nenhum

- **Status:** **CONFIRMADO por leitura de código + schema + rastreio completo da cadeia de chamada.** Não reproduzido contra Postgres (não há banco de teste separado configurado; o único Postgres acessível é o de produção, fora de escopo para escrita).
- **Evidência:** `src/dados/repositorio.js:906-929` — verificado diretamente nesta sessão:
  ```js
  async definirEtiquetasDaConversa(conversaId, nomes) {
    const cliente = await pool.connect();          // ← linha 907: ignora contexto.atual()
    try {
      await cliente.query('BEGIN');
      await cliente.query('DELETE FROM conversa_etiquetas WHERE conversa_id = $1', [conversaId]);
      if (nomes.length > 0) {
        await cliente.query(`INSERT INTO conversa_etiquetas (conversa_id, etiqueta_id) ...`);
      }
      await cliente.query('COMMIT');
  ```
- **Cadeia de chamada até o webhook:**
  1. `http.js:487-489` abre `repositorio.comUsuario(null, processarEGravarRecibo)` — transação única.
  2. `atendimento.receberMensagem` (`atendimento.js:72`) roda dentro dela.
  3. `atendimento.js:145` chama `sincronizarTemperatura` **incondicionalmente**, e **antes** do desvio de `despachoEmSegundoPlano` (linhas 180-185).
  4. `sincronizarTemperatura` (`atendimento.js:753-766`) chama `definirEtiquetasDaConversa`.
- **Por que dispara sempre em conversa nova:** `conversa.ultima_msg_em` acabou de ser gravado na mesma transação (`repositorio.js:578-584`), então `sugerirTemperatura` sempre devolve temperatura não-vazia por `atividade_recente` (`src/dominio/leads.js:61-63`) — nunca `etiqueta_da_equipe` numa conversa que acabou de nascer. E `aplicarTemperatura` (`src/dominio/conversas.js:41-47`) devolve `[...preservadas, ETIQUETA_POR_TEMPERATURA[temperatura]]`, que nunca é array vazio. Logo o `INSERT INTO conversa_etiquetas` sempre executa.
- **Causa raiz:** idêntica à P0-1 — conexão isolada não enxerga a linha de `conversas` ainda sem `COMMIT`. `conversa_etiquetas.conversa_id REFERENCES conversas(id)` (`db/001_inbox.sql:107`), **sem `DEFERRABLE`**. Violação de FK derruba a transação inteira.
- **Consequência prática, e é o achado mais importante desta auditoria:** **mesclar apenas a correção de P0-1 NÃO resolve o erro 500 na primeira mensagem de um contato novo pelo WhatsApp.** O 500 apenas se desloca de `registrarMensagem` para `definirEtiquetasDaConversa`, alguns passos adiante na mesma transação.
- **Arquivos que mudam:** `src/dados/repositorio.js` (aplicar o mesmo padrão `contexto.atual()?.client`), `testes/ingresso-whatsapp-transacao.test.js` (estender a reprodução para cobrir contato novo até o fim de `receberMensagem`, não só até `registrarMensagem`).

---

### P0-3 — Terceira ocorrência do mesmo padrão: `definirDisponibilidades`

- **Status:** CONFIRMADO como violação do contrato ("participar da transação ambiente quando ela existe"). **HIPÓTESE, não confirmada:** que exista hoje um caminho de chamada que crie um profissional e defina disponibilidade na mesma transação. Nenhum auditor encontrou esse caminho.
- **Evidência:** `src/dados/repositorio.js:1887-1908` — `pool.connect()` isolado, sem `contexto.atual()`.
- **Inventário completo:** existem exatamente **5** ocorrências de `pool.connect()` em `src/dados/repositorio.js` — linhas `352` (é `comUsuario`, dona legítima da transação, correto por definição), `546` (P0-1), `907` (P0-2), `1888` (este), `2211` (`publicarPromptDaSerena`, que já faz o if/else correto). Busca exaustiva no arquivo; nenhuma outra.
- **Gravidade:** classificado P0 por pertencer à mesma classe de defeito e ser corrigível no mesmo commit, não por impacto comprovado — o impacto hoje é HIPOTÉTICO.
- **Arquivos que mudam:** `src/dados/repositorio.js`.

---

### P1-1 — Chat ao vivo perde mensagens em silêncio (SSE sem cursor, emitter em memória, atrás de serverless)

- **Status:** CONFIRMADO, com reprodução executada contra servidor real.
- **Mecanismo:** `src/servidor/eventos-conversas.js:12-54` — `Set` de respostas HTTP em memória de módulo. Sem Redis, sem fila, sem storage compartilhado. Instanciado uma vez por `criarAplicacao` (`http.js:157`); a rota `GET /api/conversas/eventos` inscreve a conexão (`http.js:1533-1599`).
- **O comentário do próprio arquivo está errado.** `eventos-conversas.js:6-10` afirma que isso é seguro porque "o crmclinica roda como um serviço de sistema, não em funções serverless replicadas". Mas:
  - `api/index.js:1-6` diz explicitamente "Ponte para a Vercel: a mesma aplicação usada localmente responde como função serverless";
  - `vercel.json` reescreve `/api/:caminho*` → `/api/index`, ou seja `/api/conversas/eventos` **é** servido pela função serverless;
  - `src/config.js:190-200` só define `configuracao.sse.limiteMs` quando `VERCEL` está no ambiente — os próprios autores sabiam que essa rota roda na Vercel.
- **Reprodução executada** (script scratch, servidor real via `testes/auxiliar.js`, repositório em memória, nunca banco/produção): abriu conexão SSE → 2 mensagens chegaram → fechou a conexão → mandou a 3ª com nenhuma conexão aberta → reabriu → **`Eventos recebidos por conexao-2 (após reconexão): 0`**. A mensagem 3 existe e é lida corretamente por `repositorio.listarMensagens`, mas nunca chega por SSE a quem reconectou.
  > **[REVISÃO — REPRODUZIDO DE FORMA INDEPENDENTE]** O revisor reescreveu o script do zero (fora do repo, em `%TEMP%`, servidor real por `subirServidor` + `criarEmissorDeConversas` + repositório em memória) e obteve o mesmo resultado: `conexao-1 recebeu eventos: 4` → nenhuma conexão aberta → `conexao-2 (após reconexão) recebeu eventos: 0` → `mensagens gravadas no repositorio: 8`. Este é o único achado do documento cuja execução foi confirmada por dois auditores independentes.
- **Sem cursor de reconexão — REFUTADO que exista:** `eventos-conversas.js:25-34` nunca escreve campo `id:` SSE (só `data:`); a rota não lê `Last-Event-ID` nem parâmetro de posição (só `token`, `http.js:1542`); o cliente abre sempre a mesma URL sem cursor (`public/app.js:1549`) e o `onerror` só fecha e reabre 5s depois (`app.js:1569-1574`).
- **Agravante do ciclo de vida:** `http.js:1592-1595` força fechamento da SSE a cada 270000ms na Vercel — mesmo numa instância quente, a cada ~4,5 min a conexão recicla e pode reabrir em outra instância.
- **Rede de segurança insuficiente:** `public/app.js:1592` faz `setInterval(carregarConversas, 30000)` — atualiza só a **lista lateral**. Não existe `setInterval` equivalente para a **thread aberta**, que só é rebuscada quando chega evento SSE da `conversaAberta` (`app.js:1564-1566`). Se a mensagem perdida for na conversa que o atendente está vendo, ela não aparece sozinha.
- **Perda entre instâncias Vercel concorrentes:** dedução da mesma arquitetura, **não reproduzida** contra 2 lambdas reais nesta sessão. **[CORREÇÃO DA REVISÃO]** A redação original dizia "CONFIRMADA por leitura de código e config", o que contradiz a própria H3 da seção 8, que a lista como hipótese não confirmada. Fica como **HIPÓTESE**, alinhada com H3. O que está confirmado (e reproduzido duas vezes, ver abaixo) é a perda **dentro de uma única instância**.
- **Heartbeat existe** (`http.js:1562-1571`, `setInterval(() => res.write(': ping\n\n'), 25000)` com `unref()`), então este achado **não** é falta de heartbeat.
- **Dedup no cliente não existe e não é necessário:** `app.js:1551-1567` rebusca a thread inteira e `desenharThread` (`app.js:583-585`) faz `thread.innerHTML = ''` e redesenha do zero. Evento duplicado gera requisição redundante, não duplicação visual.
- **Arquivos que mudam:** `src/servidor/eventos-conversas.js`, `src/servidor/http.js` (rota SSE + `Last-Event-ID`), `public/app.js` (cursor + polling da thread aberta), possivelmente `db/0XX_*.sql` (sequência durável de eventos por conversa).

---

### P1-2 — SSE é emitido ANTES do COMMIT da transação

- **Status:** CONFIRMADO quanto à ordem de execução (leitura de código, verificada diretamente nesta sessão). **HIPÓTESE** quanto ao efeito observável: nenhum auditor fabricou uma falha no meio da transação para ver o navegador exibir mensagem que sofreu ROLLBACK.
- **Evidência:** `src/dados/repositorio.js:347-371` — `comUsuario` faz `BEGIN` (354) → `await acao(this)` (365-368, onde roda toda a lógica de domínio) → `COMMIT` (370); qualquer exceção dentro de `acao` cai no `catch` (372+) e faz `ROLLBACK`.
- **Ponto de emissão no caminho do webhook:** `src/dominio/atendimento.js:112` — `emissor?.publicarMensagem(conversa.id, mensagem)`, logo após `registrarMensagem` (96) e **antes** de `salvarLead` (131), `leads.qualificar` (137-138) e do `registrarEvento`/`registrarAuditoria` do chamador (`http.js:466`). Comentário nas linhas 109-111 documenta a intenção ("anuncia assim que a mensagem existe no banco") — a intenção é legítima, o problema é que "existe no banco" ainda não é verdade para ninguém fora da transação.
- **Mesmo padrão em:** `atendimento.js:399` (resposta da Serena), `:515` (`assumir`), `:555` (`responderComoEquipe`), `:728` (`escalonar`) — todos alcançados via `comIdentidade` (`http.js:1342-1394`), que também é `repositorio.comUsuario(...)`.
- **Ironia documentada:** `http.js:470-486` traz comentário extenso explicando que "o 202 só sai DEPOIS do COMMIT" — o cuidado existe para a resposta HTTP, mas o SSE já saiu bem antes.
- **Arquivos que mudam:** `src/dados/repositorio.js` (fila de eventos pós-commit no `comUsuario`), `src/dominio/atendimento.js` (trocar emissão direta por enfileiramento), `src/servidor/eventos-conversas.js`.

---

### P1-3 — Consumo do token de recuperação de senha é check-then-act, não atômico

- **Status do padrão no código:** CONFIRMADO (fato de código, verificado diretamente). **Status do impacto sob concorrência real:** HIPÓTESE plausível, **não reproduzida** — não existe teste de concorrência para esse fluxo. `CRMCLINICA_TEST_DATABASE_URL` só aparece em `testes/contrato-repositorio.test.js` e `testes/lembretes-concorrencia.test.js`, nenhum dos dois cobre `recuperacoes_senha`. O teste existente (`testes/contas-http.test.js:269-289`) roda contra `repositorio-memoria.js`, single-thread por construção.
- **Evidência:** `src/seguranca/contas.js:304-339`, lido integralmente nesta sessão. Sequência: **[CORREÇÃO DA REVISÃO — desvio de citação]** as linhas exatas são `contas.js:306-338` (`async function redefinirSenha` começa em 306); dentro dela, `obterRecuperacaoPorHash` está em **310** (não 309), a checagem em memória em **312** (não 311), `atualizarUsuario` em **323** (não 322) e `marcarRecuperacaoUsada` em **327** (não 326). O conteúdo de cada passo confere; só a numeração estava 1-2 linhas deslocada.
  1. `obterRecuperacaoPorHash` (linha 309) — SELECT simples (`repositorio.js:1837-1843`); `usado_em` e expiração checados **em memória, na aplicação** (linha 311).
  2. `atualizarUsuario(...)` (linha 322) — grava a senha nova **incondicionalmente**.
  3. `marcarRecuperacaoUsada(id)` (linha 326) — só agora faz `UPDATE ... WHERE id = $1 AND usado_em IS NULL` (`repositorio.js:1845-1847`). A única cláusula condicional do fluxo protege apenas a marcação, não a troca de senha.
- **Gatilho realista, não hipotético:** `#form-redefinir` (`public/app.js:1695`) **não desabilita o botão durante o `fetch`** — duplo clique ou reenvio por timeout dispara dois `POST /api/auth/redefinir` com o mesmo token. Não depende de atacante; um usuário apressado provoca.
- **Efeito deduzido:** as duas requisições passam pelo passo 1 antes de qualquer uma marcar o token; ambas executam o passo 2; a senha final é a da última a escrever; ambas respondem sucesso.
- **Arquivos que mudam:** `src/seguranca/contas.js`, `src/dados/repositorio.js` (consumo atômico com `RETURNING`), `public/app.js` (guarda de duplo clique), `testes/contas-http.test.js` + novo teste de concorrência contra Postgres.

---

### P1-4 — Dois botões da tela "Hoje" não têm handler: clique não faz nada

- **Status:** CONFIRMADO por análise estática determinística, verificada diretamente nesta sessão.
- **Evidência:**
  - `public/index.html:233` — `<button type="button" class="link" data-tela="conversas">Ver todas</button>`
  - `public/index.html:248` — `<button type="button" class="link" data-tela="agenda">Agenda</button>`
  - `public/app.js:47` — `for (const gatilho of document.querySelectorAll('nav [data-tela]'))`
- **Causa raiz:** `'nav [data-tela]'` é combinador descendente — só casa elementos com ancestral `<nav>`. O `<nav>` do menu lateral vai de `public/index.html:155` a `:176`. O `<main class="area" id="conteudo">` começa em `:188`. Os dois botões, em `:233` e `:248`, estão dentro de `<main>`, fora do `<nav>`. Verificado nesta sessão com as três leituras (seletor, faixa do nav, posição dos botões).
- **Não há fallback:** `data-tela` só aparece em `app.js` nas linhas 27 e 47, ambas escopadas a `nav`. Os dois handlers delegados em `document` (`app.js:3262` e `:3904`) tratam `alvo.id` e outras chaves de `dataset`, nunca `tela`.
- **Efeito:** clique em "Ver todas" (card Fila de atendimento) e em "Agenda" (card Próximos compromissos) não navega, não erra, não loga. Falha 100% silenciosa.
- **Por que a suíte não pegou:** `testes/botoes-orfaos.test.js:74` cita esse exato botão, mas só verifica que a string `data-tela="conversas">Ver todas</button>` existe no HTML; o comentário da linha 71 afirma que ele "tem handler de verdade" sem checar posição no DOM. **Nenhum teste do repositório executa DOM real** — não há jsdom em `node_modules` nem em `package.json` (confirmado em `testes/entrega-nao-realizada-ui.test.js:9`). Defeito de escopo de seletor CSS é estruturalmente invisível à suíte atual.
- **Arquivos que mudam:** `public/app.js` (delegação de `data-tela` em `document`, ou segundo `querySelectorAll`), `testes/botoes-orfaos.test.js` (parar de dar falso positivo).

---

### P1-5 — Drift de schema: objetos reais em produção sem arquivo de migration

- **Status:** CONFIRMADO por consulta ao catálogo real (só `pg_policies`, `pg_proc`, `information_schema`), cruzada com `grep` no repositório inteiro (incluindo os worktrees em `.claude/worktrees/`).

**(a) Migration "008" nunca versionada.** 53 policies com prefixo `crm008_*` existem em produção (padrão `crm008_a_s`/`_a_i`/`_a_u`/`_a_d` em `agendamentos`, `contatos`, `conversas`, `mensagens`, `usuarios`, `leads`, `sessoes`, `tentativas_autenticacao`, `recuperacoes_senha`, `lead_eventos`, `notas_internas`, `conversa_etiquetas`, `disponibilidades`, `agenda_bloqueios`, `profissionais`, `etiquetas`, `eventos_recebidos`, `audit_log`). Elas **substituem** o padrão de política única por tabela (`app_trabalho`/`app_total_*` `FOR ALL USING(true)`) criado por `db/007_hardening.sql:171-177` e `db/002_autenticacao_e_rls.sql:93-95`, por quatro políticas por operação. `grep -r "crm008"` em `db/`: **zero ocorrências**. `db/010_lembretes.sql:3-8` já registrava que 008 e 009 foram aplicadas por fora.
Três funções `SECURITY DEFINER` com `search_path=''` — `current_usuario_id()`, `is_admin_master()`, `is_colaborador()` — existem em produção; `db/018_restringir_funcoes_security_definer.sql:11-19` só faz `REVOKE`/`GRANT` sobre elas, **nenhum arquivo `db/*.sql` contém o `CREATE FUNCTION`**.

> **[CORREÇÃO DA REVISÃO — duas afirmações refutadas]**
> 1. A redação original era `grep -r "crm008"` **no repo**: zero ocorrências, e a seção 5 dizia que a busca cruzou "o repositório inteiro (incluindo os worktrees em `.claude/worktrees/`)". Isso é **falso**. `crm008` aparece em 6 arquivos rastreados fora de `.claude/`: `docs/PLANO-RECONSTRUCAO-008-009.md`, `docs/AUDITORIA-FINAL-2026-08-06.md`, `docs/ENTREGA-SERENA-LEADS-IA.md`, `docs/SEGURANCA.md:234`, `docs/SEGURANCA-P1-REDACAO-AUDITORIA.md`, `ferramentas/extrair-definicoes-008.js`, além de `src/dados/repositorio.js:323`. O que é verdade é o recorte estreito: zero ocorrências **em `db/*.sql`**.
> 2. "Nenhum arquivo local contém o `CREATE FUNCTION`" também é **falso**: `docs/PLANO-RECONSTRUCAO-008-009.md` traz cinco `CREATE OR REPLACE FUNCTION` reais extraídos de produção em 2026-08-08 por `pg_get_functiondef`, incluindo `public.current_usuario_id()` (linha 63). `is_admin_master()` e `is_colaborador()` **não** aparecem lá (o snapshot de 2026-08-08 lista `is_gestor_or_admin()` e `is_atendente()`) — ou foram renomeadas depois, ou o inventário de agora está usando nomes diferentes; **essa divergência não foi resolvida** e é material para a migration de reconciliação.
> Efeito líquido: o achado **não é novo** para a parte 008/009 — já havia plano escrito e ferramenta versionada. Continua válido que nada disso está em `db/`.
O ledger `supabase_migrations.schema_migrations` **não pôde ser lido** (`permission denied for schema supabase_migrations` com o papel `crmclinica_app`) — logo a existência da 008/009 no ledger permanece **não confirmada diretamente**, apenas por evidência indireta forte no catálogo de objetos.

**(b) 10 policies `restrict_*` para o papel `authenticated`** (usando `is_admin_master()`/`is_colaborador()`) em `audit_log`, `conversas`, `mensagens` (4: select/insert/update/delete), `recuperacoes_senha`, `serena_configuracao`, `serena_prompts`, `serena_regras`, `sessoes`, `tentativas_autenticacao`, `usuarios`. Nenhum nome aparece em nenhum arquivo do repositório.
Risco **hoje baixo, por acidente e não por desenho**: `authenticated` **não tem nenhum GRANT de tabela em todo o schema `public`** (varredura completa de `information_schema.role_table_grants` para `anon`/`authenticated`: zero linhas — o REVOKE de `db/007_hardening.sql:287-294` segue em vigor). Como o Postgres checa privilégio de tabela antes de RLS, essas políticas são código morto hoje. Mas se alguém rodar `GRANT SELECT ON mensagens TO authenticated`, o resultado não está documentado em nenhuma migration deste repositório.

**(c) View `v_metricas_uso_usuarios_dia`** — agrega `audit_log` por dia/usuário com `JOIN usuarios`. Não existe em nenhum arquivo local. Não é a mesma coisa que as views `vw_*` de `db/026_analitica.sql`, que essas sim batem exatamente. Grants: só `crmclinica_app`; `anon`/`authenticated` não alcançam. Risco baixo (metadados de auditoria, não conteúdo clínico).

- **Arquivos que mudam:** nova migration aditiva de reconciliação em `db/` documentando (a), (b) e (c), ou removendo (b) se for decidido que é resíduo.

---

### P1-6 — `audit_log` não tem origem nem correlation-id estruturados

- **Status:** CONFIRMADO.
- **Evidência:** `db/001_inbox.sql:145-153` — colunas de `audit_log`: `id, usuario_id, entidade, entidade_id, acao, detalhe jsonb, criado_em`. `criado_em DEFAULT now()`. `usuario_id` preenchido por `registrarAuditoria` (`src/dados/repositorio.js:1494-1505`) a partir de `usuarioId ?? contexto.atual()?.usuarioId ?? null`.
- **O que falta:** não existe coluna `origem` (webhook / worker / painel / openclaw) nem `correlation_id`. Para ação automática, `usuario_id` fica `null` por natureza — correto, mas isso significa que **a origem só é distinguível pelo texto de `acao`/`detalhe`**, a critério de cada chamador.
- **Existe um `request_id` por requisição HTTP** (`src/servidor/http.js:1373`, a partir de `x-vercel-id`/`x-request-id`/`randomUUID()`), mas ele **só aparece no `console.log` de acesso** (`http.js:1378-1382`) — não é passado a `registrarAuditoria` em nenhum ponto verificado. Não há como cruzar uma linha de `audit_log` com a requisição que a gerou.
- **O que funciona bem:** `detalhe` passa por `redigirAuditoria` (`src/seguranca/redator-auditoria.js`) antes de gravar — deny-list por nome de chave + regex, em qualquer profundidade, reforçada por trigger de banco (migration 017, citada em `repositorio.js:1497-1499`).
- **Arquivos que mudam:** nova migration em `db/` (colunas `origem`, `correlation_id`), `src/dados/repositorio.js`, `src/servidor/http.js` (propagar `request_id` pelo contexto).

---

### P2-1 — Nenhum formulário de autenticação/CRUD tem proteção contra duplo clique

- **Status:** CONFIRMADO por leitura (ausência de `disabled = true` e de flag de ocupação nos trechos). **HIPÓTESE, não reproduzida:** que isso produza duplicidade observável de dado em cada um dos casos.
- **Evidência da lacuna:** `pedirJson` (`public/app.js:173-205`) é wrapper puro de `fetch`, sem debounce nem trava. Sem guarda: `#form-login` (1599), `#form-recuperar` (1675), `#form-redefinir` (1695), `#form-cadastro` (1649), `#form-trocar-senha` (2012), `#ativar-2fa` (2040), `#form-confirmar-2fa` (2051), `#desativar-2fa` (2067), `#form-resposta` (1235), `#botao-nota` (1245), `#form-ficha` (1320), `#horario-salvar` (3913), `#form-prompt` (3326), `#form-regra` (3351), `#form-contato` (3377), `#form-perfil` (1992), `#form-novo-usuario` (1922), `#ia-gerar-relatorio` (1079), `#assistente-perguntar` (1107), botões de status/cancelamento de compromisso (2630-2651).
- **O padrão existe no código e foi aplicado seletivamente** — `botao.disabled = true` + "Aplicando…" está em: `#parada-emergencia` (1491-1507), `#serena-ligar`/`#serena-desligar` (3127-3155), `#serena-pausar`/`#serena-despausar`/`#serena-plantao` (3609-3632), ações de conversa assumir/liberar/resolver/reabrir (1271-1278), `#diagnostico-verificar` (4125-4165), `#proposta-confirmar` (2543), `#teste-form` (flag `testeOcupado`, 3990-3991). O modal de QR usa contador `aberturaDoQr` (3645, 3757, 3869), proteção equivalente e correta.
- **Consequência já concreta:** este é o gatilho realista de **P1-3** (redefinição de senha).
- **Arquivos que mudam:** `public/app.js`.

---

### P2-2 — Rotas de verificação de senha sem rate limit dedicado

- **Status:** CONFIRMADO por leitura (ausência de chamada a `limitador` em todo o corpo das funções).
- **Evidência:** `POST /api/auth/senha` → `contas.trocarSenha` (`src/seguranca/contas.js:153-192`) e `POST /api/auth/segundo-fator/desativar` → `contas.desativarSegundoFator` (`contas.js:391-411`) não chamam o limitador em nenhum ponto. Só o custo do scrypt (~100ms) e a exigência de access token válido limitam tentativas de adivinhar `senha_atual`.
- **Mitigação existente:** ambas exigem sessão autenticada; não são superfície anônima.
- **Arquivos que mudam:** `src/seguranca/contas.js`, `src/seguranca/limite.js`.

---

### P2-3 — Canal timing na recuperação de senha (hoje inerte)

- **Status:** CONFIRMADO por leitura de código. **Não medido** — enviar e-mail real está proibido no escopo desta auditoria.
- **Evidência:** `src/seguranca/contas.js:257-303` — quando a conta existe e pode entrar, a função faz `await remetente.enviar(...)` (linha 278) antes de retornar; quando não existe, retorna quase imediatamente após um único SELECT. `remetente.enviar` (`src/seguranca/email.js:134-158`) é cliente SMTP escrito à mão sobre `net`/`tls` com handshake completo sequencial (`email.js:54-127`: connect, EHLO, STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT).
- **Efeito:** diferença de latência mensurável entre "conta existe" e "conta não existe", apesar de corpo e status idênticos — oráculo de enumeração por tempo.
- **Estado atual:** **HIPÓTESE de que esteja inerte** — o código prova o condicional (`email.js:134-148`: `disponivel = Boolean(configuracao.host && configuracao.remetente)`; sem isso, "log em vez de enviar" sem tocar a rede), mas **o valor real da variável em produção não foi lido por nenhum auditor** (ler env/secret da Vercel está fora do escopo). **[CORREÇÃO DA REVISÃO]** A redação original afirmava como fato que `configuracao.email.host` está vazio em produção. É plausível (é o que faz o botão de recuperação ficar escondido), mas não verificado aqui. **Volta a existir no dia em que SMTP for configurado.**
- **Arquivos que mudam:** `src/seguranca/contas.js`.

---

### P2-4 — Idempotência de saída ausente no canal Evolution

- **Status:** CONFIRMADO, e é risco explicitamente aceito no próprio código.
- **Evidência:** o gateway WebSocket do OpenClaw usa `idempotencyKey` de verdade — `src/integracoes/canal-conversas.js:41-50`, `chamar('send', { ..., idempotencyKey: chave })`. A Evolution API, canal primário hoje, **recebe a chave do chamador e a descarta**: `canal-conversas.js:80` já faz `evolucao.enviar({ telefone: destino, texto, chave })`, mas `evolution-envio.js:28` desestrutura só `{ telefone, texto }`. Comentário em `evolution-envio.js:8-14` confirma que é risco aceito.
  > **[CORREÇÃO DA REVISÃO]** A redação original dizia que a Evolution "nem recebe o parâmetro `chave`". Errado: o chamador **já passa** a chave uniformemente (`canal-conversas.js:80`) — quem a joga fora é o adaptador. O próprio `src/dominio/atendimento.js` (comentário do achado N-10, ~linha 695) já registrava isso corretamente: "recebe a chave mas nunca a usa". Consequência prática para o plano: metade do Commit 11 ("`canal-conversas.js` passa a chave uniformemente") **já está feita**; o trabalho real é só no adaptador da Evolution + registro local de envios.
- **Defesa real hoje:** folga do `LEASE_MS` do worker (5 min, `automacao-outbox.js:56`), não idempotência de transporte.
- **Arquivos que mudam:** `src/integracoes/evolution-envio.js`, `src/integracoes/canal-conversas.js`.

---

### P2-5 — Webhook não tem defesa de replay na camada de assinatura

- **Status:** CONFIRMADO (grep por `nonce|timestamp|replay` em `http.js` não retornou nada). **Classificado P2, não P1**, porque a idempotência downstream neutraliza o efeito.
- **Evidência:** a assinatura HMAC (`src/integracoes/openclaw.js:54-60`) cobre o corpo bruto, sem timestamp nem nonce. Um request capturado com assinatura válida pode ser reenviado indefinidamente e continuará válido.
- **O que impede efeito duplicado:** `chave_idempotencia = hash(versao|canal|tipo|id_externo)` (`src/contratos/evento.js:72-77`), checada em `eventos_recebidos` (`http.js:435-436`) e gravada com `ON CONFLICT (chave) DO NOTHING` (`repositorio.js:1475-1485`, inclusive com tratamento de corrida: quem perde o INSERT lê o recibo de quem ganhou, linhas 1482-1484). Backstop real de banco: `mensagens_id_externo_uk` (`db/001_inbox.sql:91`) usada com `ON CONFLICT (id_externo) DO NOTHING` em `registrarMensagem` (`repositorio.js:551-553`) e o UNIQUE de `automacao_outbox.chave_idempotencia` (`repositorio.js:2579`).
- **Arquivos que mudam:** `src/integracoes/openclaw.js`, `src/servidor/http.js` (se for decidido adicionar janela de timestamp).

---

### P2-6 — Falhas silenciosas de UI

- **Status:** CONFIRMADO por leitura.
- `#sair` — `POST /api/auth/logout` é fire-and-forget com `.catch(() => {})` (`public/app.js:1743`); falha no servidor é silenciosa. Comentário assume que o local já foi limpo. Risco baixo.
- `#serena-voz-parar` — erro do encerramento engolido com `.catch(() => {})` (`app.js:3110`).
- Checkboxes de `#ficha-etiquetas` (`app.js:742`) — em erro o checkbox **não reverte visualmente**, então a tela passa a mostrar estado diferente do banco.
- `#proposta-busca` — lista escondida silenciosamente em erro (`app.js:2500-2502`).
- `agir()` no inbox grava sempre `'A ação não pôde ser concluída.'` em `#thread-detalhe`, sem repassar `erro.detalhe` — perde a razão real da falha.
- **Arquivos que mudam:** `public/app.js`.

---

### P2-7 — `#serena-voz-iniciar` sem guarda contra clique duplo antes da 1ª resposta

- **Status:** CONFIRMADO por leitura.
- **Evidência:** `public/app.js:3094` desabilita o botão de iniciar, mas não há flag "ocupado" equivalente ao `testeOcupado` do laboratório — não há guarda contra clique duplo **antes** da resposta da primeira chamada a `POST /api/serena/voz/sessoes`.
- **Arquivos que mudam:** `public/app.js`.

---

### P2-8 — Suíte de teste flaky sob paralelismo

- **Status:** relatado no baseline da sessão, **causa não investigada nesta rodada**. `testes/inbox-http.test.js` passa 31/31 isolado; numa das duas rodadas de hoje falhou quando executado junto com a suíte inteira. Registrado aqui como pendência, sem diagnóstico.
- **Arquivos que mudariam:** `testes/inbox-http.test.js`, `testes/auxiliar.js` (isolamento de porta/estado entre arquivos de teste).

---

## 4. Matriz completa de botões

Metodologia: `public/index.html` (1165 linhas) e `public/app.js` (4211 linhas) lidos por inteiro; cada botão/form do HTML cruzado com os `addEventListener` do JS; "duplo clique" = existe `disabled = true` ou flag de ocupação durante o `await`; "teste" = `grep` em `testes/` por rota ou id. **Nenhum teste executa DOM real** (não há jsdom no projeto) — todo teste de UI é análise estrutural de string.

### Portão de entrada

| Botão / form | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#form-login` "Entrar" | `app.js:1599` | `POST /api/auth/login` | **Não** | `avisarNoPortao`; distingue 2FA faltando/incorreto e conta pendente/recusada | `testes/autenticacao-http.test.js` |
| `.olho[data-olho="login-senha"]` | `app.js:1358` | — (toggle de `type`) | n/a | n/a | não encontrado |
| `[data-portao="recuperar"]` | `app.js:1595` | — (troca de painel) | n/a | n/a | `testes/contas-http.test.js` (rota) |
| `#form-recuperar` "Enviar link" | `app.js:1675` | `POST /api/auth/recuperar` | **Não** | aviso propositalmente idêntico com/sem conta (1689) | `testes/contas-http.test.js` |
| `[data-portao="cadastro"]` | `app.js:1595` | — | n/a | n/a | — |
| `#form-cadastro` "Enviar cadastro" | `app.js:1649` | `POST /api/auth/cadastro` | **Não** | `erro.message` | `testes/contas-http.test.js` |
| `#form-redefinir` "Salvar senha" | `app.js:1695` | `POST /api/auth/redefinir` | **Não** — gatilho de P1-3 | `erro.message` | `testes/contas-http.test.js` |
| `[data-portao="login"]` (3×) | `app.js:1595` | — | n/a | n/a | — |
| `#entrar-google` (hidden por padrão) | `app.js:1719` | `GET /api/auth/google` | n/a (navega) | fallback "não está disponível agora" | não encontrado |

### Menu lateral / topo global

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `nav [data-tela="painel\|conversas\|leads\|agenda\|metricas\|contatos\|serena\|auditoria\|usuarios\|perfil"]` | `app.js:47` | dispara `carregarX()` | n/a | por tela | vários `*-http.test.js` |
| `#parada-emergencia` "⛔ PARAR SERENA" | `app.js:1477` | `POST /api/serena/estado` | **Sim** (1491-1507) | `informar()`, avisa que resposta em voo pode ter saído | `serena-horario-http`, `sincronia-serena` |
| `#sino-botao` | `app.js:1139` | `GET /api/notificacoes` | n/a | "Não foi possível carregar as notificações." | não encontrado |
| `#sair` | `app.js:1743` | `POST /api/auth/logout` (fire-and-forget) | n/a | **silencioso** (P2-6) | `autenticacao-http` |

### Painel "Hoje"

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| "Ver todas" (`index.html:233`) | **NENHUM — P1-4** | — | — | **falha 100% silenciosa** | `botoes-orfaos.test.js:74` dá falso positivo |
| "Agenda" (`index.html:248`) | **NENHUM — P1-4** | — | — | **falha 100% silenciosa** | não encontrado |
| linha da fila de atendimento | `app.js:361` | — (`abrirTela('conversas')`) | n/a | — | — |
| linha da fila de SLA | `app.js:403` | — | n/a | "Não foi possível carregar a fila de SLA." | — |
| "Concluir" (tarefa) | `app.js:439` | `POST /api/tarefas/:id/concluir` | **Não** | `informar()` | — |

### Conversas / Inbox

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#busca-conversas` (debounce 300ms) | `app.js:1203` | `GET /api/conversas?busca=` | n/a | `avisar(lista)` | `inbox-http` |
| `#filtro-data-conversas` | `app.js:1224` | idem | n/a | idem | `inbox-http` |
| `#limpar-data-conversas` | `app.js:1228` | idem | n/a | idem | — |
| `#ordenar-conversas` | `app.js:1211` | `GET /api/conversas?ordenacao=` | n/a | idem | — |
| `.aba[data-fila]` | `app.js:1190` | `GET /api/conversas?fila=` | n/a | idem | `inbox-http` |
| linha `<li data-conversa>` (click + Enter/Espaço) | `app.js:516-520` | `GET /api/conversas/:id` + `/mensagens` | n/a | "Não foi possível abrir" (577-578) | `inbox-http` |
| `#thread-nome` (histórico) | `app.js:1290` | `GET /api/contatos/:id/conversas` | n/a | "Não foi possível carregar o histórico." | — |
| `#fechar-historico` | `app.js:1291` | — | n/a | n/a | — |
| `[data-acao="assumir"]` | `app.js:1254-1280` | `POST /api/conversas/:id/assumir` | **Sim** (1271-1278) | genérico, perde `erro.detalhe` (P2-6) | `inbox-http`, `e2e-fluxo-critico` |
| `[data-acao="liberar"]` | `app.js:1257` | idem `{liberar:true}` | **Sim** | idem | idem |
| `[data-acao="resolver"]` / `[data-acao="reabrir"]` | idem | `POST /api/conversas/:id/estado` | **Sim** | idem | idem |
| `#seletor-prioridade` | `app.js:1282` | `POST /api/conversas/:id/prioridade` | n/a | idem | — |
| `#seletor-temperatura` | `app.js:1286` | `POST /api/conversas/:id/temperatura` | n/a | idem | — |
| `#form-resposta` "Enviar" | `app.js:1235` | `POST /api/conversas/:id/mensagens` | **Não** | idem | `inbox-http` |
| `#botao-nota` | `app.js:1245` | `POST /api/conversas/:id/notas` | **Não** | idem | — |
| checkboxes `#ficha-etiquetas` | `app.js:742` | `POST /api/conversas/:id/etiquetas` | n/a | **não reverte visualmente** (P2-6) | — |
| `#editar-ficha` / `#cancelar-ficha` | `app.js:1301` / `1318` | — | n/a | n/a | — |
| `#form-ficha` "Salvar" | `app.js:1320` | `PUT /api/conversas/:id/ficha` | **Não** | "Não foi possível salvar a ficha." | `contatos-http` |
| "Marcar horário" (na ficha) | `app.js:2732` | — (navega para Agenda) | n/a | n/a | — |

### Leads (kanban)

| Elemento | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| card do lead (clique) | `app.js:867-871` | `abrirConversa` | n/a | se sem `conversa_id`, vem `disabled` (873) — correto | leads/`inbox-http` |
| drag-and-drop entre colunas | `app.js:902-907` → `moverLead` (4178) | `POST /api/leads/:id/estagio` | compara estágio antes de chamar (4182) | `informar()` + recarrega o kanban para não deixar card fora do estado real | — |

### Agenda

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#agenda-profissional` | `app.js:2752` | `GET /api/agenda` | n/a | anexa "não foi possível carregar" ao período | — |
| `#semana-anterior` / `#semana-hoje` / `#semana-proxima` | `2757` / `2762` / `2767` | idem | n/a | idem | — |
| vaga clicável na grade | `app.js:2322` | — (abre modal) | n/a | n/a | — |
| `#forma-proposta` "Revisar" | `app.js:2772` → `pedirProposta` (2506) | `POST /api/agenda/propor` | **Não** (mitigado pelo fluxo em 2 passos) | `explicarErroDeAgenda`, trata 409/403 | `e2e-fluxo-critico` |
| `#proposta-confirmar` "Confirmar e gravar" | `app.js:2773` → `confirmarProposta` (2541) | `POST /api/agenda/confirmar` | **Sim** (2543, `finally`) | trata 409 (2578) | idem |
| `#proposta-voltar` / `#proposta-cancelar` / `#fechar-proposta` | `2780` / `2774` / `2775` | — | n/a | n/a | — |
| `#proposta-busca` (debounce 250ms) | `app.js:2788` | `GET /api/contatos?busca=` | n/a | **silencioso** (2500-2502) | — |
| bloco de compromisso (clique) | `app.js:2380` | — (abre modal) | n/a | n/a | — |
| "Marcar confirmado" / "Compareceu" / "Faltou" | `2630-2633` → `mudarStatus` (2655) | `POST /api/agenda/:id/status` | **Não** | `#compromisso-erro` | — |
| "Cancelar compromisso" | `2647-2651` → `cancelarCompromisso` (2668) | `POST /api/agenda/:id/cancelar` | **Não** | idem | — |
| "Ver conversa" | `app.js:2635` | — (navega) | n/a | n/a | — |
| `#fechar-compromisso` | `app.js:2776` | — | n/a | n/a | — |
| **"Salvar agenda"** | **não encontrado** — o rótulo não existe. O mais próximo é "Salvar horário" (`#horario-salvar`), que grava a grade da Serena, não a agenda de compromissos. Na agenda, gravar é sempre "Revisar" → "Confirmar e gravar". | | | | |

### Métricas / IA

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#metricas-aplicar` | `app.js:1041` | `GET /api/metricas/resumo?de=&ate=` | n/a | "Período inválido" (400) ou genérico | métricas |
| `#ia-provedor` | `app.js:1063` | — (client-only) | n/a | n/a | — |
| `#ia-gerar-relatorio` | `app.js:1079` | `POST /api/ia/relatorio` | **Não** (só troca texto do `<pre>`) | no `<pre>`; distingue fallback determinístico | — |
| `#assistente-aba` | sem listener dedicado (lido no clique, 1117) | — | n/a | n/a | — |
| `#assistente-perguntar` | `app.js:1107` | `POST /api/ia/assistente` | **Não** | no `<pre>`; distingue 503 | — |

### Serena

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#canal-conectar` | `app.js:3907` → `conectarWhatsapp` (3883) | `POST /api/serena/canal/qr` (poll 5s) | contador `aberturaDoQr` (3645/3757/3869) — equivalente e correto | `mostrarInstrucaoDeVinculo` (3800) | `serena-canal-http`, `canal-evolution-editor` |
| `#qr-fechar` | `app.js:3908` | — (não avisa o servidor, comentário 3878-3881) | n/a | n/a | — |
| `#serena-ligar` | `app.js:3267` | `POST /api/serena/estado {ativa:true}` | **Sim** (3127-3155) | `informar()` | `serena-horario-http`, `sincronia-serena` |
| `#serena-desligar` | `app.js:3268` | `POST /api/serena/estado {ativa:false, motivo}` | **Sim** | idem | idem |
| `#diagnostico-verificar` | `app.js:4169` → `varrerSistema` | `GET /api/diagnostico` | **Sim** (4125-4165) | "não foi possível verificar" | `diagnostico-http`, `serena-http` |
| `#teste-modelo` | `app.js:4095` | — (reinicia sessão local) | n/a | `informar()` | `serena-http` |
| `#teste-reiniciar` | `app.js:4034` | — | n/a | n/a | `botoes-orfaos.test.js:49` |
| `#teste-form` | `app.js:4027` → `enviarNoTeste` | `POST /api/serena/teste` + `/mensagem` + poll | **Sim** (flag `testeOcupado`, 3990-3991) | trata timeout ("não respondeu a tempo") | `serena-http` |
| `#serena-voz-consentimento` | `app.js:3117` | — | n/a | n/a | — |
| `#serena-voz-iniciar` | `app.js:3118` → `iniciarVoz` | `POST /api/serena/voz/sessoes` + WS | **Parcial** — P2-7 | `detalhe.textContent` | não encontrado |
| `#serena-voz-parar` | `app.js:3119` → `pararVoz` | `POST /api/serena/voz/sessoes/:id/encerrar` | n/a | **silencioso** (3110) — P2-6 | — |
| `#serena-pausar` | `app.js:3916` → `mexerNoAtendimento` | `POST /api/serena/pausa {minutos:15}` | **Sim** (3609-3632) | `informar(erro.detalhe)` | `serena-horario-http` |
| `#serena-despausar` | `app.js:3919` | `DELETE /api/serena/pausa` | **Sim** | idem | idem |
| `#serena-plantao` | `app.js:3922` | `POST /api/serena/plantao {minutos:60}` | **Sim** | idem | idem |
| `#horario-salvar` "Salvar horário" | `app.js:3913` → `salvarHorario` | `PUT /api/serena/horario` | **Não** | `#horario-aviso` | `horario-grade-editor` (estrutural), `serena-horario-http` (rota) |
| `.horario-adicionar` / `.horario-remover` | `3914` / `3915` | — | n/a | n/a | `horario-grade-editor` |
| `#serena-novo-prompt` / `#serena-cancelar-editor` | `3269` / `3270` | — | n/a | n/a | — |
| `#form-prompt` | `app.js:3326` | `POST`/`PUT /api/serena/prompts` | **Não** | `informar()` | — |
| `[data-publicar-prompt]` | `app.js:3274` | `POST /api/serena/prompts/:id/publicar` | **Não** | catch geral (3318) | — |
| `[data-editar-prompt]` | `app.js:3279` | `GET /api/serena/prompts` | n/a | idem | — |
| `#serena-nova-regra` / `#serena-cancelar-regra` | `3271` / `3272` | — | n/a | n/a | — |
| `#form-regra` | `app.js:3351` | `POST`/`PUT /api/serena/regras` | **Não** | `informar()` | — |
| `[data-regra-ativa]` | `app.js:3284` | `POST /api/serena/regras/:id/ativa` | **Não** | catch geral | — |
| `[data-editar-regra]` | `app.js:3288` | — (usa `serenaPainel` em memória) | n/a | n/a | — |
| `[data-remover-regra]` | `app.js:3292` | `DELETE /api/serena/regras/:id` (com `confirm()`) | **Não** | catch geral | — |

### Contatos

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#contato-novo` / `#contato-cancelar` | `3299` / `3300` | — | n/a | n/a | `contatos-http` |
| `#form-contato` | `app.js:3377` | `POST`/`PUT /api/contatos` | **Não** | `informar()` | `contatos-http` |
| `[data-ver-contato]` | `app.js:3301` | `GET /api/contatos/:id` | n/a | `informar()` | — |
| `[data-editar-contato]` | `app.js:3302` | `GET /api/contatos/:id` | n/a | catch geral | — |
| `[data-excluir-contato]` (prompt+confirm) | `app.js:3306` | `DELETE /api/contatos/:id` (soft-delete) | **Não** | catch geral | `contatos-http` |
| `[data-restaurar-contato]` | `app.js:3313` | `POST /api/contatos/:id/restaurar` | **Não** | catch geral | `contatos-http` |
| `#contatos-busca` / `#contatos-excluidos` | `3404-3407` | `GET /api/contatos/gestao` | n/a | `informar()` | `contatos-http` |

### Auditoria / Usuários / Perfil

| Botão | Handler | Endpoint | Duplo clique | Erro | Teste |
|---|---|---|---|---|---|
| `#auditoria-mais` | `app.js:122` | `GET /api/auditoria?cursor=` | n/a | `#auditoria-resumo` | `auditoria.test.js` |
| `#abrir-novo-usuario` / `#cancelar-novo-usuario` | `1912` / `1918` | — | n/a | n/a | `perfis.test.js` |
| `#form-novo-usuario` | `app.js:1922` | `POST /api/usuarios` | **Não** | `#resumo-usuarios` | — |
| select de papel (por usuário) | `app.js:1847` | `POST /api/usuarios/:id/papel` | n/a | `#resumo-usuarios` | — |
| "Liberar"/"Recusar"/"Desativar" | `app.js:1861` | `POST /api/usuarios/:id/situacao` | **Não** | idem | — |
| `#ativar-2fa` | `app.js:2040` | `POST /api/auth/segundo-fator` | **Não** | `#retorno-2fa` | — |
| `#form-confirmar-2fa` | `app.js:2051` | `POST /api/auth/segundo-fator/confirmar` | **Não** | idem | — |
| `#desativar-2fa` | `app.js:2067` | `POST /api/auth/segundo-fator/desativar` | **Não** | trata 401 (senha incorreta) distinto | — |
| `#form-perfil` | `app.js:1992` | `PUT /api/perfil` | **Não** | `#retorno-senha` | — |
| `#form-trocar-senha` | `app.js:2012` | `POST /api/auth/senha` | **Não** | trata 401 distinto | — |

**Botões órfãos antigos — REFUTADO / fechado:** "Nova tarefa", "Novo lead" e "Nova conversa" **do cabeçalho de Conversas** já foram removidos do HTML. Achado antigo encerrado, coberto por `testes/botoes-orfaos.test.js`.
> **[CORREÇÃO DA REVISÃO]** A justificativa original — "grep: nenhuma das três strings aparece" — é **falsa**: `Nova conversa` aparece em `public/index.html:739`, como rótulo do botão legítimo `id="teste-reiniciar"` do laboratório da Serena. Isso contradiz a própria tabela "Serena" deste documento, que lista `#teste-reiniciar` com handler em `app.js:4034`. O teste real (`testes/botoes-orfaos.test.js:38-51`) sabe disso e faz a coisa certa: recorta o bloco do cabeçalho de Conversas antes de checar, e ainda exige que o botão do laboratório continue existindo. A conclusão substantiva (os órfãos do cabeçalho sumiram) permanece correta; só a evidência citada estava errada.

---

## 5. Auditoria do banco: schema local × migrations × banco real

**Método:** 34 arquivos em `db/*.sql` lidos (001 a 032, incluindo os três rollbacks e `verificar.sql`); schema esperado reconstruído; comparado objeto a objeto contra o catálogo real de `umvpwqqjzpxwuxdnnxzy` via `information_schema` / `pg_catalog`. Conexão: `current_user = crmclinica_app`, `rolbypassrls = false`, porta 5432 (session pooler) — a conexão usada respeita RLS e não é dona do banco. **A contagem de 34 arquivos foi reconferida pela revisão independente: confere.**

> **[REVISÃO — SEM PROVA REPRODUZÍVEL]** Toda esta seção 5 depende de consultas ao catálogo de produção que **o revisor independente não conseguiu reexecutar** (sem credencial de banco no ambiente; o MCP do Supabase responde `You do not have permission`). Nenhuma saída dessas consultas foi salva como artefato no repositório. Portanto os números **53 policies `crm008_*`**, **10 policies `restrict_*`**, **3 funções SECURITY DEFINER**, **40 tabelas com `rowsecurity = true`** e **zero GRANTs para `anon`/`authenticated`** são de **fonte única** e não foram confirmados por um segundo auditor. O `53` tem corroboração parcial em `docs/ENTREGA-SERENA-LEADS-IA.md:99` (2026-08-08), mas é a mesma linhagem de investigação, não uma verificação independente. Antes de qualquer migration de reconciliação (Commit 20 do plano), **rode `node ferramentas/extrair-definicoes-008.js > extracao.json` e versione a saída** — o inventário precisa virar artefato, não memória de sessão.

### 5.1 O que bate exatamente — CONFIRMADO

Todas as **40 tabelas** esperadas existem em produção, todas com `rowsecurity = true`. Nenhuma tabela, coluna, constraint ou índice descrito pelas migrations locais está **faltando** no banco real.

| Objeto | Definição local | Real | Veredito |
|---|---|---|---|
| `mensagens_conversa_id_fkey` | `db/001_inbox.sql:74` — `conversa_id bigint NOT NULL REFERENCES conversas(id) ON DELETE CASCADE` | idêntico, mesmo nome | CONFIRMADO |
| `mensagens_id_externo_uk` | `db/001_inbox.sql:91` — único parcial `WHERE id_externo IS NOT NULL` | idêntico | CONFIRMADO |
| `automacao_outbox.chave_idempotencia` | `db/031_automacao_outbox.sql:56` — UNIQUE | `automacao_outbox_chave_idempotencia_key` | CONFIRMADO |
| `automacao_outbox_fila_idx` + FKs | `db/031_automacao_outbox.sql:91-93`, `47`, `51` | idêntico, inclusive `ON DELETE CASCADE`/`SET NULL` | CONFIRMADO |
| `conversa_etiquetas.conversa_id` FK | `db/001_inbox.sql:107`, **sem `DEFERRABLE`** | presente | CONFIRMADO (é o que quebra em P0-2) |
| Índices parciais de fila | `lembretes_fila_idx` (`estado='pendente'`), `google_outbox_pendentes_idx` (`estado='pendente'`) | idênticos | CONFIRMADO |
| Índices de segurança/sessão | `tentativas_ip_idx`, `tentativas_conta_idx`, `sessoes_vivas_idx`, `recuperacoes_vivas_idx` | idênticos | CONFIRMADO |
| Unicidades de negócio | `contatos_telefone_uk`, `usuarios_email_uk`, `usuarios_cpf_busca_uk`, `termos_vigente_uk`, `ia_modelos_um_padrao`, `google_sincronia_conflitos_aberto_uk` | idênticos | CONFIRMADO |
| Agenda sem conflito | `agendamentos_sem_conflito` (EXCLUDE GIST) | presente | CONFIRMADO |
| Colunas da 032 | `mensagens.entrega_falhou`, `entrega_falhou_motivo` | presentes, tipo e default batendo | CONFIRMADO |
| `audit_log` | `db/001_inbox.sql:145-153` | idêntico | CONFIRMADO |
| Views `vw_*` | `db/026_analitica.sql` | batem exatamente | CONFIRMADO |
| Exposição `anon`/`authenticated` | REVOKE de `db/007_hardening.sql:287-294` | **zero GRANTs de tabela em todo o `public`** | CONFIRMADO |

### 5.2 Drift real

Ver P1-5 acima para o detalhe. Resumo:

| Objeto no banco real | Existe em `db/*.sql`? | Risco hoje |
|---|---|---|
| 53 policies `crm008_*` | **Não** em `db/*.sql` (grep em `db/`: 0). Fora de `db/`, há inventário em `docs/PLANO-RECONSTRUCAO-008-009.md` e ferramenta em `ferramentas/extrair-definicoes-008.js` | Baixo, mas é o RLS efetivo das tabelas centrais e não está versionado |
| `current_usuario_id()`, `is_admin_master()`, `is_colaborador()` (SECURITY DEFINER, `search_path=''`) | **Não em `db/*.sql`** — `db/018` só faz REVOKE/GRANT. `current_usuario_id()` **tem** definição real em `docs/PLANO-RECONSTRUCAO-008-009.md:63`; as outras duas não aparecem lá (o snapshot de 2026-08-08 traz `is_gestor_or_admin()`/`is_atendente()` — divergência de nomes **não resolvida**) | Baixo; funcionam e são usadas pelas policies |
| 10 policies `restrict_*` para `authenticated` | **Não** | Baixo hoje (código morto: `authenticated` sem GRANT de tabela); indefinido se alguém der GRANT |
| View `v_metricas_uso_usuarios_dia` | **Não** | Baixo (metadados de auditoria, grant só a `crmclinica_app`) |
| Ledger `supabase_migrations.schema_migrations` | inacessível (`permission denied` para `crmclinica_app`) | — |

### 5.3 Fora do escopo desta rodada

`storage.objects` / `storage.buckets` (risco de TRUNCATE documentado em `db/007_hardening.sql:25-57`) não foi verificado — `crmclinica_app` provavelmente nem alcança o schema `storage`. `search_path` de todas as funções foi checado apenas para as três citadas acima.

---

## 6. Riscos

| # | Risco | Probabilidade | Impacto | Sustentação |
|---|---|---|---|---|
| R1 | Primeira mensagem de contato novo pelo WhatsApp resulta em HTTP 500 e não entra no CRM | Alta (todo contato novo) | Alto — perda de lead na porta de entrada | P0-1 + **P0-2** |
| R2 | Corrigir só P0-1 e considerar resolvido | Alta se o plano não for seguido | Alto — o 500 apenas muda de linha | P0-2 |
| R3 | Atendente não vê mensagem do paciente na conversa aberta | Média-alta em produção Vercel | Médio-alto — paciente esperando sem ninguém saber | P1-1 (reproduzido) |
| R4 | Navegador exibe mensagem que sofreu ROLLBACK | Baixa (exige falha depois da emissão na mesma transação) | Médio — dado fantasma na tela | P1-2 (ordem confirmada, efeito hipotético) |
| R5 | Senha redefinida duas vezes em corrida, com a última sobrescrevendo | Baixa | Médio | P1-3 (hipótese) + P2-1 (gatilho confirmado) |
| R6 | Alguém dá `GRANT ... TO authenticated` sem saber das policies `restrict_*` | Baixa | Alto se ocorrer — exposição de `mensagens`/`usuarios` a papel de cliente | P1-5(b) |
| R7 | Restaurar o banco a partir só de `db/*.sql` produz um schema com RLS diferente do de hoje | Média se ocorrer restauração | Alto | P1-5(a) |
| R8 | Investigar incidente e não conseguir cruzar `audit_log` com a requisição HTTP | Média | Médio | P1-6 |
| R9 | Botão morto reportado pelo Edson como "sistema quebrado" | Já ocorre hoje | Baixo funcional, alto de confiança | P1-4 |
| R10 | Duplicidade de envio pela Evolution após lease expirado | Baixa (LEASE_MS 5 min dá folga) | Médio — paciente recebe duas vezes | P2-4 |
| R11 | Enumeração de conta por tempo de resposta | Nula hoje, média após configurar SMTP | Baixo-médio | P2-3 |

---

## 7. Itens CONFIRMADOS

Com evidência arquivo:linha, e onde indicado, com execução.

**Defeitos:**
1. `registrarMensagem` abre conexão própria dentro da transação do webhook — `src/dados/repositorio.js:545-602`. Reproduzido contra Postgres real em `testes/ingresso-whatsapp-transacao.test.js` (branch `fix/p0-ingresso-whatsapp-transacao`). Corrigido nessa branch, **não mesclado**.
2. `definirEtiquetasDaConversa` tem o mesmo defeito, no mesmo fluxo, sem correção em lugar nenhum — `src/dados/repositorio.js:906-929`, cadeia `http.js:487` → `atendimento.js:145` → `atendimento.js:753-766`. Confirmado por leitura + schema + rastreio (não executado).
3. `definirDisponibilidades` viola o mesmo contrato — `src/dados/repositorio.js:1887-1908`.
4. Existem exatamente 5 `pool.connect()` em `repositorio.js`: 352, 546, 907, 1888, 2211. Busca exaustiva.
5. SSE perde evento na reconexão — reproduzido com servidor real: 0 eventos recuperados após reabrir.
6. SSE não tem cursor: nenhum campo `id:` (`eventos-conversas.js:25-34`), rota não lê `Last-Event-ID` (`http.js:1533-1599`), cliente não envia posição (`app.js:1549`).
7. Não existe polling da thread aberta; só da lista lateral (`app.js:1592`).
8. SSE é emitido antes do COMMIT — `atendimento.js:112` dentro de `comUsuario` (`repositorio.js:347-371`).
9. `eventos-conversas.js:6-10` afirma que a rota não roda em serverless; `api/index.js:1-6`, `vercel.json` e `src/config.js:190-200` provam o contrário.
10. Consumo do token de recuperação é check-then-act — `contas.js:304-339`.
11. Botões `index.html:233` e `:248` fora do `<nav>` (155-176), seletor `nav [data-tela]` em `app.js:47`. Clique não faz nada.
12. `testes/botoes-orfaos.test.js:74` dá falso positivo; nenhum teste do projeto executa DOM (sem jsdom).
13. Nenhum formulário de autenticação/CRUD desabilita botão durante o `fetch`; o padrão existe e foi aplicado só a ações "sensíveis".
14. `trocarSenha` e `desativarSegundoFator` não chamam o limitador — `contas.js:153-192` e `:391-411`.
15. Canal timing na recuperação — `contas.js:278` + `email.js:54-127`; hoje inerte por SMTP desconfigurado.
16. Evolution **recebe e descarta** a `chave` — `canal-conversas.js:80` passa, `evolution-envio.js:28` desestrutura só `{telefone, texto}`; OpenClaw usa de verdade — `canal-conversas.js:41-50`. **[CORREÇÃO DA REVISÃO — antes dizia "nem recebe o parâmetro"].**
17. Webhook sem nonce/timestamp na assinatura.
18. `audit_log` sem `origem` nem `correlation_id`; `request_id` existe (`http.js:1373`) mas não chega a `registrarAuditoria`.
19. Drift: 53 policies `crm008_*`, 3 funções SECURITY DEFINER, 10 policies `restrict_*`, view `v_metricas_uso_usuarios_dia` — todos em produção, nenhum em `db/*.sql`. **[REBAIXADO PELA REVISÃO para "sem prova reproduzível"]**: as contagens vêm de consultas de catálogo que não puderam ser reexecutadas por um segundo auditor e não foram salvas como artefato. Além disso, a parte 008/009 **já estava documentada** fora de `db/` (ver correção na seção 3, P1-5).
20. Falhas silenciosas de UI: logout, encerrar voz, checkbox de etiqueta, autocomplete de paciente, `agir()` perdendo `erro.detalhe`.
21. Ferramental ausente: sem lint, sem typecheck, sem build, sem script de e2e/integração isolado, sem audit de dependência. `npm run verificar` é 111× `node --check`.
22. Arquivo-lixo `res.write('` na raiz do repositório (não rastreado) — armadilha de hooks documentada em `CLAUDE.md`.

**Comportamentos corretos que foram verificados e devem ser preservados:**
23. **Barreira final funciona.** `podeEntregarAgora` (`atendimento.js:612-630`) relê a conversa do banco (`obterConversa`, 615) imediatamente antes de `canal.enviar`, chamada em `atendimento.js:646` dentro de `if (origem === 'serena')` (645). Fail-closed: falha na releitura devolve `{permitido:false, motivo:'falha_ao_reler_controle'}` (616-618, 627-629). Quando bloqueia: audita `envio_abortado_por_controle` (651-656), marca `marcarEntregaFalhou` (663-667, método em `repositorio.js:609-615`), reescalona se o motivo não for decisão humana recente (674-678), e **`canal.enviar` nunca é chamado** (680-682). Resposta de humano (`origem:'equipe'`, default em `responderComoEquipe`, 565) não passa pela barreira — decisão de design correta e documentada (640-644).
24. **A barreira vale igual no worker.** `automacao-outbox-servico.js:14-19` documenta e o código confirma: o worker delega inteiramente a `atendimento.responderSePossivel`; não há segundo caminho de envio.
25. **Serena sem cache.** `serena-servico.js:155-164` relê a configuração a cada `podeResponder`; comentário 12-15 explica por quê.
26. **Desligar exige motivo**, ligar não; ambos auditados com estado anterior/novo (`serena-servico.js:50-70`). Pausa e plantão são mutuamente exclusivos e limpam um ao outro (109-121, 137-147), com teto de 24h (76-84).
27. **Lease do worker está correto.** `reivindicarTrabalhosDeOutbox` usa `FOR UPDATE SKIP LOCKED` numa instrução única que já marca `processando` (`repositorio.js:2605-2622`). `LEASE_MS = 5min` (`automacao-outbox.js:56`). O achado N-9 (lease por lote) **está corrigido**: renovação por trabalho individual (`automacao-outbox-servico.js:200-210`) com fencing `WHERE status='processando' AND reivindicado_por=$worker` (`repositorio.js:2652-2661`).
28. **Retry/dead-letter existem.** Backoff exponencial com teto (`automacao-outbox.js:16-18, 68-72`); esgotado vira `morto` com escalonamento humano (`automacao-outbox-servico.js:148-152`); presos voltam à fila ou viram `morto` contando a tentativa (`repositorio.js:2697-2718`).
29. **Entrega indeterminada nunca é retentada.** Timeout/abort marca `erro.indeterminado` (`evolution-envio.js:52-62`, só `TimeoutError`/`AbortError`; recusa de conexão e DNS seguem retentáveis) → `entregaIncerta` (`atendimento.js:451`) → `'incerto'` (`automacao-outbox.js:115-117`) → status terminal, não selecionado por `reivindicar` nem por `liberarTrabalhosPresos`. Equipe já escalonada antes de retornar (`atendimento.js:443`).
30. **Idempotência de entrada em duas camadas:** aplicação (`eventos_recebidos` com `ON CONFLICT DO NOTHING` e tratamento de corrida, `repositorio.js:1475-1485`) e banco (`mensagens_id_externo_uk`, `db/001_inbox.sql:91`).
31. **Webhook autenticado antes de qualquer parse.** HMAC do corpo bruto com `timingSafeEqual` (`openclaw.js:54-60`) checado antes de `JSON.parse` (`http.js:361-374`); token da Evolution também em tempo constante (`http.js:507-514`); em produção sem segredo, 503 em vez de aceitar (`http.js:381-384`).
32. **Recuperação de senha, partes corretas:** token de 256 bits (`contas.js:266`), só o hash persistido (`contas.js:18-20, 272`; `db/003_contas.sql:54` — coluna `hash_token text NOT NULL UNIQUE`, não existe coluna para token em claro), expiração de 1h (`contas.js:15, 312`), uso único checado e marcado (312, 327), token removido do histórico do navegador (`app.js:2097`), token nunca logado (único log de e-mail é `email.js:135,144-145,155-156`, com destinatário e assunto, nunca `mensagem.texto`), sessões revogadas **só depois** do sucesso (`contas.js:329`), resposta idêntica para conta existente e inexistente (provado por teste real: `testes/contas-http.test.js:257-267`, `deepEqual`), rate limit em ambas as pontas (`limite.js:26-35`: recuperação 3/h por conta + 10/h por IP; redefinição 10/h por conta + **20/h por IP** — na prática só o de IP vale, porque a rota não recebe e-mail, `rotas-autenticacao.js:237-242`. **[CORREÇÃO DA REVISÃO]** o texto original dizia "redefinição 10/h — na prática só por IP", misturando o teto de conta com o de IP; o teto que efetivamente se aplica é **20/h por IP**, `limite.js:34`), limitador chamado **antes** de checar existência da conta (`contas.js:260-261`) para não virar oráculo.
33. **SMTP ausente não quebra login.** `opcoesDeEntrada` (`rotas-autenticacao.js:89-95`) calcula `recuperacao_por_email` e o front esconde o botão (`app.js:1736-1737`); `entrar()` (`sessoes.js:85-164`) não referencia `email.js` em ponto nenhum.
34. **JWT correto.** HS256 próprio; algoritmo nunca lido do token (`jwt.js:52-53`, evita `alg:none`); assinatura comparada em tempo constante (57); expiração checada (69-71).
35. **Refresh token:** opaco, 256 bits, só SHA-256 persistido (`sessoes.js:19-21, 50-59`), rotacionado a cada uso (205, revoga o antigo antes de abrir o novo).
36. **Gate de 2FA na ordem certa:** `p2f` marcado no token para master/admin sem TOTP (`sessoes.js:39-42`); bloqueio em `http.js:1444-1450`, **antes** de `tratarRotasDeAutenticacao` (1611).
37. **RBAC:** matriz explícita por papel, sem herança, papel desconhecido nega por padrão (`rbac.js:51-55`).
38. **Anti-timing no login:** `hashDeReferencia = usuario?.senha_hash ?? '$scrypt$16384$8$1$00$00'` (`sessoes.js:93-94`) — hash sempre conferido, mesmo sem usuário.
39. **Sem GRANT algum para `anon`/`authenticated`** em todo o `public` (varredura completa).

---

## 8. Hipóteses NÃO confirmadas

Registradas como hipóteses porque nenhum auditor trouxe evidência de execução. **Não devem ser tratadas como fato.**

| # | Hipótese | Por que não foi confirmada |
|---|---|---|
| H1 | Duas requisições concorrentes a `/api/auth/redefinir` com o mesmo token ambas trocam a senha | Deduzida do código (`contas.js:304-339`), mas não existe teste de concorrência contra Postgres para esse fluxo; o teste existente roda em `repositorio-memoria`, single-thread |
| H2 | O navegador chega a exibir mensagem que sofreu ROLLBACK | A **ordem** (emissão antes do COMMIT) está confirmada; ninguém fabricou uma falha no meio da transação para observar o efeito |
| H3 | Perda de evento SSE entre **duas instâncias Vercel concorrentes** | Consequência necessária da arquitetura (emitter em memória + serverless), confirmada por leitura de código e config; **não reproduzida** contra 2 lambdas reais. A perda **dentro de uma instância** essa sim foi reproduzida |
| H4 | `definirDisponibilidades` quebra hoje em algum fluxo real | Nenhum auditor encontrou caminho que crie profissional e defina disponibilidade na mesma transação |
| H5 | Duplo clique nos formulários sem guarda produz duplicidade de dado observável | A ausência da guarda está confirmada; o efeito por formulário não foi reproduzido |
| H6 | Migrations 008 e 009 constam no ledger `supabase_migrations.schema_migrations` | `permission denied` para `crmclinica_app`; só há evidência **indireta** (as 53 policies `crm008_*` e as 3 funções existem) |
| H7 | Toda troca de `serena_configuracao` também grava linha em `audit_log` | Verificou-se que `alterado_por`/`alterado_em` são gravados como colunas próprias (`repositorio.js:2100-2103, 2122-2127`); a cobertura de `audit_log` em `src/servidor/rotas-serena.js` não foi perseguida até o fim |
| H8 | Algum script em `bin/*.js` escreve em `mensagens`/`conversas`/`serena_configuracao` por fora de `registrarAuditoria` | 9 scripts identificados com acesso direto ao banco (`worker-outbox.js`, `worker-heartbeat.js`, `worker-lembretes.js`, `worker-google-outbox.js`, `verificar-banco.js`, `semear-serena.js`, `lembretes.js`, `preparar-conexao-app.js`, `criar-admin.js`); **nenhum foi aberto** nesta rodada |
| H9 | Causa do flaky de `testes/inbox-http.test.js` sob paralelismo | Não investigada |
| H10 | `storage.objects`/`storage.buckets` seguem protegidos conforme `db/007_hardening.sql:25-57` | Não verificado nesta rodada |
| H11 | O impacto real de P0-2 em produção é exatamente HTTP 500 | A violação de FK está confirmada por leitura + schema; não foi executada contra Postgres |

---

## 9. REFUTADO

Preocupações investigadas com evidência e que **não** se sustentam.

| Preocupação | Veredito | Evidência |
|---|---|---|
| SQL injection | REFUTADO | 18 template literals em SQL, todos interpolando **nome de coluna** vindo de lista fixa no código (`repositorio.js:512, 524, 844, 1015, 1647, 2034, 2258-2261, 2275, 2489, 2685`; `repositorio-clinica.js:183, 189`; `pool.js:36, 43, 79`). Valor sempre `$N`. Nenhum ponto onde entrada HTTP alcança SQL bruto |
| XSS refletido por nome/mensagem | REFUTADO | Conteúdo de mensagem sempre por `textContent` (`app.js:592, 607, 651, 665, 721-723, 842-863`); onde há `innerHTML` com dado do backend, usa `escapar()` (`app.js:2918, 2947-2948, 3208, 4144, 3818`). Ressalva não-explorável: `app.js:3209` interpola `contato.telefone` sem `escapar()`, mas o valor é normalizado e validado por `telefoneValido()` antes de gravar (`rotas-contatos.js:131-134, 185-188`) — só dígitos passam |
| CSRF | REFUTADO por desenho | Nenhum `cookie`/`Set-Cookie`/`document.cookie` em `src/` ou `public/app.js`. Auth 100% Bearer: access token em memória, refresh em `sessionStorage` (`app.js:127-163`), enviado no corpo (`rotas-autenticacao.js:107`) e no header (`sessoes.js:226-230`). O navegador não anexa credencial automaticamente |
| Enumeração de usuário em login/cadastro/recuperação (corpo e status) | REFUTADO | Login: mesmo `Error('credenciais inválidas')` 401 (`sessoes.js:108-110`). Cadastro: mesmo objeto e mesmo 200 nos dois ramos (`rotas-autenticacao.js:128-151`; `/api/auth/cadastro` não está na lista de 201 em `http.js:580`). Recuperação: `deepEqual` provado por teste (`contas-http.test.js:257-267`). *O canal de **timing** é achado separado — P2-3* |
| Senha/token/secret em log | REFUTADO | Nenhuma ocorrência em `src/`. Log de acesso registra só rota/método/status/duração/request_id (`http.js:1376-1382`, comentário explícito). `pool.js:6` documenta que a connection string nunca é impressa |
| Segredo JWT fraco ou default em produção | REFUTADO | `config.js:257, 393-396` exige `CRMCLINICA_JWT_SECRET` com ≥32 caracteres em produção; `segredoEfemero()` só fora de produção |
| Open-redirect no link de recuperação | REFUTADO / não aplicável | Não existe parâmetro de redirect. O link é montado no servidor a partir de config fixa: `contas.js:277` — `${configuracao.autenticacao.urlPublica}/?recuperar=${token}`, com `urlPublica` validada em `config.js:260` por `urlValida(ambiente.CRMCLINICA_URL_PUBLICA)`, nunca de header `Host` nem de input |
| Serena continua respondendo depois de "Assumir" / "PARAR" | REFUTADO | Barreira final revalidada, fail-closed, compartilhada entre caminho síncrono e worker — ver item 23-24 da seção 7 |
| Botões órfãos "Nova tarefa"/"Novo lead"/"Nova conversa" | REFUTADO — já removidos | Grep: nenhuma das três strings existe no HTML atual |
| Falta de heartbeat no SSE | REFUTADO — existe | `http.js:1562-1571`, ping a cada 25s com `unref()` |
| Falta de dedup de evento SSE no cliente | REFUTADO como problema | O cliente rebusca a thread inteira e redesenha do zero (`app.js:1551-1567`, `583-585`); duplicado gera requisição redundante, não duplicação visual |
| A separação "dentro/fora de transação" no dispatcher é inconsistência acidental | REFUTADO | Cada exceção tem comentário justificando (auth 1601-1610, SSE, webhooks 470-486, laboratório 1637-1642, `/api/resumo` 1479-1489) — é decisão deliberada |

---

## 10. Arquivos que precisariam mudar, por achado

| Achado | Arquivos |
|---|---|
| **P0-1** `registrarMensagem` | `src/dados/repositorio.js`; `testes/ingresso-whatsapp-transacao.test.js` — **já feito** em `fix/p0-ingresso-whatsapp-transacao` (`f1064c0`), falta mesclar |
| **P0-2** `definirEtiquetasDaConversa` | `src/dados/repositorio.js`; `testes/ingresso-whatsapp-transacao.test.js` (estender a reprodução até o fim de `receberMensagem`) |
| **P0-3** `definirDisponibilidades` | `src/dados/repositorio.js`; `testes/contrato-repositorio.test.js` |
| **P1-1** SSE durável | `src/servidor/eventos-conversas.js`; `src/servidor/http.js`; `public/app.js`; nova migration `db/0XX_eventos_conversa.sql` |
| **P1-2** emissão pós-commit | `src/dados/repositorio.js` (fila de efeitos no `comUsuario`); `src/dominio/atendimento.js`; `src/servidor/eventos-conversas.js` |
| **P1-3** token atômico | `src/seguranca/contas.js`; `src/dados/repositorio.js`; `src/dados/repositorio-memoria.js`; `public/app.js`; `testes/contas-http.test.js` + novo teste de concorrência |
| **P1-4** botões mortos | `public/app.js`; `testes/botoes-orfaos.test.js` |
| **P1-5** drift de schema | nova migration aditiva em `db/` (reconciliação de `crm008_*`, funções SECURITY DEFINER, `restrict_*`, `v_metricas_uso_usuarios_dia`); `db/verificar.sql` |
| **P1-6** origem/correlation em auditoria | nova migration em `db/`; `src/dados/repositorio.js`; `src/dados/contexto.js`; `src/servidor/http.js` |
| **P2-1** duplo clique | `public/app.js` |
| **P2-2** rate limit em troca de senha / desativar 2FA | `src/seguranca/contas.js`; `src/seguranca/limite.js` |
| **P2-3** timing na recuperação | `src/seguranca/contas.js` |
| **P2-4** idempotência da Evolution | `src/integracoes/evolution-envio.js`; `src/integracoes/canal-conversas.js` |
| **P2-5** replay do webhook | `src/integracoes/openclaw.js`; `src/servidor/http.js` |
| **P2-6/P2-7** falhas silenciosas e guarda de voz | `public/app.js` |
| **P2-8** flaky | `testes/inbox-http.test.js`; `testes/auxiliar.js` |
| Ferramental ausente | `package.json` (scripts `lint`, `e2e`, `integracao`, `audit`); `.github/workflows/` se houver CI |
| Arquivo-lixo `res.write('` | remoção exige autorização expressa do Edson (CLAUDE.md) |

---

## 11. O que esta auditoria NÃO fez

- Não executou nada contra o banco de produção além de leitura de catálogo e contagens agregadas.
- Não leu `senha_hash`, `totp_segredo_cifrado`, conteúdo de mensagens/conversas/contatos, cookies, tokens, `SMTP_PASS` ou qualquer secret.
- Não fez push, PR, merge, deploy, promote, rollback, restart de serviço, alteração de domínio, alteração de secret/env da Vercel, aplicação de migration, INSERT/UPDATE/DELETE/DDL, envio de mensagem à Evolution, envio de e-mail, nem teste com paciente real.
- Não reativou a Serena (segue `ativa = false`, desligada mais cedo hoje com motivo em `audit_log`, autorizado pelo Edson).
- Não abriu os 9 scripts de `bin/*.js` que acessam o banco diretamente (H8).
- Não verificou `storage.objects`/`storage.buckets` (H10).
- Não investigou o flaky de `testes/inbox-http.test.js` (H9, P2-8).
- Não reproduziu P0-2, P1-2, P1-3 nem H3 contra Postgres/lambdas reais — todos marcados como tal.

---

## 12. Revisão independente (auditor externo, 2026-08-14)

Um revisor que não participou de nenhuma das sete frentes releu os três documentos por inteiro, reabriu cada `arquivo:linha` citado nos achados marcados CONFIRMADO, reexecutou o ferramental e tentou **ativamente refutar** cada achado. Método: leitura direta dos arquivos, `grep`, `git show` da branch do fix, `npm run verificar`, `npm test` completo, e uma reprodução própria do cenário de SSE escrita do zero.

### 12.1 Baseline reexecutado pelo revisor

| Comando | Resultado do revisor | Bate com o documento? |
|---|---|---|
| `npm run verificar` | exit 0; contagem programática de `node --check` = **111** | Sim |
| `npm test` | exit 0; **tests 1091, pass 1091, fail 0, skipped 0** | **Não** — o documento dizia 1092. Corrigido na seção 2.5 |
| `git status --short` | só não rastreados (`.claude/workflows/`, `.claude/worktrees/`, `DOCUMENTO CRM/`, `docs/auditorias/`, `docs/superpowers/…`, `res.write('`, `scripts/`); **nenhum arquivo rastreado modificado** | Sim |
| `git log origin/main..HEAD` | **vazio** | Ver 12.5 |
| Reprodução de SSE (script próprio) | `conexao-1: 4 eventos` → sem ouvinte → `conexao-2 após reconexão: 0 eventos` → `8 mensagens no repositório` | Sim |

**Nenhum teste vermelho foi escondido.** A suíte completa passa (1091/1091) e o documento não omite falha alguma. O flaky de `testes/inbox-http.test.js` (P2-8) **não** reapareceu na rodada do revisor — segue como relato de sessão não reproduzido, e o documento já o rotula assim.

### 12.2 CONFIRMA — achados verificados e mantidos

| Achado | O que o revisor conferiu |
|---|---|
| **P0-1** | `repositorio.js:546` é `pool.connect()` dentro de `registrarMensagem`; `consultar` usa `contexto.atual()?.client ?? pool` (`:273`); `comUsuario` registra o contexto (`:352-384`). Diff de `f1064c0` lido: toca só `src/dados/repositorio.js` e adiciona o teste; o padrão if/else está correto e o "duplicada" realmente não faz `ROLLBACK` sob transação ambiente. A **nota menor** sobre `cliente.query` fora da fila `consultarNoCliente` também confere. Ressalva importante em 12.4 |
| **P0-2** | `repositorio.js:907` idêntico ao defeito de P0-1. Cadeia reconferida linha a linha: `http.js:488` (`comUsuario(null, processarEGravarRecibo)`) → `atendimento.js:145` (`sincronizarTemperatura`, incondicional, **antes** do desvio de `despachoEmSegundoPlano` em 168+) → `atendimento.js:753-766` → `repositorio.js:907`. `leads.js:63` devolve `atividade_recente` e `conversas.js:41-47` nunca devolve array vazio, então o `INSERT` sempre roda. FK em `db/001_inbox.sql:107`, sem `DEFERRABLE`. **A conclusão-chave do documento — mesclar só P0-1 não resolve o 500 — se sustenta.** O impacto exato (HTTP 500) segue hipótese, como o próprio documento diz em H11 |
| **P0-3** | `repositorio.js:1888`. Inventário exaustivo reconferido: exatamente **5** `pool.connect()`, nas linhas **352, 546, 907, 1888, 2211**. `publicarPromptDaSerena` (2197+) realmente já faz o if/else correto |
| **P1-1** | `eventos-conversas.js` inteiro (56 linhas): `Set` de módulo, `publicar` escreve só `data:`, nenhum `id:`. Rota `http.js:1533-1599` só lê `token`, nunca `Last-Event-ID`. Cliente `app.js:1549` sem cursor, `onerror` reabre em 5s. Polling só da lista (`app.js:1592`). Heartbeat existe (25s). Comentário de `eventos-conversas.js:7-10` realmente contradiz `api/index.js:1-4`, `vercel.json` (`/api/:caminho*` → `/api/index`) e `config.js:200`. **Reproduzido de forma independente** |
| **P1-2** | `comUsuario`: `BEGIN` em 354, `acao` em 365-368, `COMMIT` em 370; `atendimento.js:112` publica no meio. Mesmo padrão em 399/515/555/728 |
| **P1-3** | Sequência check-then-act confere (com desvio de 1-2 linhas nas citações, corrigido em linha). `marcarRecuperacaoUsada` é o único `WHERE ... usado_em IS NULL` (`repositorio.js:1846`) e vem **depois** da troca de senha (`:323`) |
| **P1-4** | Botões em `index.html:233` e `:248`; `<nav>` de 155 a 176; `<main>` começa em 188; `app.js:47` usa `nav [data-tela]` e `app.js:27` usa `nav button[data-tela]`. **Confirmado com exatidão.** `botoes-orfaos.test.js:74` de fato só casa string, e o comentário da linha 71 de fato afirma handler que não existe |
| **P1-6** | Colunas de `audit_log` em `db/001_inbox.sql:145-153` conferem; `requestId` nasce em `http.js:1373`, vira header `x-request-id` (`:1375`) e é logado em `:1380` — e não chega a `registrarAuditoria` |
| **P2-1** | Amostragem conferida; o padrão `disabled`/flag existe e foi aplicado seletivamente |
| **P2-2** | `trocarSenha` (`contas.js:153-192`) e `desativarSegundoFator` (`:391-411`) lidos por inteiro: nenhuma chamada ao limitador |
| **P2-3** | Forma do código confere. Premissa "inerte em produção" rebaixada — ver 12.4 |
| **P2-5** | Sem nonce/timestamp na assinatura; idempotência downstream existe como descrito |
| **P2-6 / P2-7** | Confirmados em substância (citações com 1-2 linhas de desvio: o `.catch(()=>{})` do logout, `app.js:742` vs. listener em 744, `2500-2502` vs. 2501-2503) |
| Ferramental (item 21) | `devDependencies: {}`, única dependência `pg`, sem lint/typecheck/build, `verificar` = 111 `node --check`. Confere |
| Lixo `res.write('` (item 22) | Existe na raiz, 0 bytes, não rastreado. Confere |
| Barreira final (itens 23-24) | `podeEntregarAgora` em `atendimento.js:612-630`, chamada em 646 dentro de `if (origem === 'serena')` (645), fail-closed, com auditoria + `marcarEntregaFalhou` + reescalonamento + `return` antes de `canal.enviar`. Confere |
| Refutações de segurança | Sem cookie em `src/`/`public/app.js` (grep vazio); refresh em `sessionStorage` (`app.js:142`); `jwt.js` nunca lê `alg` do token e compara em tempo constante; `sessoes.js:93-94` tem o hash de referência anti-timing. **Todas as refutações amostradas se sustentam** |

### 12.3 REFUTA — afirmações erradas ou exageradas (corrigidas em linha)

| # | Afirmação original | Por que está errada |
|---|---|---|
| R1 | "`npm test` — **1092** testes" (§2.5, e §P2-8) | Nesta branch são **1091**. Os 1092 são da branch `fix/p0-ingresso-whatsapp-transacao`, que adiciona um arquivo cujo teste, sem `CRMCLINICA_TEST_DATABASE_URL`, é um corpo **vazio** que passa |
| R2 | "`grep -r \"crm008\"` no repo: **zero ocorrências**" + "drift **não documentado**" + "nenhum arquivo local contém o `CREATE FUNCTION`" (§1, §P1-5, §5.2) | `crm008` aparece em 6 arquivos rastreados fora de `.claude/`, incluindo `docs/PLANO-RECONSTRUCAO-008-009.md` (plano completo, snapshot real de 2026-08-08, com `CREATE OR REPLACE FUNCTION public.current_usuario_id()` na linha 63), `docs/SEGURANCA.md:234` e a ferramenta versionada `ferramentas/extrair-definicoes-008.js`. O §5 ainda afirma que o grep cruzou "o repositório inteiro (incluindo os worktrees)" — os worktrees são justamente onde há mais ocorrências. O achado é **real mas não novo**, e a evidência citada é falsa |
| R3 | "Botões órfãos … grep: **nenhuma das três strings aparece**" (§4) | `Nova conversa` está em `public/index.html:739` (`id="teste-reiniciar"`, legítimo). Contradiz a própria tabela "Serena" deste documento e o que `testes/botoes-orfaos.test.js:38-51` documenta explicitamente. A conclusão (órfãos do cabeçalho removidos) continua certa; a evidência, não |
| R4 | "A Evolution … **nem recebe o parâmetro `chave`**" (§P2-4, e design §3.2, e plano Commit 11) | `canal-conversas.js:80` já chama `evolucao.enviar({ telefone: destino, texto, chave })`. O adaptador é que descarta (`evolution-envio.js:28`). Metade do Commit 11 já está feita |
| R5 | "redefinição **10/h** — na prática só por IP" (§7 item 32, e design §7) | `limite.js:33-34`: conta 10/h, **IP 20/h**. Como a rota não passa e-mail, o teto que vale é o de **20/h por IP** |

### 12.4 SEM PROVA SUFICIENTE — deveriam ter sido rotulados hipótese

| # | Item | Por quê |
|---|---|---|
| S1 | Todos os números de catálogo da §5 e do P1-5 (53 `crm008_*`, 10 `restrict_*`, 3 funções SECURITY DEFINER, 40 tabelas com RLS, zero GRANT para `anon`/`authenticated`, view `v_metricas_uso_usuarios_dia`) | O revisor **não conseguiu reexecutar nenhuma** dessas consultas (sem credencial no ambiente; MCP do Supabase responde `You do not have permission`) e **nenhuma saída foi salva como artefato no repositório**. São de fonte única. Antes do Commit 20 do plano, gerar e versionar `ferramentas/extrair-definicoes-008.js > extracao.json` |
| S2 | P0-1: "reproduzido contra Postgres real" | `CRMCLINICA_TEST_DATABASE_URL` não está definida; sem ela o teste vira corpo vazio chamado "PULADO", que passa. A execução vermelho→verde é **afirmação do autor do commit**, não artefato reexecutável. O defeito em si segue confirmado por leitura |
| S3 | P2-3: "inerte porque `configuracao.email.host` está vazio **em produção**" | O código prova o condicional; o valor real do env de produção não foi lido por ninguém (está fora do escopo). Plausível, não verificado |
| S4 | P1-1: "perda entre instâncias Vercel — **CONFIRMADA** por leitura de código e config" | Contradiz H3 da §8, que a lista como hipótese. Rebaixado para hipótese, alinhado com H3 |

Contradição menor adicional, já corrigida em linha: as citações de `src/seguranca/contas.js` no P1-3 estão 1-2 linhas deslocadas (a função começa em 306, não 304), embora o conteúdo de cada passo confira.

### 12.5 A declaração "nada em produção mudou" — **SUSTENTA-SE, e é mais forte do que o documento diz**

Verificado pelo revisor:

- `git rev-parse HEAD` = `git rev-parse main` = `git rev-parse origin/main` = **`27c7edb0dc311ac7985fd82bbe46b0c568e12ca4`**. Os três apontam para o mesmo commit.
- `git log origin/main..HEAD --oneline` → **vazio**. `git log HEAD..origin/main --oneline` → **vazio**. A branch `fix/auditoria-integral-crm-sem-deploy` **não tem commit nenhum**; ela apenas aponta para `main`.
- `git status --short` → só arquivos **não rastreados**. Nenhum arquivo rastreado foi modificado. Os próprios três documentos desta auditoria estão não rastreados.
- `main` e `origin/main` não se moveram. A branch `fix/p0-ingresso-whatsapp-transacao` existe localmente com o commit `f1064c0` e **não foi mesclada** em lugar nenhum.

Ou seja: não houve push, PR, merge, deploy, migration aplicada, escrita no banco, nem sequer um commit local nesta branch. A afirmação do cabeçalho ("nenhum arquivo de produção foi alterado, nenhum deploy, nenhuma migration aplicada, nenhuma escrita no banco real") **se sustenta integralmente** no que é verificável por Git e pelo estado do repositório.

Uma ressalva de honestidade, não de contradição: "nenhuma escrita no banco real" cobre esta auditoria, mas **a Serena foi desligada mais cedo hoje na mesma sessão** (`ativa = false`, motivo em `audit_log`, autorizado pelo Edson) — isso é uma escrita em produção, feita **antes** da auditoria e fora dela, e o documento já a menciona na seção 11. Nada nesta revisão a alterou; a Serena continua desligada.

### 12.6 Veredito da revisão

A auditoria é substancialmente sólida: **os quatro achados que mais importam — P0-1, P0-2, P1-1 e P1-4 — resistiram a tentativa ativa de refutação**, e P0-2 (o argumento de que corrigir só P0-1 desloca o erro em vez de resolvê-lo) é o achado mais valioso do documento e está corretamente sustentado. O que precisou de correção foi **evidência, não conclusão**: cinco afirmações de prova estavam erradas (R1-R5) e quatro itens estavam rotulados CONFIRMADO com força maior do que a evidência suporta (S1-S4). O padrão dos erros é reconhecível — `grep` de escopo estreito relatado como escopo largo, e número de teste copiado de outra branch. Nenhum deles muda o plano de ação; todos mudam o quanto se deve confiar em cada linha antes de agir.
