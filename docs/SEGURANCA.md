# Segurança

## Contas e liberação de acesso

**Cadastro não é autorização.** Toda conta nova nasce `pendente` e não entra até o
administrador master liberar — inclusive quando veio pelo Google, onde qualquer
pessoa com uma conta poderia se cadastrar sozinha.

| Situação | O que significa |
| --- | --- |
| `pendente` | Cadastrou e aguarda liberação. Login responde **403** com a situação, não 401 — a pessoa precisa saber que não errou a senha. |
| `ativo` | Pode entrar e trabalhar. |
| `recusado` | Acesso negado pelo master. |
| `desativado` | Acesso suspenso. |

Recusar ou desativar **revoga as sessões abertas** na hora: continuar logado depois
de desativado tornaria a decisão decorativa.

### Administrador master

Conta única, marcada por `master` no banco, com índice que impede uma segunda.
Só ela libera contas, cria usuários e muda papéis. A própria conta do master não
pode ser desativada nem ter o papel alterado — seria a única forma de o sistema
ficar sem ninguém capaz de liberar acessos.

```bash
# com banco configurado
npm run criar-admin
```

Lê `CRMCLINICA_MASTER_EMAIL` e `CRMCLINICA_MASTER_SENHA`. Rodar de novo é seguro:
se a conta já existe, **a senha não é sobrescrita**.

A conta nasce com `precisa_trocar_senha`: senha que passou por arquivo de
configuração, terminal ou mensagem deve ser considerada conhecida por terceiros.
A interface leva direto ao perfil até a troca acontecer.

## Autenticação

Duas peças com propósitos diferentes:

| Peça | Forma | Validade | Por quê |
| --- | --- | --- | --- |
| **access token** | JWT HS256, auto-contido | 15 min | Validar não toca o banco |
| **refresh token** | opaco, aleatório de 32 bytes | 7 dias | É o que permite **revogar** |

O refresh nunca é gravado em claro: a tabela `sessoes` guarda o SHA-256 dele. Um
vazamento da tabela não vira um vazamento de sessões ativas — mesmo raciocínio da senha.

**Rotação:** cada `POST /api/auth/refresh` revoga o refresh usado e emite outro. Se um
token vazar e for usado, o legítimo para de funcionar — o problema aparece em vez de
passar despercebido.

### Senha

`scrypt` do próprio Node, com `N=16384, r=8, p=1` e sal de 16 bytes por senha.
O hash carrega os parâmetros (`scrypt$N$r$p$sal$hash`), então aumentar o custo no
futuro não invalida as senhas existentes.

Login com e-mail inexistente **confere um hash mesmo assim** e devolve exatamente a
mesma resposta de senha errada. Responder mais rápido para e-mail desconhecido
entregaria a lista de quem tem conta.

### O botão de olho, e o que ele não faz

Todo campo de senha tem um botão que alterna entre `password` e `text`, para a
pessoa conferir o que digitou antes de enviar.

Ele **não descriptografa** nada. A senha guardada é um hash scrypt, e hash não tem
volta — nem para nós. É por isso que o sistema não consegue dizer qual é a sua
senha, só se a que você digitou confere. Quando alguém esquece, o caminho é
redefinir, nunca recuperar o valor antigo.

### Segundo fator (opcional, por pessoa)

TOTP (RFC 6238) — o código de 6 dígitos dos aplicativos autenticadores.

- O segredo fica **cifrado** com AES-256-GCM, com chave derivada do segredo da aplicação: quem lê a tabela sem a chave não gera código nenhum.
- Só passa a valer **depois de confirmado** com um código do aplicativo. Preparar e não confirmar não tranca ninguém para fora.
- Tolerância de um passo (30 s) para frente e para trás: celular atrasado não pode virar motivo de bloqueio.
- Desativar exige a senha — token roubado não desliga proteção.
- O login responde `segundo_fator: obrigatorio` ou `incorreto`, para a tela mostrar o campo em vez de dizer "senha errada" e mandar a pessoa procurar o problema no lugar errado.

### Login com conta Google

OAuth 2.0 + OpenID Connect. O `id_token` é verificado de verdade:

- assinatura RS256 conferida contra as chaves públicas do Google (JWKS, com cache respeitando o `cache-control`);
- **o algoritmo vem do nosso lado**, nunca do cabeçalho do token;
- `aud` precisa ser o nosso cliente — sem isso, um token emitido para qualquer outro site do Google serviria para entrar aqui;
- `iss` e `exp` conferidos;
- e-mail não verificado é recusado: qualquer pessoa cadastra o e-mail de outra numa conta Google sem confirmar.

O `state` amarra o retorno à requisição que o originou (defesa contra CSRF) e vale
por 10 minutos, uma vez só.

### Recuperação de senha

Link enviado ao e-mail de cadastro, com token de 32 bytes guardado **em hash**,
válido por 1 hora e de uso único. Um pedido novo invalida os anteriores.

A resposta é **idêntica** para e-mail conhecido e desconhecido: a diferença
revelaria quem tem conta. Redefinir a senha revoga todas as sessões.

Sem SMTP configurado, o pedido é registrado em log e não sai — e a resposta ao
solicitante continua a mesma, para não expor o estado do envio.

### Detalhes que evitam ataques conhecidos

- O algoritmo de verificação vem do nosso lado, **nunca do cabeçalho do token** — é o que impede `alg: none` e confusão de chave. Testado.
- Assinatura e senha são comparadas em tempo constante.
- Em produção o processo **não sobe** sem `CRMCLINICA_JWT_SECRET` de 32+ caracteres. Fora de produção, um segredo aleatório é gerado por processo — nunca existe um valor padrão que alguém leve para produção por engano.

## Autorização (RBAC)

| Permissão | admin | gestor | atendente |
| --- | :---: | :---: | :---: |
| `conversas:ler` | ✅ | ✅ | ✅ |
| `conversas:responder` | ✅ | ✅ | ✅ |
| `conversas:assumir` | ✅ | ✅ | ✅ |
| `conversas:etiquetar` | ✅ | ✅ | ✅ |
| `conversas:resolver` | ✅ | ✅ | ✅ |
| `conversas:priorizar` | ✅ | ✅ | — |
| `contatos:ler` | ✅ | ✅ | ✅ |
| `contatos:editar` | ✅ | ✅ | — |
| `leads:ler` | ✅ | ✅ | ✅ |
| `auditoria:ler` | ✅ | ✅ | — |
| `usuarios:gerenciar` | ✅ | — | — |

A matriz é explícita, sem herança entre papéis: dá para ler inteira e responder
"quem pode fazer isso?". Papel desconhecido e permissão inexistente **negam** —
a falta de regra nunca libera.

**401 é "não sei quem você é"; 403 é "sei, e você não pode".** A distinção importa
para depurar e para não vazar existência de recurso.

## O que é público e o que não é

| Rota | Acesso |
| --- | --- |
| `/health` | público — é o que o monitor consulta |
| `/`, `/estilo.css`, `/app.js` | público — a interface pede login antes de mostrar qualquer dado |
| `/api/auth/login`, `/refresh`, `/logout` | público por definição: é onde a identidade nasce |
| `/api/auth/opcoes` | público — diz só se Google e recuperação estão ligados |
| `/api/auth/cadastro` | público — a conta criada nasce pendente |
| `/api/auth/recuperar`, `/redefinir` | público — quem esqueceu a senha não tem sessão |
| `/api/auth/google`, `/google/retorno` | público — é o fluxo de entrada |
| `/api/usuarios/*` | exige **master**, não só admin |
| `/api/eventos` | **assinatura HMAC**, não sessão — quem chama é o canal, não uma pessoa |
| todo o resto de `/api/*` | exige portador válido **e** a permissão da rota |

## Row Level Security

O Supabase expõe uma API REST automática sobre o schema `public`. Mesmo que a
aplicação nunca a use, **a porta existe** — e sem RLS a chave anônima leria conversas
de pacientes. `db/002_autenticacao_e_rls.sql`:

1. liga RLS em **todas** as tabelas;
2. cria uma política por tabela para o papel `crmclinica_app`;
3. **revoga** `anon` e `authenticated` de tudo no schema, incluindo privilégios padrão futuros.

Sem política que case, esses papéis não leem nenhuma linha.

RLS é ligado **sem `FORCE`** de propósito: o backend conecta com a connection string
do projeto, cujo papel é dono das tabelas, e dono ignora RLS. Forçar aqui trancaria a
própria aplicação para fora — a segurança viraria indisponibilidade. O endurecimento
com `FORCE` está documentado no fim daquele arquivo e depende de dar `LOGIN` ao papel
da aplicação.

### Chaves do Supabase

Este backend **não usa** `anon key` nem `service_role`. Ele fala Postgres direto pela
`CRMCLINICA_DATABASE_URL`. Não há chave do Supabase no código nem no navegador — o que
elimina por construção o risco de `service_role` vazar pelo frontend.

## Tokens no navegador

| Token | Onde fica | Por quê |
| --- | --- | --- |
| access | **só em memória** | Em `localStorage` sobreviveria à aba e seria legível por qualquer script injetado |
| refresh | `sessionStorage` | Um F5 não pode derrubar a recepção no meio do plantão; morre ao fechar a aba |

Quando o access vence, a interface renova e repete a requisição — transparente para
quem está atendendo. Uma tentativa só, para não entrar em laço.

## Auditoria

`audit_log` registra login, login recusado, logout, criação de usuário, ação em
conversa e edição de ficha. **Nem senha nem e-mail entram no log** — auditoria não
pode virar vazamento. Testado.

## Pendências conhecidas

- **Sem limite de tentativa de login.** Um atacante pode tentar senhas à vontade. Antes de expor publicamente: limitar por IP e por conta, com atraso progressivo. É a lacuna mais séria da lista.
- **A trilha de auditoria não tem rota de consulta** — existe a permissão `auditoria:ler`, mas nenhuma rota a usa ainda.
- **RLS não foi verificado contra o banco real** — as migrations estão escritas, mas não foram aplicadas nem testadas aqui.
- **O envio de e-mail não foi exercido contra um SMTP real** — o cliente foi escrito e testado com dublê.
- **O login com Google não foi exercido contra o Google real** — a verificação do `id_token` foi testada com par de chaves gerado no teste, incluindo os casos de recusa.
