export const meta = {
  name: 'auditoria-integral-crmclinica',
  description: 'Auditoria sistemática somente-leitura do CRM (auth, banco, Evolution/Serena, botoes, senha, chat) + plano de correcao, sem implementar',
  phases: [
    { title: 'Mapear', detail: '7 auditores especializados em paralelo, somente leitura' },
    { title: 'Sintetizar', detail: 'consolida em 3 documentos obrigatorios' },
    { title: 'Validar', detail: 'auditor independente tenta refutar os achados' },
  ],
}

const REGRAS_COMUNS = `
Voce esta auditando o repositorio local do crmclinica (branch fix/auditoria-integral-crm-sem-deploy, ja criada a partir de main, remote confirmado como https://github.com/ebarroso12/crmclinica). Trabalho SOMENTE LEITURA de codigo/config. Se precisar consultar o Supabase real (mesmo projeto de producao, umvpwqqjzpxwuxdnnxzy, nao ha banco de teste separado configurado), so pode ser leitura de catalogo/schema (information_schema, pg_catalog, nomes de tabelas/colunas/constraints/indices, contagens agregadas) - NUNCA senha_hash, NUNCA totp_segredo_cifrado, NUNCA conteudo de mensagens/conversas/contatos, NUNCA cookies/tokens/SMTP_PASS/secrets. Absolutamente proibido: push, PR, merge, deploy, promote/rollback de deployment, restart de servico, alterar dominio, alterar secrets/env da Vercel, aplicar migration real, INSERT/UPDATE/DELETE/DDL no banco real, enviar mensagem real pra Evolution, enviar e-mail real, testar com paciente real, git reset --hard, git clean, checkout destrutivo, force push, trocar/ler senha de usuario real, desabilitar 2FA. Nao aceite verificar/build/lint isolados como prova de comportamento - cite arquivo e linha para cada achado, e diga explicitamente CONFIRMADO (com evidencia/reproducao) vs HIPOTESE (nao verificada) vs REFUTADO.

Contexto ja levantado nesta sessao, que voce deve validar e incorporar (nao redescobrir do zero, mas CONFIRME lendo o codigo voce mesmo antes de aceitar):
- Banco: Supabase project umvpwqqjzpxwuxdnnxzy, host aws-0-ca-central-1.pooler.supabase.com, role crmclinica_app sem DDL.
- Producao: Vercel project prj_xzI7phszOY0yFqH3FjM1sScpJqqJ, dominio crmclinica.edsonbarrosojr.com.br.
- Baseline rodado agora: "npm run verificar" limpo (exit 0). "npm test" com o padrao testes/**/*.test.js: 1092 testes, normalmente 1092/1092 verde; numa das duas rodadas de hoje, testes/inbox-http.test.js falhou quando rodado junto com a suite inteira (31/31 passa isolado) - flaky sob paralelismo, causa ainda nao investigada.
- Achado JA confirmado e JA corrigido (em outra branch separada, fix/p0-ingresso-whatsapp-transacao, NAO mergeada): em src/dados/repositorio.js, a funcao registrarMensagem abria propria conexao (pool.connect()+BEGIN) em vez de reusar contexto.atual()?.client quando chamada dentro de repositorio.comUsuario (caminho real de POST /api/canais/whatsapp/eventos com despachoEmSegundoPlano). Contato/conversa NOVOS (criados na mesma transacao ainda sem commit) ficavam invisiveis pra essa conexao isolada -> INSERT em mensagens batia em mensagens_conversa_id_fkey -> HTTP 500. Reproduzido com teste real contra Postgres (nao repositorio-memoria, que nao tem conexoes/MVCC) em testes/ingresso-whatsapp-transacao.test.js. Contato/conversa ja existentes nao sofriam o problema. Confirme lendo o diff dessa branch (git show fix/p0-ingresso-whatsapp-transacao) e valide se a correcao esta certa e completa, ou se falta algo.
- "Esqueci minha senha": ja existe por completo no codigo (botao no public/index.html, JS em public/app.js, rotas /api/auth/recuperar e /api/auth/redefinir em src/servidor/rotas-autenticacao.js, logica real em src/dominio ou src/seguranca/contas.js). O botao fica ESCONDIDO em producao porque SMTP nao esta configurado na Vercel (configuracao.email.host/remetente vazios -> /api/auth/opcoes retorna recuperacao_por_email:false -> JS esconde o botao). Confirme se o fluxo em si (token, expiracao, hash do token, rate limit, invalidacao de sessao) esta correto olhando o codigo.
- Serena: atualmente com "ativa=false" no banco real (desligada por mim mais cedo hoje, motivo registrado em audit_log, autorizado pelo Edson). NAO reative. Grade/horario tem correcao de multiplos intervalos e lacuna de 23:59 ja feita em commit anterior (8d601fe) - confirme se esta correta.
- Login/2FA: fluxo de login com 2FA obrigatorio confirmado funcionando (senha correta chega a pedir codigo TOTP). Rate limiter por conta (5/15min) e por IP (30/15min) existe em src/seguranca/limite.js.

Escreva achados em texto corrido claro, com caminho:linha para cada afirmacao. Nao invente arquivo/funcao/tabela que nao exista - se nao achar algo mencionado no pedido original, diga explicitamente "nao encontrado".
`

phase('Mapear')
const tarefas = [
  {
    chave: 'auth_senha',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: autenticacao, sessao, autorizacao/RBAC, e o fluxo COMPLETO de "esqueci minha senha" ponta a ponta (rotas-autenticacao.js, contas.js, senha.js, sessoes.js, limite.js, email.js, totp.js, public/index.html + app.js no trecho de login/recuperar/redefinir). Verifique linha por linha: token de recuperacao e aleatorio/curto/uso-unico/com-expiracao? so o HASH do token e persistido? token aparece em algum log (procure console.log/console.error perto do fluxo)? consumo do token e atomico (uma query so, ou ha race condition entre checar-e-marcar-usado)? rate limit cobre pedido de recuperacao E redefinicao? o redirect do link de e-mail e validado por allowlist ou aceita qualquer coisa? sessoes antigas sao invalidadas so apos redefinicao bem-sucedida (nao antes)? resposta publica da rota /api/auth/recuperar realmente nao revela se a conta existe (mesma resposta pros dois casos)? ausencia de SMTP so esconde o botao ou tambem quebra login normal (confirme por leitura, sem tocar em .env real)? Aponte TODOS os botoes relacionados a autenticacao (login, sair, esqueci senha, redefinir, trocar senha, 2FA) com seletor/ID, handler, endpoint, e se tem protecao contra duplo-clique. Liste tambem toda rota HTTP de auth com metodo e arquivo:linha.`,
  },
  {
    chave: 'webhook_outbox_serena',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: entrada do webhook Evolution ate a barreira final de envio (src/servidor/http.js rota /api/canais/whatsapp/eventos, src/integracoes/evolution-webhook.js, src/dominio/atendimento.js, src/dominio/automacao-outbox.js e automacao-outbox-servico.js, bin/worker-outbox.js, src/integracoes/evolution-envio.js, src/integracoes/canal-conversas.js). Confirme a autenticacao/assinatura do webhook (HMAC, token alternativo da Evolution) e resistencia a replay. Mapeie exatamente: persistencia da mensagem -> criacao da conversa -> decisao podeResponder -> geracao pela IA -> barreira final antes do envio -> envio Evolution -> fallback OpenClaw. Para a barreira final: ela realmente reconsulta o banco (Serena ligada, pausa, agenda, plantao, conversa assumida/resolvida) IMEDIATAMENTE antes do envio, ou so uma vez no inicio do processamento? uma resposta em geracao pode sair depois de Desligar/Pausar/Assumir? Verifique a hipotese transacional do enunciado (registrarMensagem vs contexto.atual()?.client dentro de comUsuario) MESMO SABENDO que ja foi corrigida numa branch separada - confirme a causa raiz e valide se o fix (branch fix/p0-ingresso-whatsapp-transacao) resolve tudo ou deixa algo de fora (ex: outros metodos do repositorio com o mesmo padrao de pool.connect() isolado dentro de transacao ambiente - procure por outras ocorrencias de "pool.connect()" no arquivo). Investigue duplicidade: idempotencia do id_externo de entrada, idempotencia da operacao de saida, lease do worker (dono, expiracao, fencing), retry/backoff/dead-letter, o que acontece com um job cuja entrega ficou "indeterminado"/incerta.`,
  },
  {
    chave: 'banco_migrations',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: banco de dados. Leia TODAS as migrations em db/*.sql (arquivos locais, sem conectar em nada) e monte o schema esperado: tabelas, colunas, tipos, NOT NULL, defaults, PKs, FKs (principalmente mensagens_conversa_id_fkey e afins), constraints unique, indices, triggers, RLS/policies, SECURITY DEFINER. Depois, com uma conexao SOMENTE LEITURA ao Supabase real (variavel CRMCLINICA_DATABASE_URL do .env local, ja configurada) faca so consultas de CATALOGO (information_schema.columns, information_schema.table_constraints, pg_indexes, pg_policies, e a tabela de historico de migrations tipo supabase_migrations.schema_migrations se existir) - NUNCA leia linha de dado de negocio (mensagens, contatos, usuarios). Compare: o schema real bate com o que as migrations locais descrevem? o historico de migrations aplicadas (schema_migrations) inclui os arquivos 019 a 032, ou para antes disso (isso e uma hipotese que precisa ser confirmada ou refutada com evidencia real, nao assumida)? existe alguma tabela/coluna que o schema real tem mas nenhuma migration local explica (drift)? Verifique tambem: indices realmente existem para as colunas usadas em WHERE frequentes (id_externo, conversa_id, status de outbox); constraint de unicidade em id_externo de mensagens e de automacao_outbox. Nao corrija nada, so relate com evidencia (query e resultado resumido, sem dado sensivel).`,
  },
  {
    chave: 'botoes_ui',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: inventario de TODOS os elementos acionaveis da interface. Leia public/index.html (todo o arquivo) e public/app.js (todo o arquivo) e monte uma tabela texto: para cada botao/form/acao (Ligar Serena, Desligar, Pausar, Retomar, Parada de emergencia, Assumir, Devolver, Resolver, Reabrir, Enviar mensagem, Nova conversa, Novo lead, Nova tarefa, Salvar agenda, Testar Serena, Verificar canal, Conectar WhatsApp, Login, Sair, Esqueci minha senha, Redefinir senha, e qualquer outro que encontrar) informe: id/seletor, o que o texto promete, se tem addEventListener/handler real no app.js (cite a linha), qual endpoint chama (metodo+rota), se tem protecao contra duplo clique (disable do botao durante fetch, flag de loading), o que acontece em erro (mostra mensagem ou falha silenciosa), e se ha teste (grep em testes/ por trecho relacionado, ex: testes/botoes-orfaos.test.js). Marque explicitamente todo botao que tem texto/ID no HTML mas NENHUM listener correspondente no JS - isso e um defeito, nao invente que "deve ter" handler em algum lugar sem achar a linha exata.`,
  },
  {
    chave: 'chat_ao_vivo',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: atualizacao do chat/inbox no navegador em tempo real. Leia a rota de eventos (procure "/api/conversas/eventos" em src/servidor/http.js - SSE, polling, ou outro mecanismo), o emissor de eventos (grep por "publicarMensagem" e o modulo que implementa isso), e o lado do cliente em public/app.js (EventSource ou fetch polling). Responda com evidencia: os eventos dependem so de um emitter em memoria do processo (o que quebraria com 2 instancias serverless ao mesmo tempo, ou perderia eventos entre requests de uma funcao serverless que morre)? existe cursor/ID persistente pra reconexao recuperar o que perdeu, ou reconectar so traz eventos novos dali pra frente, perdendo o que passou enquanto caiu? o evento e emitido so depois do commit da transacao no banco, ou antes (risco de mostrar algo que pode dar rollback)? tem deduplicacao no cliente se o mesmo evento chegar duas vezes? tem heartbeat pra saber que a conexao ainda esta viva? Teste real localmente subindo o servidor (bin ou npm run iniciar) contra repositorio em memoria se possivel, simulando 2 mensagens seguidas, e reporte o que observou de verdade, nao so leitura de codigo.`,
  },
  {
    chave: 'seguranca_interferencia',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: seguranca (SQL injection, XSS, CSRF, enumeracao de usuario, exposicao de token/secret em log) e protecao contra multiplos escritores conflitantes. Procure em todo o codigo (grep) por concatenacao de string em SQL fora dos $1/$2 parametrizados (risco de injection), por innerHTML/insertAdjacentHTML sem sanitizacao em public/app.js (risco de XSS refletido de dados vindos do backend, ex nome de contato/mensagem), por log de senha/token/segredo (grep -i "console.log.*senha\\|console.log.*token\\|console.log.*secret" em src/). Verifique enumeracao de usuario: as respostas de login, cadastro e recuperacao de senha realmente sao identicas pra conta existente vs inexistente (compare o texto e o status HTTP exatos)? Mapeie todo processo que pode ESCREVER em conversas/mensagens/serena_configuracao (webhook, worker outbox, painel via API, scripts em bin/, openclaw) e se cada acao tem autor/origem/correlation-id/timestamp registrado em audit_log ou equivalente. Confirme se a Serena realmente para de responder depois de "Assumir" (nao so na interface, no worker tambem) - aponte a linha exata que checa isso antes do envio.`,
  },
  {
    chave: 'baseline_arquitetura',
    prompt: `${REGRAS_COMUNS}\n\nSUA FRENTE: baseline formal e mapa geral de arquitetura, para abrir o relatorio. Rode e registre (comando, saida resumida, codigo de saida): "git remote get-url origin", "git branch --show-current", "git rev-parse HEAD", "git status --short", "git worktree list", "node --version", "npm --version", "git log --oneline -20". Liste todos os scripts de package.json e diga quais existem de fato (verificar, test, lint, typecheck, build, integracao, e2e, audit de dependencias) - se algum desses NAO existir como script separado, diga explicitamente "nao existe script de X". Depois monte o mapa geral com arquivo:linha para: inicializacao do servidor (src/index.js ou api/index.js), middleware principal, tabela de rotas HTTP completa (todas, nao so as de auth/webhook - varra src/servidor/*.js), liga/desliga/pausa/plantao da Serena (src/dominio/serena-servico.js), agenda, diagnostico (src/dominio/diagnostico*.js), laboratorio "Testar Serena", heartbeat. Nao repita o que as outras frentes ja cobrem em detalhe, so garanta que TODO arquivo em src/servidor/ e src/dominio/ apareca no mapa geral com uma linha dizendo o que faz.`,
  },
]

const achados = await parallel(tarefas.map((t) => () => (
  agent(t.prompt, { label: `auditor:${t.chave}`, phase: 'Mapear' }).then((texto) => ({ chave: t.chave, texto }))
)))

log(`7 frentes de auditoria concluidas: ${achados.filter(Boolean).map((a) => a.chave).join(', ')}`)

phase('Sintetizar')
const relatorio = await agent(`${REGRAS_COMUNS}

Voce e o auditor SINTETIZADOR. Recebeu abaixo os achados de 7 auditores especializados (auth/senha, webhook/outbox/Serena, banco/migrations, botoes UI, chat ao vivo, seguranca/interferencia, baseline/arquitetura). Sua tarefa e consolidar tudo em TRES arquivos markdown, usando a ferramenta Write, exatamente nestes caminhos:

1. docs/auditorias/2026-08-14-auditoria-integral-crm.md
2. docs/superpowers/specs/2026-08-14-confiabilidade-crm-design.md
3. docs/superpowers/plans/2026-08-14-confiabilidade-crm.md

O documento 1 (auditoria) precisa ter: resumo executivo; mapa da arquitetura; achados por gravidade (P0/P1/P2), cada um com evidencia arquivo:linha, reproducao (quando houver), causa raiz; matriz completa de botoes; auditoria do banco (schema vs migrations vs real); riscos; drift de migrations; secao "itens CONFIRMADOS" separada de "hipoteses NAO confirmadas"; lista exata de arquivos que precisariam mudar pra cada achado.

O documento 2 (design) descreve a arquitetura-alvo pros pontos P0/P1: transacao unica pra conversa/mensagem/outbox, barreira final revalidada, idempotencia efetivamente-uma-vez, lease com fencing, chat ao vivo durável, fluxo de recuperacao de senha completo.

O documento 3 (plano) separa em commits locais testaveis e numerados (transacao conversa/mensagem, barreira final Serena, cancelamento de geracoes, idempotencia de entrada, outbox, worker/lease/fencing, retry/dead-letter, prevencao de duplicidade, canal Evolution, chat ao vivo, recuperacao de senha, botoes, agenda, estado desejado x efetivo, migrations/rollback, seguranca/RLS, observabilidade, integracao, E2E, rollout/reversao futuros) - pra CADA item, diga se ja esta feito (cite a branch fix/p0-ingresso-whatsapp-transacao onde aplicavel), se e so plano, e qual seria o teste que prova a correcao.

Regra inegociavel: nao promova NADA de "hipotese" pra "confirmado" sem a evidencia que os auditores realmente trouxeram. Se um auditor nao confirmou algo, o documento tem que dizer "nao confirmado nesta rodada", nao inventar.

--- ACHADOS DOS 7 AUDITORES ---

${achados.filter(Boolean).map((a) => `\n\n### Frente: ${a.chave}\n\n${a.texto}`).join('\n')}
`, { label: 'sintetizador', phase: 'Sintetizar', effort: 'high' })

log('Documentos de auditoria/design/plano escritos. Iniciando validacao independente.')

phase('Validar')
const validacao = await agent(`${REGRAS_COMUNS}

Voce e o AUDITOR INDEPENDENTE final. NAO EDITE NENHUM ARQUIVO DE CODIGO. Sua unica tarefa e revisar os 3 documentos que acabaram de ser escritos:
1. docs/auditorias/2026-08-14-auditoria-integral-crm.md
2. docs/superpowers/specs/2026-08-14-confiabilidade-crm-design.md
3. docs/superpowers/plans/2026-08-14-confiabilidade-crm.md

Leia os 3 por completo. Para CADA achado marcado como "CONFIRMADO", tente ativamente refuta-lo: abra o arquivo:linha citado e confira se realmente diz o que o documento afirma. Rode voce mesmo qualquer teste que o documento alega ter rodado, pra ver se da o mesmo resultado. Marque cada achado como: CONFIRMA (voce verificou e concorda), REFUTA (voce verificou e o achado esta errado ou exagerado - explique por que), ou SEM PROVA SUFICIENTE (o achado nao tem evidencia concreta o bastante pra ser "confirmado", deveria ter sido rotulado hipotese). Verifique tambem se o relatorio esconde algum teste vermelho, se algum "corrigido" na verdade nao tem teste provando, e se a declaracao final de "producao nao foi alterada" e verdadeira (rode "git status --short" e "git log origin/main..HEAD --oneline" pra confirmar que so a branch local fix/auditoria-integral-crm-sem-deploy tem commits novos, main/origin nao mudaram).

Ao final, se encontrar problemas reais nos documentos (afirmacao sem prova, contradicao, achado exagerado), edite APENAS os 3 documentos markdown para corrigir/marcar isso (nunca codigo-fonte da aplicacao). Devolva um resumo curto: quantos achados confirmou, quantos refutou (com motivo), quantos rebaixou pra "sem prova suficiente", e se a declaracao de "nada em producao mudou" se sustenta.
`, { label: 'auditor-independente', phase: 'Validar', effort: 'high' })

log('Validacao independente concluida.')

return { achados: achados.map((a) => a?.chave), relatorio, validacao }
