# crmclinica — instruções para agentes

## CONTRATO OPERACIONAL OBRIGATÓRIO

### Princípio central

O projeto usa correção aditiva.

Nunca reescreva a história Git para reorganizar commits já publicados.

Um erro descoberto depois de um commit deve gerar um novo commit corretivo.

### Ações automáticas autorizadas

Execute sem solicitar confirmação:

- leitura e busca de arquivos;
- git status, diff, log, show, grep e branch;
- inspeção do GitHub;
- criação de branch fix/* a partir da main atual;
- edição dentro da branch fix/*;
- criação e atualização de testes;
- npm ci;
- npm run verificar;
- npm test;
- commits temáticos em branch fix/*;
- documentação;
- criação de PR em modo draft.

### Ações que exigem autorização expressa

- merge na main;
- commit ou push direto na main;
- reset de qualquer tipo;
- rebase;
- commit --amend;
- force push;
- git clean;
- apagar arquivos não gerados;
- descartar alterações locais;
- stash que inclua trabalho desconhecido;
- migrations em produção;
- DELETE, UPDATE, INSERT ou DDL em produção;
- alteração ou rotação de credenciais;
- religar a Serena;
- modificar configurações globais da máquina.

### Protocolo antes de alterar código

1. git status --short
2. git branch --show-current
3. git log -8 --oneline --decorate
4. confirmar branch diferente de main
5. registrar BASE_SHA
6. identificar arquivos exatos da tarefa

### Protocolo antes de commit

1. git diff --check
2. npm run verificar
3. npm test
4. git diff --stat
5. revisar somente arquivos da tarefa
6. um assunto por commit

### Protocolo ao descobrir erro próprio

Nunca improvisar reset, rebase ou amend.

Faça:

1. preservar o estado;
2. diagnosticar o erro;
3. explicar o impacto;
4. criar correção aditiva;
5. executar testes;
6. criar novo commit;
7. registrar a correção no PR.

### Regra contra expansão de escopo

Não corrigir um problema não relacionado no mesmo commit.

Não reorganizar histórico, refatorar arquivos ou alterar configuração apenas para deixar o trabalho "mais bonito".

Priorizar funcionamento comprovável, rastreabilidade e reversibilidade.

## Armadilha conhecida desta máquina

Hooks globais do claude-flow (`~/.claude/settings.json`) executam comandos via
`cmd /c`; o `>` de arrow functions (`=>`) em comandos Bash vira redirecionamento
e cria arquivos-lixo na raiz do repositório. Enquanto os hooks não forem
corrigidos:

- evitar `node -e` contendo `=>`;
- preferir escrever um `.js` temporário (scratchpad ou `scripts/tmp/`) e executá-lo;
- conferir a raiz por nomes estranhos antes de commitar.

## Enforcement automático (hooks + subagentes)

O contrato acima é orientação — depende de o agente lembrar e seguir. Os
hooks deste diretório (`.claude/settings.json`, `.claude/hooks/*.js`) são
enforcement: rodam sempre, independente de qualquer sessão "lembrar" da
regra. Um prompt pode ser esquecido; um hook não.

| Hook | Evento | O que faz |
|---|---|---|
| `bloquear-migration.js` | PreToolUse (Edit/Write/MultiEdit) | Bloqueia escrita em `db/NNN_*.sql` sem `CRMCLINICA_AUTORIZAR_MIGRATION=1` no ambiente |
| `bloquear-comando-destrutivo.js` | PreToolUse (Bash) | Bloqueia `git push --force`/`push` direto na main, `reset --hard`, `clean -f`, `rm -rf`, `DROP`/`TRUNCATE`/`DELETE` sem WHERE, deploy direto de produção |
| `checar-arquivo-editado.js` | PostToolUse (Edit/Write/MultiEdit) | Roda `node --check` no `.js` recém-editado (não há eslint/prettier neste projeto — `testes/auditoria.test.js` proíbe dependência de terceiros além de `pg` — então sintaxe válida é o gate real disponível) |
| `checar-antes-de-finalizar.js` | Stop | Se há mudança não commitada, exige `npm run verificar` + `npm test` passando antes de aceitar que a sessão terminou |

Os 4 hooks foram testados manualmente (caso bloqueia / caso passa) antes de
serem registrados — qualquer edição neles deve passar pelo mesmo teste
manual antes de confiar de novo (ver histórico de commit para o método:
JSON de entrada gravado em arquivo, nunca via `echo` com aspas — o
`echo` do Git Bash corrompe `\\` em path Windows dentro de JSON).

### Subagentes de revisão independente (`.claude/agents/`)

`code-reviewer`, `security-reviewer`, `debugger`, `ux-reviewer`,
`database-reviewer` — cada um só-leitura (`Read`/`Glob`/`Grep`, exceto
`debugger` que também tem `Bash` para diagnóstico), cada um sem contexto da
implementação que está revisando. Use um deles depois de qualquer mudança
não trivial, antes de considerar pronto — a mesma sessão que implementou
não é quem deveria aprovar; este projeto já teve regressão real pega só
porque um revisor sem o contexto da implementação foi verificar de novo
(ver `docs/superpowers/plans/2026-08-13-achados-pendentes.md`).

## Regras de Engenharia do Projeto

### Verdade e evidência

- Não invente comandos, resultados, arquivos, schemas, endpoints ou testes.
- Não declare "corrigido", "pronto" ou "testado" sem mostrar a evidência de
  que foi executado (saída de comando, não afirmação).
- Separe falhas preexistentes de regressões introduzidas no trabalho atual —
  um teste que já falhava antes da mudança não é culpa da mudança, mas
  precisa ser dito, não escondido.

### Segurança operacional

- Preserve mudanças existentes do usuário — nunca descarte trabalho não
  commitado sem `git status` antes e confirmação de que é seguro.
- Não faça push, deploy, migration de produção, rotação de segredo ou
  qualquer operação irreversível sem autorização explícita e específica
  para aquela ação — "continue"/"pode" genérico não conta (ver seção
  "Ações que exigem autorização expressa" acima).
- Antes de mudanças grandes, registre branch, HEAD (`git log -1
  --oneline`) e `git status --short` — é a linha de base para saber o que
  mudou de fato depois.

### Implementação

- Resolva causa raiz, não sintoma — se a causa não estiver clara depois de
  investigar, diga que não está clara; não corrija o primeiro sintoma
  plausível.
- Preserve contratos fora do escopo da tarefa atual.
- Prefira mudança mínima, testável e observável a refatoração ampla.
- Reutilize abstrações existentes (`repositorio.js`, `rbac.js`, `escapar()`,
  padrão de rota em `rotas-*.js`) antes de criar uma nova — busque primeiro.

### Lógica

- Para fluxo crítico (pagamento, agendamento, atendimento automático,
  autenticação), pense explicitamente em: estados possíveis, invariantes
  que não podem quebrar, transação, concorrência (dois workers, duas abas),
  idempotência, retry, timeout e falha parcial (gravou mas não confirmou).

### Validação

- Use os comandos oficiais do repositório: `npm run verificar` (sintaxe),
  `npm test` (suíte), `npm run test:pg` (suíte contra PostgreSQL real,
  exige `CRMCLINICA_TEST_DATABASE_URL` descartável).
- Depois de alterar código, revise o diff (`git diff --stat` e o conteúdo)
  e rode os testes relevantes — não assuma que passou.
- Quando a mudança afeta comportamento de runtime/UI, valide rodando (smoke
  test manual ou browser automation) quando possível — teste estático prova
  sintaxe e lógica isolada, não que o fluxo real funciona.

### Comunicação

- Relate causa raiz, arquivos alterados, comandos/testes rodados (com
  resultado, não só "rodei") e risco residual conhecido.
- Se algo não pôde ser validado (sem acesso a produção, sem tempo, sem
  ambiente), diga exatamente o que ficou sem validar e por quê — não deixe
  implícito que está tudo coberto.
