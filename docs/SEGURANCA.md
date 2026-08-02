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

### Limite de tentativas

Sem teto, um atacante testa senhas à vontade. O scrypt torna cada tentativa cara
para ele, mas "caro" não é "impossível": uma conta com senha fraca cai numa noite.

Duas chaves independentes, porque protegem de coisas diferentes:

| Chave | Limite | Janela | Protege de |
| --- | --- | --- | --- |
| conta (e-mail) | 5 falhas | 15 min | adivinhar **uma** senha |
| IP | 30 falhas | 15 min | varrer **muitas** contas da mesma origem |
| recuperação por conta | 3 | 1 h | flood de e-mail na caixa de outra pessoa |
| recuperação por IP | 10 | 1 h | idem, em escala |
| redefinição por IP | 20 | 1 h | força bruta no token do link |

O limite do IP é mais alto de propósito: uma clínica inteira sai por um endereço
só, e um teto apertado trancaria a recepção junto com o atacante.

**Janela deslizante**, não fixa: com janela fixa, quem estoura às 10h14 recupera
tudo às 10h15 e tenta o dobro na virada. A contagem é sempre "falhas nesta chave
nos últimos N minutos", e o `Retry-After` diz quando a tentativa mais antiga sai
da janela.

Resposta **429** com `Retry-After` em segundos e `tentar_em_segundos` no corpo.

#### O que o limite não pode estragar

- **Não vira oráculo de existência.** O limite por conta vale exista ela ou não, e o e-mail entra em hash SHA-256. A sequência de códigos é idêntica para conta existente e inexistente — testado.
- **Não engole o 403.** Conta pendente ou desativada continua respondendo 403 com a situação, e acertar a senha de uma conta na fila **não conta como falha**: quem espera liberação não é empurrado para 429 por insistir.
- **Acerto limpa o contador da conta.** Quem errou e depois lembrou da senha não fica de castigo. Mas o contador do **IP não é limpo** por um acerto: senão um atacante com uma conta própria zeraria a varredura.
- **O segundo fator também é limitado.** Sem isso ele seria o elo sem teto: só 10⁶ combinações, testáveis à vontade por quem já tem a senha.

#### Onde o estado mora

No **PostgreSQL** (`tentativas_autenticacao`), não em memória do processo. Com duas
instâncias atrás de um balanceador, um contador local permitiria o dobro das
tentativas e a proteção seria só aparente.

A tabela guarda IP, hash da conta, ação, sucesso e instante — **nunca a senha**, e
nunca o e-mail em claro. Registros fora de qualquer janela são apagados de hora em
hora (`limpar_tentativas_vencidas`, retenção de 24 h): guardá-los para sempre
transformaria a tabela num histórico de quem tentou entrar e quando.

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
de pacientes. `db/002_autenticacao_e_rls.sql` liga RLS em todas as tabelas, cria
política para o papel `crmclinica_app` e revoga `anon` e `authenticated` do schema,
incluindo privilégios padrão futuros.

### O que uma auditoria encontrou, e por que importa

Uma revisão do banco em produção mostrou uma coisa que muda a leitura de tudo acima:

> As tabelas pertencem a `postgres`, e é como `postgres` que a aplicação conecta.
> Essa role tem `BYPASSRLS`. **O RLS nunca é avaliado para ela.**

Ou seja: enquanto `CRMCLINICA_DATABASE_URL` apontar para o dono, as políticas não
são frouxas nem apertadas — elas simplesmente não rodam. Discutir se uma policy
deveria usar `USING (true)` ou algo mais fino é discutir a cor de uma porta que
não está no batente.

A ordem correta de endurecimento é:

1. **A aplicação conectar como `crmclinica_app`.** Só a partir daí o RLS existe
   para ela. `db/007_hardening.sql` dá `LOGIN` à role e concede privilégios
   precisos; a senha fica fora do repositório e a connection string precisa ser
   trocada. Sem este passo, os dois seguintes não mudam nada em runtime.
2. **Privilégios que negam o que não deve existir.** `audit_log` e `lead_eventos`
   não têm `DELETE` nem `UPDATE`; `usuarios` não tem `DELETE` — conta se desativa
   pela coluna `situacao`. Privilégio ausente é negado antes de a policy ser
   consultada, e são exatamente as tabelas cuja perda não tem volta.
3. **`FORCE ROW LEVEL SECURITY`**, que faz o RLS valer até para o dono. Só depois
   de (1), porque antes disso ele tranca a própria aplicação para fora.

### Storage: o risco que não dá para corrigir por migration

`anon` e `authenticated` têm `SELECT`, `INSERT`, `UPDATE`, `DELETE` e **`TRUNCATE`**
em `storage.objects` e `storage.buckets`, mais `USAGE` no schema.

Para acesso linha a linha o RLS segura: está ligado e não há policy, e RLS sem
policy nega. Mas **`TRUNCATE` não passa pelo RLS** — é privilégio de tabela, e não
há linha para filtrar quando o comando apaga tudo de uma vez. Verificado neste
projeto: com `SET ROLE anon`, o `TRUNCATE` é aceito.

Hoje não há dano porque não existe bucket nem objeto. No dia do primeiro upload,
qualquer pessoa com a chave anônima — que é pública por definição, vai no
front-end — apaga todos os arquivos da clínica com um comando.

**A correção não cabe numa migration.** `storage.objects` pertence a
`supabase_storage_admin`; a role `postgres` do Supabase não é superuser e não pode
assumir essa role. Um `REVOKE` de dentro de uma migration emite `WARNING` e não faz
nada — pior que não tentar, porque a migration passaria aparentando ter resolvido.

Execute pelo SQL Editor do painel (que conecta com mais privilégio) ou por ticket:

```sql
REVOKE ALL ON storage.objects, storage.buckets FROM anon, authenticated;
```

Sem tocar em `s3_multipart_uploads*`: são internas do Storage e mexer nelas quebra
upload grande. Elas só têm `SELECT`, que o RLS neutraliza.

`npm run verificar-banco` falha enquanto isso não for feito.

### Por que não existe vínculo com `auth.users`

Uma recomendação comum de hardening no Supabase é ligar `public.usuarios` a
`auth.users`. Aqui isso não se aplica: **este produto não usa o Supabase Auth.**

A autenticação é própria — JWT HS256 assinado pela aplicação, senha com scrypt,
TOTP opcional, e Google verificado por JWKS no servidor. `auth.users` está vazia e
continuará vazia. Criar a chave estrangeira produziria um vínculo decorativo para
uma tabela sem linhas; migrar para o GoTrue seria reescrever a autenticação inteira
e adicionar uma superfície que hoje não existe.

O objetivo por trás da recomendação — **o banco saber quem é o usuário** — é
legítimo, e o caminho para ele aqui é outro: `db/007_hardening.sql` cria
`app_usuario_atual()`, que lê `app.usuario_id` da sessão. Quando a aplicação passar
a declarar esse valor por transação, as políticas podem decidir por usuário sem
depender do GoTrue. Isso exige que toda consulta rode dentro de uma transação com
`SET LOCAL` — mudança na camada de dados que ainda não foi feita.

### Migrations aplicadas fora da CLI

O ledger `supabase_migrations.schema_migrations` só registra o que passa pela CLI
do Supabase. SQL aplicado por outro caminho — painel, API de query — deixa o schema
correto e o ledger em branco, e quem olhar só o ledger conclui que nada foi
aplicado. Ao aplicar por fora, registre também:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<timestamp>', '<nome_da_migration>') ON CONFLICT DO NOTHING;
```

Na dúvida entre ledger e schema, **o schema manda**. É por isso que
`db/verificar.sql` e `npm run verificar-banco` checam objetos — tabela, coluna,
função, policy — e não o registro.

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

- **A trilha de auditoria não tem rota de consulta** — existe a permissão `auditoria:ler`, mas nenhuma rota a usa ainda.
- **O IP vem de `req.socket.remoteAddress`.** Atrás de um proxy reverso, isso é o IP do proxy, e o limite por IP passa a valer para todo mundo junto. Ao publicar: ler `X-Forwarded-For` **apenas** de proxies confiáveis — confiar no cabeçalho de qualquer origem permitiria forjar o IP e contornar o limite.
- **RLS não foi verificado contra o banco real** — as migrations estão escritas, mas não foram aplicadas nem testadas aqui.
- **O envio de e-mail não foi exercido contra um SMTP real** — o cliente foi escrito e testado com dublê.
- **O login com Google não foi exercido contra o Google real** — a verificação do `id_token` foi testada com par de chaves gerado no teste, incluindo os casos de recusa.
