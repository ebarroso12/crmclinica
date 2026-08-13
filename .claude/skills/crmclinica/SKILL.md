---
name: crmclinica-conventions
description: Como trabalhar com segurança no crmclinica — arquitetura real (Vercel + Supabase + VPS), contrato operacional do projeto, armadilhas conhecidas do ambiente, convenções de código/teste/migration, e o fluxo de trabalho para mudanças de risco (isolamento em worktree + auditoria independente). Ative sempre que for tocar código, banco ou infraestrutura deste repositório.
---

# crmclinica — como trabalhar aqui

CRM de clínica médica (Dr. Edson Barroso) com atendimento automatizado por IA
("Serena") via WhatsApp. Node.js (CommonJS) + PostgreSQL/Supabase. Produção
real, pacientes de verdade — trate qualquer mudança de atendimento ou banco
com o peso disso.

## Antes de tudo: o contrato do projeto

`CLAUDE.md` na raiz do repo é vinculante, não decorativo. Resumo do que
importa mais:

- **Correção aditiva.** Nunca reescreva história git publicada (sem
  `rebase`/`amend`/`reset --hard`/force push). Um erro descoberto depois de
  um commit vira um NOVO commit corretivo, nunca uma reescrita do anterior.
- **Automático, sem pedir**: leitura/busca, `git status/diff/log/show/grep`,
  inspecionar GitHub, criar branch `fix/*` a partir da main atual, editar
  dentro dela, criar/atualizar teste, `npm ci`/`npm run verificar`/`npm
  test`, commits temáticos na branch `fix/*`, documentação, PR em modo
  draft.
- **Exige autorização expressa e específica, sempre**: merge na main, push
  direto na main, qualquer `reset`/`rebase`/`amend`/force push/`git clean`,
  migration em produção, `DELETE`/`UPDATE`/`INSERT`/DDL em produção,
  alteração de credencial, religar a Serena, mudar configuração global da
  máquina. "Continue" ou "faça" genérico **não** autoriza isso — se a ação
  cair nessa lista, pergunte explicitamente o que está sendo autorizado.
- **Sem expansão de escopo.** Não misture correção de um problema não
  relacionado no mesmo commit, mesmo achando outro bug pelo caminho —
  registre e resolva depois, à parte.
- Protocolo antes de mexer em código: `git status --short`, `git branch
  --show-current`, `git log -8 --oneline`, confirmar que NÃO está na `main`,
  registrar o commit base, saber exatamente quais arquivos a tarefa toca.
- Protocolo antes de commit: `git diff --check`, `npm run verificar`, `npm
  test`, `git diff --stat`, revisar só os arquivos da tarefa, um assunto por
  commit.

## Arquitetura real (onde cada coisa roda)

Três pernas, cada uma com um papel diferente — não confunda:

1. **Vercel** (`api/index.js` → `src/servidor/http.js`) — é quem recebe de
   verdade o webhook do WhatsApp (`POST /api/canais/whatsapp/eventos`) em
   produção. Serverless: sem estado persistente entre invocações, sem
   garantia de continuar rodando código depois de responder a requisição
   (isso já causou perda silenciosa de mensagem no passado — é por isso que
   existe a outbox durável em vez de `setImmediate`).
2. **Supabase Postgres** — banco de produção. A app conecta como role
   `crmclinica_app`, que **não tem privilégio de DDL** (só
   SELECT/INSERT/UPDATE/DELETE nas tabelas liberadas). Isso é postura de
   segurança correta, não bug — mas significa que **nenhuma migration pode
   ser aplicada por script/app**: só via **SQL Editor do Supabase**, com a
   role `postgres` (admin), que só o Dr. Edson deveria acionar (ou você
   entregando o SQL exato pra ele colar — nunca peça a senha do admin).
   RLS depende de `SET request.jwt.claims` por conexão — só funciona em
   **Session pooler (porta 5432)**; muda pra **Transaction pooler (6543)**
   e RLS quebra silenciosamente. Nunca trocar a porta sem saber disso.
3. **VPS** (`srv905994.hstgr.cloud`, acesso SSH como `root`) — roda os
   workers de fundo como serviços `systemd`, todos compartilhando o mesmo
   checkout de código em `/opt/crmclinica-ponte` (um `git clone` real,
   branch `main`, atualizado com `git pull --ff-only`) e o mesmo
   `/opt/crmclinica-ponte/.env`:
   - `crmclinica-ponte.service` — ponte do plugin OpenClaw (não é o webhook
     de produção; é outra coisa, o hook `before_agent_reply`).
   - `crmclinica-lembretes.service`, `crmclinica-heartbeat.service`,
     `crmclinica-google-outbox.service`, `crmclinica-outbox.service` —
     workers de fila, todos seguindo o mesmo template systemd (ver
     `crmclinica-lembretes.service` como referência de hardening:
     `NoNewPrivileges`, `ProtectSystem=strict`, `Restart=always`, etc).
   - Atualizar o código aqui **não afeta serviços já rodando** (Node
     mantém o código em memória) — só processos novos ou reiniciados pegam
     a versão nova. Reiniciar um serviço já ativo é uma decisão que exige
     autorização separada, mesmo que criar um serviço NOVO não exija.

## Armadilhas conhecidas deste ambiente

- **Hooks do claude-flow criam arquivo-lixo.** Comandos Bash rodam via
  `cmd /c` nesta máquina; um `>` ou `=>` (arrow function) no meio do
  comando vira redirecionamento e cria um arquivo vazio (0 bytes) na raiz
  do repo com nome tipo `{})` ou `app.encerrar())`. Evite `node -e` com
  `=>`; escreva um `.js` em `scripts/tmp/` e rode com `node arquivo.js`.
  Antes de commitar, confira `git status --short` por nomes estranhos de
  0 bytes — são sempre lixo, seguro apagar depois de conferir o tamanho.
- **`scripts/tmp/` é scratch, não versionado.** Scripts de diagnóstico
  ad-hoc (verificação de migration, checagem de fila, etc.) vão lá e ficam
  fora do controle de versão — não têm por que virar parte permanente do
  repo. A ferramenta permanente de verificação de banco é
  `bin/verificar-banco.js` (`npm run verificar-banco`).
- **`DOCUMENTO CRM/`** na raiz são documentos reais do Dr. Edson (auditorias
  externas, docx/pdf) — não confundir com lixo, não tocar sem pedido.
- **`.claude/worktrees/`** é onde vivem os checkouts isolados de agentes em
  background — não apagar enquanto algum agente puder estar usando.

## Convenções de código

- **Português em tudo**: nomes de função, variável, comentário, mensagem de
  commit. Funções fábrica (`criarAtendimento`, `criarServicoDeOutbox`), não
  classes.
- **Comentários explicam o porquê, não o óbvio** — e são honestos sobre
  limitação: é comum encontrar comentário do tipo "isto NÃO prova X, só Y"
  no topo de um arquivo de teste. Mantenha esse padrão ao escrever novo
  código/teste — declarar o que não está coberto é mais valioso que fingir
  cobertura completa.
- Sem framework de classes/DI pesado — repositório (`src/dados/repositorio.js`)
  é o único ponto de acesso a banco; domínio (`src/dominio/`) não conhece
  SQL diretamente.
- `repositorio.comUsuario(usuarioOuNull, async () => {...})` é o mecanismo
  de transação: tudo que precisa ser atômico entra nesse callback. Fora
  dele, cada chamada é sua própria transação implícita.

## Testes

- `npm test` → `node --test testes/**/*.test.js`. `npm run verificar` →
  `node --check` em ~110 arquivos — é só checagem de sintaxe, **não** é
  lint nem typecheck, e sozinho nunca é prova suficiente de nada.
- TDD de verdade: teste vermelho antes da correção (comprovado, não
  assumido — muitas vezes com `git stash` pra rodar o teste novo contra o
  código antigo), verde depois.
- **Testes de concorrência contra mock em memória não provam concorrência
  real.** `repositorio-memoria.js` é single-thread por construção — duas
  chamadas sequenciais nele nunca competem de verdade. Pra provar
  `FOR UPDATE SKIP LOCKED`/lease/lock de verdade, use
  `CRMCLINICA_TEST_DATABASE_URL` contra Postgres real (ver
  `testes/lembretes-concorrencia.test.js` como padrão a seguir).
- Ambiente de teste HTTP: `testes/auxiliar.js` (`subirServidor`,
  `autenticar`) — nunca usa banco real nem rede real por padrão.

## Migrations

- `db/NNN_descricao.sql` **sempre** em par com
  `db/NNN_descricao_rollback.sql` — toda migration nova precisa das duas,
  desde o começo (é convenção forte do projeto, não opcional).
- Aditiva por padrão: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`, nunca `DROP`/`TRUNCATE` em objeto que já existia antes da
  migration. Uma transação só (`BEGIN`...`COMMIT`).
- RLS habilitado + política restrita a `crmclinica_app` + `REVOKE ALL` de
  `anon`/`authenticated` explícito, mesmo padrão em toda migration nova
  (ver `db/031` como referência completa, incluindo o comentário explicando
  cada decisão).
- Nunca inclua conteúdo de conversa/paciente em coluna de auditoria ou erro
  técnico — só motivo técnico (timeout, código HTTP, nome de exceção).
- Aplicar em produção: **sempre** manualmente via SQL Editor do Supabase
  (ver "Arquitetura real" acima) — nunca por script automatizado, mesmo
  com autorização, porque a credencial da app não tem o privilégio. Depois
  de aplicado, confirme com uma query só-leitura própria (schema, RLS,
  policies, grants) usando a credencial normal da app — não confie no "deu
  certo" do editor sem provar no banco.

## Fluxo para mudanças de risco (o que este projeto já provou que funciona)

Para qualquer mudança que toque o caminho de atendimento ao paciente,
controle da Serena, ou banco:

1. **Isole em `git worktree`** numa branch `fix/*` a partir da main atual —
   nunca trabalhe direto na `main`.
2. **Implemente em fases pequenas, testáveis, um commit por garantia** —
   não um commit gigante.
3. **Audite com um agente genuinamente independente**: sessão nova, sem
   herdar contexto da implementação, instruído a verificar tudo sozinho
   (rodar os testes do zero, ler o código, **não confiar na mensagem de
   commit**). Read-only — audita, não corrige.
4. Se a auditoria reprovar ou encontrar achado real: **implementação
   corrige, auditor reaudita** — pode ser um agente novo de novo (rigor
   máximo) ou o mesmo auditor verificando só o ponto específico apontado
   (mais rápido, ainda independente o suficiente quando o achado é
   pontual).
5. Só depois de aprovado: push da branch + PR em draft (automático, não
   precisa perguntar) → **merge exige autorização explícita** → deploy da
   Vercel é automático no merge, mas **migrations e mudanças de
   infraestrutura (VPS) continuam exigindo autorização própria, uma de
   cada vez**, mesmo depois do merge.

Isso não é burocracia gratuita: nesta mesma sessão, a segunda rodada de
auditoria pegou uma regressão real que o commit final introduziu (uma rota
que derrubava a tela inteira da Serena quando um gateway externo falhava) e
um bug de concorrência genuíno (lease de fila dimensionado por lote em vez
de por trabalho, causando entrega duplicada real sob carga) — os dois só
apareceram porque alguém sem o contexto da implementação foi verificar de
verdade, não porque os testes escritos junto com o código foram
insuficientes por descuido.

Precedente completo e detalhado (mapa de arquitetura com arquivo:linha,
16 frentes de correção, achados de duas rodadas de auditoria, tudo com
evidência real): `docs/superpowers/plans/2026-08-13-serena-controle-duravel.md`
e `docs/superpowers/plans/2026-08-13-achados-pendentes.md`.

## Ao subir worker novo no VPS

1. Confirme via `.env` compartilhado (`/opt/crmclinica-ponte/.env`) que as
   variáveis que o worker precisa já existem e não estão vazias — nunca
   assuma, confira o comprimento do valor, nunca imprima o valor em si.
2. `git fetch` + `git checkout`/`pull --ff-only` para a branch/commit
   certo — **antes**, confira se há commits locais únicos no VPS que não
   estão no GitHub (`git log origin/main..HEAD`); se houver, compare
   conteúdo arquivo a arquivo antes de assumir que é seguro sobrescrever.
3. `npm ci` + `npm run verificar` no próprio VPS antes de criar o serviço.
4. Systemd unit no mesmo padrão hardened dos workers existentes.
5. Depois de `systemctl start`, confirme no banco (não só no `systemctl
   status`) que o heartbeat do componente chegou — é a prova real de que
   está funcionando, não só que o processo subiu.
