# Plano técnico — Controle durável da Serena

- **Data:** 2026-08-13
- **Fase:** COMANDO 1 — baseline, isolamento e plano (nenhuma alteração de produção)
- **Branch de trabalho:** `fix/serena-controle-duravel` (criada a partir de `origin/main`, commit `671e344` = `671e3449e46516c269b1746c19cb2d38429bcf1f`, o mesmo auditado em produção)
- **Repositório confirmado:** `origin` = `https://github.com/ebarroso12/crmclinica` (fetch e push) — OK, autorizado
- **Fontes externas consultadas:** `C:\Users\Cliente\Downloads\APENDICE-MATRIZ-BOTOES-CRMCLINICA-2026-08-13.md` (lido, íntegro) e `C:\Users\Cliente\Downloads\RELATORIO-AUDITORIA-PROFUNDA-CRMCLINICA-2026-08-13.md` (lido, íntegro). Os dois existiam e foram lidos por completo; os achados abaixo foram reconferidos diretamente no código desta fase, não apenas copiados do relatório.

## 0. Baseline registrada

```
diretório de trabalho : C:\crmclinica\.claude\worktrees\agent-a931ee26ff9266550
remote origin          : https://github.com/ebarroso12/crmclinica (fetch e push)
branch                 : fix/serena-controle-duravel (nova, a partir de HEAD)
HEAD                    : 671e344 = 671e3449e46516c269b1746c19cb2d38429bcf1f
                          (Merge pull request #31 from ebarroso12/fix/evolution-envio-nativo)
                          idêntico a origin/main e ao commit auditado em produção
node                    : v24.15.0
npm                     : 12.0.2
```

Scripts relevantes (`package.json`): `verificar` (node --check em ~90 arquivos), `test` (`node --test testes/**/*.test.js`), `smoke*`, workers (`lembretes:worker`, `google:worker`), `criar-admin`, `verificar-banco`. Não há scripts `lint`, `typecheck` nem `build` separados neste projeto — `verificar` é o único gate estático, e por regra do COMANDO 1 ele **não** conta como prova suficiente sozinho.

```
npm ci        → 14 pacotes, 0 vulnerabilidades, sem erro
npm run verificar → todos os node --check passaram, sem erro
npm test      → tests 972, pass 972, fail 0, cancelled 0, skipped 0, duration_ms 26077.48
```

Os números batem exatamente com os 972/972 registrados no relatório de auditoria de 13/08. Log completo salvo em `C:\Users\Cliente\AppData\Local\Temp\claude\C--crmclinica\018a19ab-8c5d-4a18-881e-6792e7ed2c37\scratchpad\npm-test-output.log` (fora do repositório, não versionado).

Nenhum teste vermelho foi encontrado ou escondido. Nenhuma migration, delete, insert, update, restart de serviço, rotação de credencial ou push foi executado nesta fase.

## 1. Mapa da arquitetura real (com arquivo:linha)

### 1.1 Entrada do webhook (Evolution e OpenClaw, mesma rota)

- Rota HTTP: `src/servidor/http.js:1581-1592` — `POST /api/canais/whatsapp/eventos` → `receberMensagemDoWhatsapp`.
- `receberMensagemDoWhatsapp` (`src/servidor/http.js:477-495`) chama `receberEventoAssinado` com `adaptador: 'openclaw_ingresso_crm'` para **as duas origens**: a ponte HMAC do OpenClaw e a segunda porta por token da Evolution (`tokenAlternativo`, linhas 488-493).
- Tradução do payload nativo da Evolution: `src/integracoes/evolution-webhook.js` — `normalizarEventoEvolution` (linhas 63-90). Ignora eco (`fromMe`), grupos, eventos que não são `messages.upsert` e mensagens sem texto reconhecível, devolvendo `null` (a rota responde 200 "ignorado", não processa).
- Autenticação: assinatura HMAC (`x-whatsapp-assinatura`) OU token da Evolution na querystring (`?token=`), comparados em tempo constante (`tokenIngressoValido`, `src/servidor/http.js:468-475`).
- Idempotência de entrada: `repositorio.consultarEvento(evento.chave_idempotencia)` antes de gravar (`http.js:416-420`); reentrega devolve o mesmo recibo, não duplica.
- **Confirmado: a rota responde HTTP 202 e delega o resto ao processamento em segundo plano.** `http.js:430-432`:
  ```js
  const resultado = await conversas.receberMensagemDeCanal(evento, {
    despachoEmSegundoPlano: adaptador === 'openclaw_ingresso_crm',
  });
  ```
  Isso vale tanto para a ponte OpenClaw quanto para a Evolution, porque as duas usam o mesmo `adaptador`.

### 1.2 Persistência da mensagem

- `src/dominio/atendimento.js:49-166` — `receberMensagem`: garante contato (`encontrarOuCriarContato`) e conversa (`encontrarOuCriarConversaAberta`), grava a mensagem (`registrarMensagem`, com `id_externo` garantindo idempotência de linha), publica no SSE (`emissor?.publicarMensagem`, linha 89), trata opt-out de lembretes, cria/atualiza lead.
- **Confirmado: `setImmediate` fora da resposta HTTP.** `src/dominio/atendimento.js:143-156`:
  ```js
  if (despachoEmSegundoPlano) {
    setImmediate(() => {
      responderSePossivel(conversa.id, { mensagemEntradaId: mensagem.id }).catch(async (erro) => {
        ...
        await escalonar(conversa.id, 'falha_no_despacho_em_segundo_plano');
      });
    });
    return { acao: 'aceita_para_despacho', ... };
  }
  ```
  Este `setImmediate` roda **depois** que a função HTTP já respondeu 202. Numa função serverless da Vercel, a plataforma pode congelar/encerrar o processo assim que a resposta é entregue — não há garantia de que o callback do `setImmediate` chegue a rodar. Se ele não rodar, a mensagem fica gravada no inbox mas a Serena nunca decide se responde nem gera nada: nem resposta, nem escalonamento, nem auditoria. É um "engolimento silencioso" de evento, distinto do caso já tratado de falha *durante* o despacho (que tem `catch` e escalona).

### 1.3 Decisão `podeResponder`

- `src/dominio/atendimento.js:183-192` — `responderSePossivel` chama `serena.podeResponder(conversa)` **uma vez**, logo no início, antes de qualquer chamada à IA.
- `src/dominio/serena-servico.js:155-164` — `podeResponder` relê a configuração do banco a cada chamada (comentário explícito nas linhas 12-15 do arquivo: "Desligar é imediato... não há cache do estado").
- `src/dominio/serena.js:199-...` — `decidirResposta` é a função pura que aplica a ordem de precedência: `ativa === false` > `pausada_ate` > `ligada_ate` (plantão) > grade (`dentroDoHorario`, linhas 113-145) > ativação gradual (`contatoNaAtivacao`, linhas 154-172) > conversa assumida por humano.

### 1.4 Geração pela IA e envio

- Depois da decisão inicial, `responderSePossivel` (`atendimento.js:213-363`) monta contexto, despacha ao orquestrador (`orquestrador.despacharEvento`, linha 289), grava a resposta (`registrarMensagem`, linha 310) e só então chama `entregarAoPaciente` (linhas 228 e 325).
- `entregarAoPaciente` (`atendimento.js:496-515`) **não relê `serena.podeResponder`, `pausada_ate`, `ligada_ate`, `assumida_por_humano` nem uma versão de controle** antes de enviar. Ele só verifica se existe `canal.enviar` e se o contato tem telefone.

  **P0 confirmado, com evidência direta de código:** entre a leitura de `podeResponder` (linha 191) e o envio efetivo (linha 325 → 496), passam-se: consulta de lead, extração de qualificação por IA (chamada de rede opcional, linhas 251-268), chamada ao orquestrador (linha 289, rede), gravação no banco (linha 310). Cada uma dessas etapas pode levar segundos. Se a equipe clicar em Desligar/Pausar/Assumir nesse intervalo, a resposta sai mesmo assim, porque não há segunda leitura do estado imediatamente antes do envio. Isso bate exatamente com a sequência hipotética do relatório de auditoria (seção "P0 — Resposta em voo não é interrompida") e com o item 44/45 da matriz de botões (Assumir/Devolver: "handler existe, mas silencia mensagens *posteriores*, não cancela geração em voo").

- Envio real: `src/integracoes/canal-conversas.js:70-87` — tenta `evolucao.enviar` primeiro (se `evolucao?.disponivel`); se falhar E houver `configuracao.url` (gateway OpenClaw), cai para `enviarPeloGateway` (linhas 41-56, WebSocket, `gateway.chamar('send', ...)`, com `idempotencyKey`).
- Cliente Evolution: `src/integracoes/evolution-envio.js:16-66` — POST simples (`fetch`), sem fila, sem retry próprio. Comentário do próprio arquivo (linhas 8-14): "é intencionalmente burro... a Evolution API não expõe idempotência nativa nesse endpoint, então uma reentrega de rede pode, na pior das hipóteses, mandar a mesma mensagem duas vezes — risco aceito por ora". **P1 confirmado por comentário explícito do autor original no próprio código.**

### 1.5 Fallback OpenClaw e transporte padrão

- `.env.exemplo:148` e `src/config.js:73`: `SERENA_TRANSPORTE_WHATSAPP` tem padrão `openclaw_gerencia` quando a variável não é definida.
- **Nuance importante, não presente tão explicitamente no relatório:** hoje esse valor **não** controla mais o caminho de envio em si (`canal-conversas.js` decide por `evolucao?.disponivel`, sem olhar `transporteWhatsapp`). O único lugar do código de produção que lê `configuracao.serena.transporteWhatsapp` é `bin/worker-lembretes.js:116,252`, para decidir a estratégia de IA anexada aos lembretes automáticos. `src/config.js:307-324` valida o valor e exige gateway de comando + `OPENCLAW_SESSION_ID` + gateway da clínica + `WHATSAPP_WEBHOOK_SECRET` quando `crm_despacha` é escolhido.
- Efeito prático do padrão desatualizado: um ambiente novo, uma variável esquecida ou uma reconstrução do `.env` a partir do `.env.exemplo` herda `openclaw_gerencia` como padrão dos lembretes automáticos — reabrindo, para a régua de lembretes, a arquitetura antiga que o incidente desta madrugada expôs como perigosa. O caminho de atendimento (mensagem→resposta) já não depende dessa variável, mas o padrão enganoso continua sendo risco de configuração e continua sem falhar o deploy quando está desalinhado com a realidade (Evolution é o canal efetivo hoje). O plano trata os dois: alinhar o padrão documental/de validação E confirmar (com teste) que nenhum caminho de atendimento residual ainda depende dele.

### 1.6 Alteração do estado global, pausa, plantão, agenda

- `src/dominio/serena-servico.js`: `definirAtiva` (50-70), `definirAgenda` (87-96), `pausar` (109-121), `despausar` (124-128), `ligarPorTempo` (137-147), `definirAtivacao` (170-189). Todas auditam via `repositorio.registrarAuditoria` com ação nomeada (`serena_ligada`, `serena_desligada`, `serena_pausada`, etc.).
- Rotas HTTP: `src/servidor/rotas-serena.js` (não totalmente lido linha a linha nesta fase, mas confirmado via grep que expõe `abrirTeste`, `enviarNoTeste`, `lerTeste` — ver 1.9).
- **Defeito confirmado na grade — janela `18:00–23:59` deixa 1 minuto de lacuna:** `src/dominio/serena.js:113-145`, função `dentroDoHorario`. A comparação é `minutos >= inicio && minutos < fim` (linha 131) — `fim` é **exclusivo**. Uma janela `["18:00","23:59"]` cobre até o minuto 1438 (23:58), e o minuto 1439 (23:59) fica de fora, só voltando a ser coberto quando o dia seguinte abrir às `00:00`. O código só trata `00:00–00:00` como "o dia inteiro" (linha 130: `if (inicio === fim) { if (inicio === 0) return true; ... }`), mas a configuração atual em produção (segundo o relatório de auditoria, seção 3.1) usa `18:00–23:59`, não `18:00–00:00`. **Causa raiz confirmada em código; efeito em produção depende da configuração salva no banco, que não foi consultada nesta fase (sem alteração de produção autorizada).**
- **Defeito confirmado no editor de horário — só o primeiro intervalo do dia é editável:** `public/app.js:3366-3387`. A renderização da grade pega só `janelas[0]` (linha 3374, `const [inicio = '', fim = ''] = janelas[0] ?? []`) para os campos de início/fim; se houver mais de uma janela no dia, o código só adiciona uma nota de texto "+N faixa(s) definidas pela API" (linhas 3384-3387), sem oferecer edição. Salvar o formulário nessas condições reescreveria a grade com base só no que está nos dois campos visíveis — risco real de descartar a segunda janela ao salvar, dependendo de como `salvarHorario()` monta o payload (a ler no Comando 2, ao implementar a correção).

### 1.7 Assumir / devolver conversa

- `src/dominio/atendimento.js:392-421` (`assumir`) e `424-437` (`liberar`). `assumir` marca `assumida_por_humano: true`, `atribuido_a`, `ia_pausada_ate` opcional, grava mensagem de sistema privada e audita `assumida_por_humano`.
- Mesma limitação do item 1.4: `assumir` impede *novas* chamadas de `responderSePossivel` a partir da próxima leitura de `podeResponder`/`decidirResposta` (que, via `montarContextoMinimo`/`decidirAutomacao`, consulta `assumida_por_humano`), mas não cancela uma entrega já em curso na mesma execução de `responderSePossivel` que começou antes do clique.

### 1.8 Auditoria

- `repositorio.registrarAuditoria` é chamado em cada mudança de estado relevante (atendimento, serena-servico). Rota de leitura: `src/servidor/rotas-auditoria.js` (existência confirmada por grep; não lida linha a linha nesta fase — não fazia parte dos achados críticos e não há indício de causa raiz ali além do já registrado no relatório de auditoria, seção 3.4, sobre lacuna de rastreabilidade de uma alteração de estado sem evento equivalente).

### 1.9 Diagnóstico do canal e laboratório da Serena

- `src/servidor/rotas-diagnostico.js:37-53` — `varrer` monta as sondas: `sondaDoBanco`, `sondaDaFila`, `sondaDoCanal(vinculo)`, `sondaDaSerena`, `sondaDoGoogle`, `sondaDoWorker`.
- `src/dominio/diagnostico-sondas.js:58-68` — `sondaDoCanal(vinculo)` chama `vinculo.estado()`, onde `vinculo` vem de `src/integracoes/openclaw-vinculo.js` (import em `src/servidor/http.js:40`, `criarVinculoDeCanal`) — **isto é OpenClaw, não Evolution.** **Confirmado: o diagnóstico ainda audita a saúde do canal pelo vínculo OpenClaw, sem sonda equivalente para a Evolution API** (sem `apikey`/`apiUrl`/estado da instância Evolution no relatório de diagnóstico).
- `bin/worker-heartbeat.js:1-52` — batimento gravado em `system_heartbeats`. Também centrado em OpenClaw: testa alcançabilidade de `172.17.0.1:18790` (linhas 13, 38) e grava componentes `serena`, `inbox`, `openclaw` (linhas 39-41). **Nenhum componente reporta a saúde da Evolution API** (webhook recente, taxa de erro, última entrega confirmada).
- Laboratório "Testar Serena": `src/servidor/rotas-serena.js:252-294` — `abrirTeste`/`enviarNoTeste`/`lerTeste` dependem de um objeto `conversa` injetado (não lido em detalhe nesta fase); quando ausente, lançam erro com `status = 503` e `codigo: 'canal_nao_configurado'` (linhas 254-259, 269-273). **A causa estrutural do 503 relatado em produção está confirmada no código (o endpoint falha fechado, de propósito, quando o gateway do laboratório não está disponível)** — mas a confirmação de que isso está de fato acontecendo agora em produção (e por que motivo específico o gateway está indisponível) vem do relatório de auditoria externa e não foi reproduzida nesta fase, porque o COMANDO 1 proíbe tocar produção. Front-end: `public/index.html:732,744` (`#teste-reiniciar`, `#teste-enviar`) e `public/app.js:3774-3875` — handlers existem e estão ligados; o problema não é de ligação front-end, é de disponibilidade do gateway no backend.

### 1.10 Worker e heartbeat (lembretes e Google)

- `bin/worker-lembretes.js` — processa a fila de lembretes; usa `configuracao.serena.transporteWhatsapp` (ver 1.5) para decidir a estratégia de IA anexada ao evento de lembrete.
- `bin/worker-google-outbox.js` — sincroniza agenda com Google Calendar (fora do escopo direto da Serena, mapeado apenas para completude do pedido).
- `bin/worker-heartbeat.js` — ver 1.9.

### 1.11 Botões órfãos (confirmados diretamente no HTML)

Busca por `nova-tarefa|nova-conversa|novo-lead` em `public/app.js`: **zero ocorrências.** Confirmado em `public/index.html`:

- linha 217 — `<button type="button" class="primario">Nova tarefa</button>` — sem `id`, sem `data-*`, sem qualquer atributo que um `addEventListener`/delegação de evento no `app.js` possa capturar.
- linha 287 — `<button type="button" class="primario">Nova conversa</button>` (cabeçalho de Conversas) — mesma situação.
- linha 433 — `<button type="button" class="primario">Novo lead</button>` — mesma situação.

Os três batem exatamente com os três botões que o apêndice de matriz classificou como "sem ligação encontrada" (linhas 33, 36, 53 do apêndice). Confirmado independentemente nesta fase, não apenas herdado do relatório.

## 2. Causas raiz — veredito por achado

| # | Achado do enunciado | Veredito | Evidência |
|---|---|---|---|
| 1 | `responderSePossivel` verifica antes de gerar, mas não repete antes de `entregarAoPaciente` | **CONFIRMADO** | `atendimento.js:183-192` (leitura única) vs. `atendimento.js:496-515` (`entregarAoPaciente` sem releitura de estado) |
| 2 | Resposta em geração pode sair depois de Desligar/Pausar/Assumir | **CONFIRMADO** (consequência direta do item 1) | mesma evidência acima |
| 3 | Webhook responde 202 e continua com `setImmediate` | **CONFIRMADO** | `http.js:430-432` + `atendimento.js:143-156` |
| 4 | Trabalho pós-resposta não é fila durável | **CONFIRMADO** | não existe outbox/tabela de trabalho pendente; `setImmediate` é o único mecanismo; nenhuma tabela `automacao_outbox` ou equivalente encontrada em `db/*.sql` (até `030_system_heartbeats.sql`) |
| 5 | Transporte padrão ainda pode apontar para `openclaw_gerencia` | **CONFIRMADO, com nuance** | `.env.exemplo:148`, `config.js:73`; hoje só afeta `worker-lembretes.js`, não o caminho de atendimento — ver 1.5 |
| 6 | Painel e diagnóstico ainda misturam OpenClaw e Evolution | **CONFIRMADO** | `diagnostico-sondas.js:58-68` + `rotas-diagnostico.js:46` usam `vinculo` (OpenClaw); `worker-heartbeat.js` só testa porta OpenClaw; nenhuma sonda de saúde da Evolution |
| 7 | Tela de horário representa mal dois intervalos no mesmo dia | **CONFIRMADO** | `public/app.js:3366-3387`, só `janelas[0]` é editável |
| 8 | 23:59 pode produzir lacuna até 00:00 | **CONFIRMADO** | `serena.js:124-134`, `fim` exclusivo na comparação de minutos |
| 9 | Nova tarefa / Nova conversa / Novo lead sem handler | **CONFIRMADO** | `public/index.html:217,287,433`, zero referências em `app.js` |
| 10 | Laboratório "Testar Serena" com 503 em produção | **ESTRUTURALMENTE CONFIRMADO, ocorrência em produção NÃO reproduzida nesta fase** | `rotas-serena.js:254-259,269-273` lança 503 de propósito quando `!conversa`; a ocorrência ao vivo vem do relatório externo |
| 11 | Histórico de migrations do Supabase não corresponde ao schema real | **NÃO VERIFICADO NESTA FASE** (exige consulta ao Supabase, fora do escopo "sem alterar produção" desta fase — leitura via MCP também não foi autorizada explicitamente para esta etapa) | repositório tem migrations até `db/030_system_heartbeats.sql`; a comparação com o tracker do Supabase (`umvpwqqjzpxwuxdnnxzy`) foi feita pelo relatório externo, não reconferida aqui |

## 3. Arquivos que serão tocados no Comando 2 (lista fechada, para revisão prévia)

Nenhum destes arquivos foi alterado nesta fase. Lista antecipada para o dono do projeto avaliar o raio de impacto antes de autorizar a implementação:

- `src/dominio/atendimento.js` — barreira final antes do envio; idempotência; remoção da dependência de `setImmediate` como garantia.
- `src/servidor/http.js` — gravação do trabalho pendente na mesma transação da entrada (outbox); manter 202 como "persistido", não "vou continuar".
- novo `db/031_*.sql` (outbox) e possível `db/032_*.sql` (correção/idempotência da grade) — aditivos, sem DROP/TRUNCATE.
- novo `bin/worker-outbox.js` (ou extensão de um worker existente) — reivindicação com lease, retry, dead-letter.
- `src/dominio/serena.js` — `dentroDoHorario` (fronteira do fim do intervalo) e `validarAgenda` (permitir e preservar múltiplos intervalos).
- `public/app.js` e `public/index.html` — editor de grade com múltiplos intervalos; ids/handlers para os três botões órfãos (ou remoção deles); atualização do texto desatualizado sobre a Agenda no painel inicial.
- `src/dominio/diagnostico-sondas.js`, `src/servidor/rotas-diagnostico.js` — sonda de saúde da Evolution.
- `bin/worker-heartbeat.js` — componente de heartbeat para a Evolution.
- `.env.exemplo`, `src/config.js` — padrão de `SERENA_TRANSPORTE_WHATSAPP` e validação mais estrita.
- `testes/*.test.js` — novos testes por tarefa (concorrência barreira final, outbox, grade com múltiplos intervalos, botões).

## 4. Plano de 16 frentes (tarefas testáveis, commits independentes)

Cada item abaixo é um commit temático isolado no Comando 2+, com teste que falha antes e passa depois (regra 9 do enunciado). Ordem sugerida por dependência e por risco decrescente.

1. **Barreira final antes do envio.** Releitura de `podeResponder`/`assumida_por_humano`/`ia_pausada_ate` imediatamente antes de `entregarAoPaciente`, com `control_version` crescente carimbado no início do trabalho e comparado no fim; abortar e registrar `envio_abortado_por_controle` se mudou. Teste: pausar/desligar/assumir artificialmente no meio de uma geração lenta (double) e confirmar que nada é entregue.
2. **Controle de respostas em andamento.** Rastrear geração em curso por conversa (para a UI poder mostrar "gerando..." e para a barreira do item 1 ter algo a checar/cancelar).
3. **Outbox durável no Postgres.** Tabela `automacao_outbox` (ou nome equivalente): grava mensagem + trabalho pendente na mesma transação do webhook.
4. **Worker com lease, retry e dead-letter.** `FOR UPDATE SKIP LOCKED`, tentativas com backoff, fila de falha permanente visível no diagnóstico.
5. **Remoção do `setImmediate` como garantia.** O caminho de despacho em segundo plano passa a só enfileirar (outbox), nunca a prometer execução na mesma função serverless.
6. **Idempotência e prevenção de duplicidade.** Chave determinística de entrega ponta a ponta (já existe para geração de resposta; falta para o envio via Evolution, que hoje não tem idempotência nativa — ver 1.4).
7. **Correção da grade e múltiplos intervalos.** `dentroDoHorario`/`validarAgenda` tratando fronteira e o editor em `public/app.js` permitindo e mostrando todos os intervalos salvos.
8. **Unificação na Evolution.** Corrigir o padrão de `SERENA_TRANSPORTE_WHATSAPP`, revisar `Conectar WhatsApp` e `Verificar agora` para refletirem o canal efetivo.
9. **Diagnóstico ponta a ponta.** Sonda de saúde da Evolution (webhook recente, última entrega, erro), heartbeat incluindo Evolution.
10. **Laboratório da Serena.** Investigar e sanar a causa do 503 (dependência do gateway do teste), com teste de disponibilidade explícito.
11. **Botões órfãos.** Implementar ou remover Nova tarefa / Nova conversa / Novo lead; corrigir texto desatualizado da Agenda no painel.
12. **Estado desejado versus estado efetivo.** Exibir os dois separadamente no painel (a mesma comparação que `sondaDaSerena` já calcula, hoje só disponível no diagnóstico).
13. **Migrations e rollback.** Reconciliar o histórico do Supabase com o schema real; toda migration nova aditiva, com rollback documentado.
14. **Observabilidade.** Alertas para webhook 401/500, outbox atrasada, resposta não entregue, worker sem heartbeat.
15. **Testes E2E.** Clique → API → banco → worker → Evolution → confirmação/silêncio, incluindo o cenário de concorrência do item 1.
16. **Rollout gradual e reversão.** Flag/percentual para a barreira final e para a outbox, com caminho de reversão documentado e testado.

## 5. Riscos identificados para o Comando 2

- A barreira final (item 1) muda o caminho mais sensível do sistema (entrega ao paciente); exige teste de concorrência real (não só sequencial) para provar a garantia.
- A outbox (itens 3-5) é uma mudança de schema e de modelo de execução; precisa de plano de rollback e de teste de migração aditiva antes de qualquer aplicação em produção — que continua exigindo autorização expressa do dono do projeto (regra do projeto: migrations em produção não são ação automática).
- A correção da grade (item 7) toca configuração que hoje está em produção com `18:00–23:59`; mudar a semântica de fronteira sem migrar o valor salvo pode inverter o efeito (abrir 1 minuto a mais em vez de fechar). Precisa de decisão explícita: corrigir a função e manter compatibilidade com valores antigos, ou also normalizar o dado salvo.
- Item 11 (botões órfãos) é o menor risco técnico mas tem decisão de produto embutida (implementar vs. remover) — não é só código.
- Item 13 (migrations) não pode ser conduzido com DDL destrutivo; a etapa de reconciliação é só leitura/registro até haver autorização explícita.

## 6. Estado final desta fase

```
$ git status --short
?? docs/superpowers/

$ git status
On branch fix/serena-controle-duravel
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/superpowers/

nothing added to commit but untracked files present (use "git add" to track)
```

O único artefato criado nesta fase é este próprio plano. Nenhum arquivo de código, configuração, migration ou dado foi alterado. **Declaração explícita: produção não foi tocada.** Nenhum `git push`, `merge`, `deploy`, alteração de secret, migration, restart de serviço ou modificação de dado real foi executado. Nenhuma credencial foi lida ou usada. A Serena continua no estado em que estava antes desta fase começar (esta fase não ligou, desligou nem consultou o estado ao vivo da Serena em produção).

## 7. O que este comando NÃO fez (por regra explícita do enunciado)

- Não implementou nenhuma das 16 frentes do plano.
- Não tocou o schema do Supabase (nem leitura de migrations aplicadas — a comparação da seção 2, item 11, é uma lacuna assumida, não uma conclusão fabricada).
- Não reproduziu ao vivo o 503 do laboratório da Serena nem qualquer outro comportamento de produção; o que está confirmado é a causa estrutural no código-fonte, não a reocorrência atual.
- Não abriu PR (o enunciado do Comando 1 não pede — ficará para quando o Comando 2 tiver algo a propor).
