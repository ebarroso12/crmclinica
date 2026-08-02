# Agenda

A agenda do crmclinica marca, remarca e cancela compromissos. Duas decisões
moldam o resto do desenho, e as duas existem para proteger o paciente.

## 1. O conflito é do banco, não do código

Duas pessoas podem oferecer o mesmo horário ao mesmo tempo — a recepção pelo
painel e a automação pelo WhatsApp. Quando as duas confirmam, uma checagem em
JavaScript não basta: entre "verifiquei que está livre" e "gravei" existe uma
janela, e nessa janela cabe uma consulta duplicada.

Quem fecha essa janela é o PostgreSQL:

```sql
CONSTRAINT agendamentos_sem_conflito EXCLUDE USING gist (
  profissional_id WITH =,
  tstzrange(inicio, fim, '[)') WITH &&
) WHERE (status <> 'cancelado')
```

- `[)` — o fim é aberto. Uma consulta das 14h às 15h e outra das 15h às 16h se
  encostam, não se sobrepõem. É o dia inteiro de uma clínica.
- `WHERE status <> 'cancelado'` — cancelar libera o horário de verdade.
- Precisa da extensão `btree_gist` para combinar `=` com `&&` no mesmo índice.

A checagem em `src/dominio/agenda.js` continua existindo, mas com outro papel:
dar uma resposta melhor ("ocupado das 14h às 15h") antes de tentar gravar. A
**garantia** é a constraint. Por isso o serviço captura o erro `23P01` e o traduz
em 409 — inclusive descobrindo qual agendamento atrapalhou, para a recepção não
ter de procurar na tela.

O repositório em memória simula esse comportamento de forma atômica (a checagem
e a inserção acontecem sem `await` entre elas), lançando um erro com o mesmo
`code: '23P01'`. Assim as duas implementações se comportam igual, e os testes de
concorrência rodam sem banco.

## 2. Propor e confirmar são dois passos

`POST /api/agenda/propor` **não grava nada**. Devolve um token, o horário
validado e uma frase pronta:

> Confirmar consulta com Dra. Helena Prado em 05/08/2026, 15:00?

`POST /api/agenda/confirmar` recebe esse token e grava. Só aqui algo entra na
agenda, e só o que foi proposto.

Oferecer e marcar na mesma ação é como uma clínica acaba com consulta que o
paciente não pediu — especialmente quando quem oferece é uma automação. O token
amarra a confirmação àquele horário: sem ele, um "sim" chegaria solto e a
aplicação teria de adivinhar sobre o quê.

A proposta vale 15 minutos e mora em memória. Guardá-la no banco daria
durabilidade a algo que não deve durar.

## Rotas

| Rota | Método | Descrição |
| --- | --- | --- |
| `/api/agenda?inicio=&fim=&profissional=` | GET | Compromissos e bloqueios do período |
| `/api/agenda/horarios?profissional=&dia=` | GET | Horários realmente livres do dia |
| `/api/agenda/vocabulario` | GET | Status, tipos e dias da semana |
| `/api/agenda/profissionais` | GET/POST | Lista e cadastro |
| `/api/agenda/profissionais/:id/disponibilidade` | PUT | Substitui as janelas de atendimento |
| `/api/agenda/bloqueios` | POST | Bloqueia um período (almoço, férias, congresso) |
| `/api/agenda/bloqueios/:id` | DELETE | Remove o bloqueio |
| `/api/agenda/propor` | POST | Valida e devolve token — **não grava** |
| `/api/agenda/confirmar` | POST | Grava o que foi proposto |
| `/api/agenda/:id/remarcar` | POST | Move o horário e desfaz a confirmação |
| `/api/agenda/:id/cancelar` | POST | Cancela e libera o horário |
| `/api/agenda/:id/status` | POST | confirmado, compareceu, faltou |
| `/api/conversas/:id/agenda` | GET | A agenda do paciente vista de dentro da conversa |

## Regras que valem a pena conhecer

- **Remarcar desfaz a confirmação.** A pessoa confirmou o horário antigo; o novo
  precisa de confirmação nova.
- **`faltou` continua ocupando o horário.** A vaga já foi perdida — liberá-la
  retroativamente falsearia a agenda daquele dia.
- **Agendar no passado é recusado.** Quase sempre é erro de digitação de data.
- **Horário que já passou não é oferecido** na lista de livres.
- **Atravessar a meia-noite não é atendimento de clínica** e é recusado.
- **Toda alteração vai para a auditoria** com quem fez: criar, confirmar,
  remarcar, comparecer, faltar e cancelar. Sem isso, "quem cancelou minha
  consulta?" não tem resposta.
- **`dia_semana` vai de 0 (domingo) a 6**, igual a `EXTRACT(DOW)` do PostgreSQL e
  a `getDay()` do JavaScript. Nenhuma conversão no meio do caminho.

## Interface

A grade semanal é desenhada à mão, sem biblioteca de calendário — o projeto não
carrega dependência de front-end, e um CDN externo numa tela de clínica é uma
requisição a terceiro a cada abertura da agenda.

Cada dia é uma coluna com posicionamento proporcional ao horário: uma consulta
de uma hora ocupa a altura de uma hora. A altura da hora vive em uma única
variável CSS (`--altura-hora`) que o JavaScript lê — enquanto o número existia
nos dois lugares, a régua de horas e os blocos usavam escalas diferentes e um
compromisso das 10h aparecia na linha das 13h.

Clicar num espaço livre abre a proposta. Clicar num compromisso abre as ações.
Dentro de uma conversa, "Marcar horário" leva à agenda com o paciente já
escolhido — em vez de propor "agora + 30 minutos", que quase sempre cai fora do
horário de atendimento e renderia uma recusa antes de a pessoa poder escolher.
