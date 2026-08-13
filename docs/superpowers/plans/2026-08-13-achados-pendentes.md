# Achados pendentes — auditoria do Comando 6 (registro, não correção)

## Propósito

O Comando 7 corrigiu, com TDD e um commit por achado, os cinco pontos que
bloqueavam ou representavam risco real segundo a auditoria independente do
Comando 6: **C-1**, **A-1**, **A-2**, **A-3** e **M-1**. Cada um está commitado
na branch `fix/serena-controle-duravel` com testes vermelho-antes-de-verde,
`npm run verificar` e `npm test` passando.

Este documento é o registro exigido pelo Comando 7 para os demais achados —
**M-2 a M-5** e **B-1 a B-13** — que **não foram corrigidos** por decisão
explícita de escopo (evitar expansão do que foi pedido). Nenhum código deste
documento foi alterado; é só a lista de pendências, para não perder o que a
auditoria encontrou.

## Lacuna a resolver antes de agir sobre esta lista

Esta sessão recebeu do coordenador o texto **completo** dos achados C-1, A-1,
A-2, A-3 e M-1 (motivo, código afetado, comportamento esperado). Para M-2–M-5
e B-1–B-13, a instrução do Comando 7 referenciou os **identificadores**, sem
o corpo de cada achado — e o relatório original da auditoria do Comando 6 não
está disponível nesta sessão (não foi salvo como arquivo no repositório; foi
entregue como mensagem, fora do que esta sessão herdou).

**Consequência prática:** a tabela abaixo lista os IDs conhecidos com o nível
de severidade que o Comando 7 indicou (M = médio, B = baixo/observação), mas
**sem a descrição técnica de cada um** — preenchê-la exigiria ou (a) reabrir o
relatório original do Comando 6 e copiar o texto de cada achado para cá, ou
(b) rodar uma nova varredura equivalente. Nenhuma das duas coisas está dentro
do que o Comando 7 autorizou fazer nesta sessão (que foi: corrigir os cinco
achados nomeados, e *registrar* os demais — não reconstruí-los de memória, o
que seria inventar conteúdo que não foi de fato auditado por esta sessão).

Marcar esta lacuna explicitamente é preferível a preencher as descrições com
suposição: um achado registrado errado é pior do que um achado sinalizado como
"descrição pendente de recuperação", porque o primeiro passa confiança falsa.

## Achados de severidade média (M-2 a M-5)

| ID | Severidade | Descrição | Status |
| --- | --- | --- | --- |
| M-2 | Médio | *(descrição não recuperada nesta sessão — ver "Lacuna" acima)* | Pendente de descrição e de correção |
| M-3 | Médio | *(descrição não recuperada nesta sessão — ver "Lacuna" acima)* | Pendente de descrição e de correção |
| M-4 | Médio | *(descrição não recuperada nesta sessão — ver "Lacuna" acima)* | Pendente de descrição e de correção |
| M-5 | Médio | *(descrição não recuperada nesta sessão — ver "Lacuna" acima)* | Pendente de descrição e de correção |

## Achados de baixa severidade / observações (B-1 a B-13)

| ID | Severidade | Descrição | Status |
| --- | --- | --- | --- |
| B-1  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-2  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-3  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-4  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-5  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-6  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-7  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-8  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-9  | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-10 | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-11 | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-12 | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |
| B-13 | Baixo | *(descrição não recuperada nesta sessão)* | Pendente de descrição e de correção |

## Por que não foram corrigidos agora

- Regra explícita do Comando 7: só C-1/A-1/A-2/A-3/M-1 seriam implementados;
  os demais deveriam ser **registrados**, não corrigidos, para não expandir o
  escopo do programa.
- Severidade média/baixa: nenhum dos dois grupos foi classificado como
  bloqueante pela auditoria (diferente de C-1 e A-1/A-2, marcados como
  bloqueantes).

## Próximo passo recomendado

Antes de agir sobre M-2–M-5 ou B-1–B-13 (corrigir, criar stories, priorizar),
recuperar o texto completo de cada achado a partir do relatório original da
auditoria do Comando 6 (a sessão que rodou a varredura independente) e
substituir os placeholders desta tabela pelo conteúdo real. Só então faz
sentido decidir, achado a achado, se cada um vira um Comando novo (com TDD,
igual ao Comando 7) ou se é aceito como risco conhecido e documentado.
