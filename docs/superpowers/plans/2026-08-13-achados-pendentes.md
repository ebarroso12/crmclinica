# Achados pendentes — auditorias independentes (registro, não correção)

## Propósito

Este documento acumula os achados de auditoria independente que **não foram
corrigidos** — por decisão explícita de escopo, não por omissão — ao longo do
programa de correção do controle da Serena. Duas rodadas até aqui:

- **Primeira auditoria (Comando 6):** achados **C-1**, **A-1**, **A-2**,
  **A-3** e **M-1** foram corrigidos no Comando 7, com TDD e um commit por
  achado. **M-2 a M-5** e **B-1 a B-13** ficaram pendentes, registrados na
  seção correspondente abaixo.
- **Segunda auditoria independente**, rodada em cima do commit `1351499`
  (fim do Comando 7): veredito **APROVADO COM RESSALVAS** — confirmou C-1,
  A-1 e A-2 como de fato resolvidos, com evidência própria do auditor.
  Achados **N-9**, **N-10** e **N-13** foram corrigidos. **N-1 a N-12** e
  uma nota informativa ficaram pendentes, registrados na seção
  correspondente abaixo.

Nenhum código relativo aos achados pendentes foi alterado por este
documento; é só a lista de pendências, para não perder o que cada auditoria
encontrou.

## Primeira auditoria (Comando 6) — texto verbatim

O texto abaixo é o relatório original da primeira auditoria, colado verbatim
(recebido do coordenador depois da primeira versão deste arquivo, que só
continha os identificadores).

## Achados de severidade média (M-2 a M-5)

### M-2 — `testes/automacao-outbox-servico.test.js:80-93`: o teste "dois workers ao mesmo tempo" não testa concorrência nem Postgres

Duas chamadas sequenciais a `repositorio.reivindicarTrabalhosDeOutbox` contra
um `Map` em memória (`repositorio-memoria.js:1134-1147`, sem `await` no
meio — atômico por construção em thread única). Prova apenas que uma
mudança de status é visível na chamada seguinte, não prova nada sobre
`FOR UPDATE SKIP LOCKED` nem sobre duas sessões Postgres reais. O
repositório já tem a infraestrutura para isso: `testes/lembretes-concorrencia.test.js:17-27`
roda a mesma bateria contra Postgres de verdade via
`CRMCLINICA_TEST_DATABASE_URL` — a outbox não reaproveitou o padrão. O SQL
em si (`repositorio.js:2586-2611`) parece correto por leitura (CTE com
`FOR UPDATE SKIP LOCKED` + `UPDATE ... FROM candidatos` numa instrução só),
mas isso é revisão, não prova.

**Recomendação:** escrever o teste equivalente contra banco real,
reaproveitando o padrão de `lembretes-concorrencia.test.js`.

**Status:** pendente de correção.

### M-3 — Frente 12 entrega um cartão que dirá "Não aplicável" em produção

`rotas-serena.js:146` só produz `desejado_vs_efetivo` quando existe
`politica` (gateway da clínica). Em Arquitetura B / Evolution — o modo
efetivo hoje — vem `null`, e o painel mostra "Não aplicável — sem política
de canal". O incidente que motivou a frente (painel dizia desligada, Serena
respondia mesmo assim) acontece na arquitetura atual, onde quem decide é a
barreira do CRM, não a política do OpenClaw. O "efetivo" relevante hoje
seria o comportamento real de entrega (ex.: contagem recente de
`envio_abortado_por_controle` vs. `respondida_pela_automacao`), não a
política do gateway. A frente está tecnicamente entregue e praticamente
inerte hoje.

**Status:** pendente de correção (repensar a fonte do "efetivo" para a
Arquitetura B).

### M-4 — Frente 9 é uma sonda de alcance de host, não "ponta a ponta"

`sondaDaEvolution` faz um `GET` na `apiUrl` e considera qualquer resposta
HTTP (incluindo 401/404) como saudável. Uma instância Evolution conectada
ao host mas com o WhatsApp desconectado — a falha real mais comum —
aparece como `ok`. Os itens do plano "webhook recente" e "última entrega"
não foram implementados.

**Status:** pendente de correção.

### M-5 — `src/dominio/atendimento.js:89`: publicação no SSE agora acontece dentro da transação

Com a mudança do Comando 3, o `emissor?.publicarMensagem` executa antes do
COMMIT. Se uma escrita posterior falhar e a transação sofrer ROLLBACK, o
SSE já anunciou aos navegadores abertos uma mensagem que não existe (a
tela recarrega e corrige, mas é uma inconsistência de leitura). Impacto
baixo em prática.

**Status:** pendente de correção (impacto baixo — não bloqueante).

## Achados de baixa severidade / observações (B-1 a B-13)

### B-1 — `db/031_automacao_outbox.sql:128`: REVOKE não cobre a sequence

`GRANT USAGE, SELECT` na sequence `automacao_outbox_id_seq` para
`crmclinica_app`, mas o bloco de REVOKE (linhas 132-140) cobre só a
tabela, não a sequence — o Supabase costuma ter
`ALTER DEFAULT PRIVILEGES ... ON SEQUENCES TO anon, authenticated`. Impacto
real baixo (não vaza linha), mas quebra a simetria de proteção que o
próprio arquivo se propõe. Não verificado contra o banco real.

**Status:** pendente de correção.

### B-2 — `db/031`: sem `FORCE ROW LEVEL SECURITY`

O dono da tabela ignora RLS. Consistente com as migrations 010/021, não é
regressão desta branch — informativo.

**Status:** informativo, sem ação proposta.

### B-3 — `control_version` do plano (frente 1) não existe

Zero ocorrências de `control_version`/`controlVersion`/`versao_controle`
no repositório. O plano original pedia carimbo de versão crescente
comparado no fim; a implementação (Comando 2) usa só releitura de estado.
A releitura resolve o caso real e é mais simples, mas o commit `304198a`
não declarou a divergência do plano. Só rastreabilidade — sem impacto
funcional.

**Status:** informativo — divergência do plano original não documentada no
commit correspondente; sem impacto funcional identificado.

### B-4 — Janela TOCTOU residual

`atendimento.js` (`podeEntregarAgora` → `obterContato` → `canal.enviar`): a
janela caiu de "segundos (chamada de IA)" para "uma leitura de banco", mas
não foi eliminada — é inerente sem token de cancelamento no transporte. O
texto da UI já é honesto sobre isso ("pode ainda ter sido entregue —
confira a conversa").

**Status:** risco residual aceito, já comunicado honestamente na UI.

### B-5 — `evolution-envio.js:61`: classificação de erro incompleta

`indeterminado` só é aplicado para `TimeoutError`/`AbortError`. Um
`ECONNRESET` depois do request já ter sido enviado também é indeterminado
(mensagem pode ter saído) e hoje é classificado como retentável — risco de
duplicata pelo mesmo mecanismo do M-1, mas por um caminho de erro
diferente.

**Status:** pendente de correção — mesma família de risco do M-1
(corrigido neste Comando 7 via LEASE_MS), caminho de erro diferente
(ECONNRESET pós-envio não classificado como indeterminado).

### B-6 — `automacao-outbox-servico.enfileirar` é código morto em produção

O caminho real (`atendimento.js:157-162`) chama
`repositorio.enfileirarTrabalhoDeOutbox` direto, não passa por
`automacao-outbox-servico.enfileirar`. Consequências: a auditoria
`outbox_enfileirado` nunca dispara em produção; o template da chave de
idempotência está duplicado em dois arquivos (`atendimento.js:157` e
`automacao-outbox-servico.js:49`) e pode divergir sem ninguém notar; todos
os testes de enfileiramento do serviço exercitam um caminho que produção
não usa.

**Status:** pendente de correção — considerar unificar em um único ponto
de enfileiramento.

### B-7 — `testes/horario-grade-editor.test.js`: cobertura por regex, não comportamental

O próprio cabeçalho do arquivo declara honestamente essa limitação.
Revisão manual do código (`app.js`, editor da grade) não encontrou caminho
que descarte janela; `lerGradeDaTela` lê tudo do DOM e rejeita linha
meio-preenchida — correto por leitura, mas sem teste de comportamento real
(ex.: harness de DOM).

**Status:** pendente — precisaria de harness de DOM para virar teste
comportamental.

### B-8 — Escopo do commit `304198a` misturou duas frentes

Assunto "barreira final antes do envio automatico" (backend), mas o
commit também altera ~99 linhas de `public/app.js` (estados
"Aplicando…", textos). O corpo do commit declara a mudança — não é
escopo oculto — mas contraria a regra de "um assunto por commit".

**Status:** histórico já publicado; correção aditiva (reorganizar
commits já publicados) contraria a regra do projeto de história git
aditiva — registrado como aprendizado, sem ação de reescrita de histórico.

### B-9 — CONFIRMADO: correção do bug do orquestrador condicional (Comando 4) foi completa

Auditor verificou `grep -rn "transporteWhatsapp"` em todo `src/`, `bin/`,
`api/` — só `config.js` (definição/validação) e
`worker-lembretes.js:116,252` (uso legítimo) permanecem. Nenhum outro
caminho de atendimento condiciona nada a essa variável.

**Status:** confirmado correto — sem ação necessária.

### B-10 — CONFIRMADO: `setImmediate` eliminado de fato

`grep -rn "setImmediate\|process.nextTick"` em `src/`, `bin/`, `api/` só
encontra menções em comentários explicando a remoção. Nenhum padrão
equivalente sobreviveu no caminho do webhook.

**Status:** confirmado correto — sem ação necessária.

### B-11 — Possível vazamento de conteúdo de mensagem em log de erro (pré-existente, não introduzido por esta branch)

`evolution-envio.js:69` embute `corpo.slice(0,300)` da resposta de erro da
Evolution na mensagem do `Error`, que chega ao `audit_log` via
`atendimento.js:392` (`detalhe.motivo`) e ao `console.warn` de
`canal-conversas.js:87`. O redator de auditoria
(`src/seguranca/redator-auditoria.js`) filtra por nome de chave, não
removeria conteúdo dentro de `motivo`. Se a Evolution ecoar o payload da
mensagem em erros de validação, o texto do paciente iria para a
auditoria. Possível, não verificado — depende do formato de erro real da
instância Evolution em uso.

**Status:** pendente de verificação e, se confirmado, de correção
(sanitizar `motivo` antes de auditar/logar, ou truncar sem eco de corpo).

### B-12 — Migrations: aditivas confirmadas, mas item 13 do plano continua pendente

`db/031` é aditiva (nenhum DROP/TRUNCATE sobre objeto existente),
atômica, com guards de existência de role e rollback documentado. O item
13 do plano original (reconciliar histórico de migrations do Supabase com
o schema real) não foi endereçado em nenhum dos Comandos 2-7 — continua a
lacuna assumida desde o Comando 1.

**Status:** pendente — lacuna assumida desde o Comando 1, ainda sem dono
nem data.

### B-13 — Nota operacional, não achado de código

O auditor encontrou um arquivo-lixo (`conferirConexao(pool)`) no worktree
DELE, causado pela mesma armadilha de hooks já documentada no CLAUDE.md do
projeto. Não afeta esta branch — já foi tratado.

**Status:** não é achado de código — nenhuma ação necessária nesta branch.

## Por que M-2 a M-5 e B-1 a B-13 não foram corrigidos no Comando 7

- Regra explícita do Comando 7: só C-1/A-1/A-2/A-3/M-1 seriam implementados;
  os demais deveriam ser **registrados**, não corrigidos, para não expandir o
  escopo do programa.
- Severidade média/baixa: nenhum dos dois grupos foi classificado como
  bloqueante pela auditoria (diferente de C-1 e A-1/A-2, marcados como
  bloqueantes).

## Segunda auditoria independente — achados N-1 a N-13 (registro, não correção)

Rodada em cima do commit `1351499`. Veredito **APROVADO COM RESSALVAS**.
**N-9**, **N-10** e **N-13** foram corrigidos (ver commits `6349327`,
`af623ac` e o rollback da migration 032); os demais achados abaixo — de
risco baixo/médio, não bloqueantes — ficam só registrados, por decisão
explícita de escopo desta rodada.

### ⚠️ N-3 (médio — PRECONDIÇÃO OPERACIONAL, não é bug de código) — a única coisa desta lista que o Dr. Edson precisa saber pessoalmente antes de autorizar produção

`src/dominio/atendimento.js:249` + `src/integracoes/openclaw.js:186`:
`orquestrador.disponivel` vem de config estática do processo (`gateway.url`
+ token). Se o processo do worker da outbox subir SEM essas variáveis
configuradas, TODA mensagem de paciente passa a escalonar (a correção do
A-2 funcionando exatamente como projetado) — e `escalonar` marca
`assumida_por_humano: true` por conversa, que entra na lista de "decisão
humana, não re-escalona" da barreira final. Resultado: silêncio permanente
e disperso (uma conversa de cada vez) até alguém notar e liberar
manualmente cada uma.

**Não é defeito da correção do A-2 — é ela funcionando certo diante de má
configuração.** Mas é uma pré-condição que precisa ser **verificada ANTES
de qualquer deploy do worker da outbox**, não depois: só quem tem acesso ao
processo real em produção sabe se `gateway.url`/token estão configurados
para o worker.

**Status:** pré-condição operacional, não código a corrigir. **Precisa de
verificação humana (Dr. Edson) antes de qualquer deploy do worker da
outbox em produção.**

### N-1 (médio)

`src/servidor/rotas-serena.js:161-163` + `public/app.js:2880-2884`: quando
a correção do C-1 degrada por falha do gateway, `desejado_vs_efetivo` volta
`null` — o MESMO valor usado para "não aplicável (Arquitetura B)". O
painel mostra "Não aplicável" quando na verdade é "gateway falhou,
comparação desconhecida" — informação enganosa por omissão, mesma classe
de defeito que motivou o A-3 original. Única evidência da falha real é um
`console.error` no servidor.

**Correção sugerida:** terceiro estado no payload (`{indisponivel:true}`)
com rótulo próprio.

**Status:** pendente de correção.

### N-2 (baixo)

`src/dominio/atendimento.js:24-26` vs `src/dominio/conversas.js:73-74`:
`ia_pausada` (serena.js) e `pausa_temporaria` (conversas.js) são a mesma
condição (`ia_pausada_ate` no futuro, decisão humana), mas só o primeiro
está na lista de "não escalonar" da barreira final. O segundo (caminho de
fallback, não o principal — `serena` sempre é injetado em produção)
escalona incorretamente. Impacto prático baixo, defeito lógico real.

**Status:** pendente de correção.

### N-4 (médio)

`src/dominio/diagnostico.js:213-219`: achado `outbox.fila.morto > 0` vira
`critico` permanentemente — `contarTrabalhosDeOutboxPorEstado` não tem
janela de tempo nem existe rotina de purga da tabela `automacao_outbox`. O
primeiro trabalho que morrer deixa `/api/diagnostico` vermelho pra sempre,
e como o nível global do laudo é o pior achado, a varredura inteira perde
poder de sinal. A regra análoga de lembretes usa `aviso`, não `critico`,
para o mesmo tipo de fato (`diagnostico.js:246-253`) — inconsistência a
resolver num Comando futuro.

**Status:** pendente de correção.

### N-5 (baixo)

`src/dominio/diagnostico.js:203-211`: `vencidos > 0` vira `critico` com
texto "a fila parou de andar" após só 5 minutos — com backlog legítimo
(>20 pendentes, lote=20) os trabalhos do fim da fila cruzam esse limite
mesmo com o worker funcionando normalmente, gerando alarme falso com
diagnóstico textualmente errado. A regra equivalente de lembretes usa 15
minutos.

**Status:** pendente de correção.

### N-6 (baixo)

`src/dominio/diagnostico.js:198`: `detalhe: outbox.detalhe ?? null` recebe
o objeto jsonb inteiro do heartbeat, mas a UI faz
`detalhe.textContent = item.detalhe` esperando string — vai renderizar
`[object Object]`. Só aparece justamente quando o worker está inativo com
heartbeat antigo, ou seja, quando o operador mais precisa ver o detalhe.
`sondaDoWorker` (sonda irmã) já extrai string corretamente — seguir o
mesmo padrão.

**Status:** pendente de correção.

### N-7 (médio)

`src/dominio/atendimento.js:686-706` + `db/032_...sql:26-27`:
`marcarEntregaFalhou` (frente A-3) só é chamada no ramo de bloqueio da
barreira final. Os ramos de `canal_nao_configurado`, `contato_sem_telefone`
e erro de rede/timeout no envio real retornam `enviada:false` SEM marcar a
mensagem — apesar de o `COMMENT ON COLUMN` da migration 032 afirmar que
cobre "uma falha de envio já registrada". Resultado: uma falha de envio
real (a categoria mais comum) continua indistinguível de entrega normal na
tela — o mesmo problema que A-3 deveria ter resolvido, só que para outro
grupo de causas. A equipe é avisada (esses ramos escalonam), mas a
mensagem na tela mente.

**Status:** pendente de correção — estender `marcarEntregaFalhou` para os
demais ramos de `enviada:false`.

### N-8 (baixo)

`src/dominio/atendimento.js:399-410` vs `664`: a mensagem é publicada no
SSE (tempo real) ANTES da tentativa de entrega; `marcarEntregaFalhou`
acontece depois, sem publicar evento novo. Tela de Conversas aberta ao
vivo mostra "entregue" até recarregar.

**Status:** pendente de correção.

### N-11 (baixo)

`src/dominio/resumo.js:64`: `/api/resumo` expõe `plataforma.outbox.saude`
(A-1), mas `public/app.js` não tem nenhuma ocorrência de `outbox` — o
campo não é renderizado em lugar nenhum. A observabilidade do A-1 hoje
depende do botão manual "Verificar agora"; nada é passivo/automático no
painel principal.

**Status:** pendente de correção — renderizar `plataforma.outbox.saude` no
painel principal.

### N-12 (baixo)

`testes/identidade-da-requisicao.test.js:34-44`,
`testes/atendimento-barreira-controle.test.js:74`,
`testes/automacao-outbox-servico.test.js:53`: três fixtures pré-existentes
trocaram `estrategia_ia: 'crm_despacha'` (produção) por
`'openclaw_gerencia'` para escapar do escalonamento novo do A-2. Comentado
honestamente, mas é erosão de cobertura — esses testes pararam de
exercitar o caminho de ingestão real.

**Status:** pendente — considerar um teste dedicado que exercite
`'crm_despacha'` com o escalonamento do A-2 ativo, em vez de desviar dele
no setup.

### N-13 (baixo) — ✅ RESOLVIDO

`db/032_mensagens_marca_entrega_falhou.sql`: sem arquivo de rollback,
contra a convenção do próprio repositório (010, 031). `DROP COLUMN` é
trivial, mas vale criar o rollback por consistência.

**Status:** resolvido — `db/032_mensagens_marca_entrega_falhou_rollback.sql`
criado, seguindo o mesmo padrão de `db/031_automacao_outbox_rollback.sql`
(o que apaga, o que custa, aviso de não rodar por reflexo, instrução de
reverter código+banco juntos). Nenhuma migration foi aplicada em produção
por este commit — só o arquivo de rollback foi criado, para a 032 já
nascer com caminho de volta documentado antes de ser aplicada.

### Nota informativa (sem ação)

`conversa_resolvida` escalona, e `escalonar` reabre a conversa
(`status:'aberta'`) mesmo que alguém tenha marcado resolvida. É
deliberado, testado, e defensável (chegou mensagem nova do paciente), mas
tensiona o princípio de "não passar por cima de decisão humana recente"
que o próprio `serena.js` enuncia.

**Status:** registrado só para consciência futura — nenhuma ação proposta.

## Próximo passo recomendado

**Antes de qualquer deploy do worker da outbox em produção:** verificar
pessoalmente (Dr. Edson) que o processo do worker tem `gateway.url` e
token configurados — ver **N-3** acima. Essa é a única pré-condição desta
lista inteira que exige conhecimento do ambiente real, não decisão de
prioridade técnica.

Para o resto, priorizar achado a achado se cada um vira um Comando novo
(com TDD, igual ao Comando 7) ou se é aceito como risco conhecido e
documentado. Candidatos óbvios a um próximo Comando, pela combinação de
risco real e correção localizada:

- **M-2** (prova de concorrência real contra Postgres, mesmo padrão de
  `lembretes-concorrencia.test.js`);
- **B-1** (REVOKE da sequence);
- **B-5** (classificação de ECONNRESET como indeterminado, mesma família
  do M-1);
- **B-11** (possível vazamento de conteúdo em log de erro, precisa de
  verificação contra o formato real de erro da Evolution antes de decidir
  a correção);
- **N-1** (terceiro estado explícito para "gateway falhou" vs. "não
  aplicável" no painel da Serena — mesma classe de defeito do A-3
  original);
- **N-7** (estender `marcarEntregaFalhou` para os ramos de falha de envio
  real, não só o bloqueio da barreira — completa o que A-3 deveria ter
  coberto).
