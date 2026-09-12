# Ligar o Instagram da loja Alpins

O código já está pronto e publicado. O que falta são credenciais e um cadastro
— coisas que só quem tem a senha da Meta pode fazer.

Enquanto os passos abaixo não forem feitos, **nada muda**: a clínica continua
respondendo como sempre, e o perfil da loja simplesmente não é atendido.

Painel da Meta: conta **majolicursos@gmail.com** (developers.facebook.com).

---

## O que vai acontecer quando estiver ligado

Alguém comenta num post da **loja** → o sistema responde ali no comentário **pela
conta da loja** e manda um direct assinado **"Agente Alpins"** → a conversa nasce
no CRM já como conversa do Alpins, e quem responder o direct fala com ele.

Exatamente o que a clínica tem hoje, com o perfil e as regras da loja.

---

## Passo 1 — o perfil precisa ser Comercial

No aplicativo do Instagram da loja: **Configurações → Tipo de conta → Mudar para
conta profissional** (Comercial ou Criador), e vincule a uma página do Facebook.

Sem isso a Meta não deixa nenhum sistema responder direct — não é limitação do
CRM.

## Passo 2 — adicionar o perfil no app da Meta

No painel (developers.facebook.com), no **mesmo app** onde a clínica já está:

1. Produto **Instagram → Configurações da API**
2. Adicione a conta da loja
3. Gere o **token de acesso** dessa conta
4. Anote também o **ID da conta comercial** (aparece na mesma tela)

Se a loja ficar num app separado da Meta, acrescente também
`INSTAGRAM_ALPINS_APP_SECRET` com o segredo daquele app — o webhook aceita a
assinatura de qualquer app configurado.

> **Confira antes de seguir:** na tela de Configurações da API, veja o ID da
> conta comercial **da clínica** e compare com o valor de
> `INSTAGRAM_BUSINESS_ACCOUNT_ID` que já está na Vercel. Se forem diferentes,
> corrija a variável da clínica ANTES do passo 4 — ligar o segundo perfil com
> esse id errado faria a clínica parar de responder. (Com um perfil só, esse id
> nem é consultado; por isso o problema não existe hoje.)

## Passo 3 — aplicar a migration 049 (ANTES de ligar as variáveis)

No SQL Editor do Supabase, cole e rode o conteúdo de
`db/049_instagram_por_agente.sql`. Depois confirme com `npm run verificar-banco`
— ele deve dizer "Tudo aplicado".

**Por que antes:** é essa migration que dá dono às regras. Sem ela, ligar o
segundo perfil faria as regras da **clínica** dispararem nos posts da **loja**.

## Passo 4 — guardar o token (você digita, ninguém mais vê)

Na Vercel, em Settings → Environment Variables do projeto, crie três variáveis:

| Variável | Valor |
|---|---|
| `INSTAGRAM_CONTAS` | `alpins` |
| `INSTAGRAM_ALPINS_ACCESS_TOKEN` | o token gerado no passo 2 |
| `INSTAGRAM_ALPINS_BUSINESS_ACCOUNT_ID` | o ID da conta comercial da loja |

Depois, **Redeploy** (a Vercel só lê variável nova em deploy novo).

As mesmas três precisam ir para o `.env` do VPS
(`/opt/crmclinica-ponte/.env`) e depois `systemctl restart crmclinica-outbox`.

> O token é segredo: ele fica só no painel e no servidor, nunca em tabela do
> banco nem em arquivo do projeto.

## Passo 5 — cadastrar o canal no CRM

No CRM: **Agentes → Agente Alpins → Canais → Novo canal**

- Canal: `instagram`
- Instância: o **mesmo ID da conta comercial** do passo 2

É esse cadastro que liga o perfil ao agente. Sem ele, o comentário chega mas o
sistema não sabe de quem é o perfil.

## Passo 6 — criar as regras da loja

**Instagram → Nova regra**, com o Agente Alpins selecionado.

As regras da loja e as da clínica são independentes: a palavra "preço" na loja
não dispara nada nos posts da clínica, e "agendar" na clínica não dispara na
loja.

---

## Conferindo que deu certo

1. Peça para alguém comentar num post **da loja** usando uma palavra da regra.
2. Deve aparecer a resposta no comentário e chegar um direct.
3. No CRM, em Conversas, a aba **Alpins** deve mostrar a conversa nova.
4. **Importante:** comente também num post **da clínica** e confirme que ela
   continua respondendo. É a verificação que prova que ligar o segundo perfil
   não atrapalhou o primeiro.

Se o comentário da clínica parar de ser respondido depois do passo 4, o
`INSTAGRAM_BUSINESS_ACCOUNT_ID` da clínica provavelmente está diferente do id
que a Meta manda no webhook. Solução: conferir os dois ids na tela de
Configurações da API e corrigir a variável da clínica. (Enquanto só existe um
perfil, esse id nem é consultado — por isso o problema só pode aparecer aqui.)

---

## Se precisar desligar

Apague a variável `INSTAGRAM_CONTAS` e faça Redeploy: o sistema volta a atender
só a clínica, e as regras da loja ficam guardadas para quando religar.
