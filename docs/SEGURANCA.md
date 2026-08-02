# Segurança

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

- **Sem limite de tentativa de login.** Um atacante pode tentar senhas à vontade. Antes de expor publicamente: limitar por IP e por conta, com atraso progressivo.
- **Sem 2FA.**
- **A trilha de auditoria não tem rota de consulta** — existe a permissão `auditoria:ler`, mas nenhuma rota a usa ainda.
- **RLS não foi verificado contra o banco real** — a migration está escrita, mas não foi aplicada nem testada aqui.
