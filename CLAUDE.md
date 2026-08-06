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
