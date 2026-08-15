'use strict';

// Serviço da outbox: reivindicação exclusiva, lease, retry com backoff,
// dead-letter com escalonamento, idempotência do enfileiramento, e a prova de
// que a barreira de controle do Comando 2 vale também para o trabalho
// processado pelo worker — não só para o caminho síncrono.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { criarServicoDeOutbox } = require('../src/dominio/automacao-outbox-servico');
const { LEASE_MS } = require('../src/dominio/automacao-outbox');

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:outbox:1',
  remetente: '5516999999999',
  nome: 'Marina Souza',
  texto: 'Quero saber sobre a primeira consulta',
});

function canalFalso({ comportamento = 'sucesso' } = {}) {
  const envios = [];
  let chamadas = 0;
  return {
    envios,
    // Chamadas != envios: `indeterminado` e `falha_definitiva` NUNCA empurram
    // para `envios` (representam uma tentativa que não sabemos se saiu, ou
    // que sabemos que não saiu) — mas ainda assim CHAMARAM `canal.enviar`.
    // Testes que provam "não tentou de novo" precisam do contador de
    // chamadas, não do array de sucesso.
    get chamadas() { return chamadas; },
    async enviar(carga) {
      chamadas += 1;
      if (comportamento === 'sucesso') {
        envios.push(carga);
        return { identificador: 'wa-saida-1' };
      }
      if (comportamento === 'falha_definitiva') {
        throw new Error('Evolution API respondeu HTTP 500');
      }
      if (comportamento === 'indeterminado') {
        const erro = new Error('falha de rede ao chamar a Evolution API: The operation was aborted');
        erro.indeterminado = true;
        throw erro;
      }
      throw new Error(`comportamento desconhecido: ${comportamento}`);
    },
  };
}

/**
 * Monta conversa + mensagem de entrada, sem processar nada ainda.
 *
 * `overrides` permite montar VÁRIAS conversas distintas no mesmo
 * repositório (Comando 7, segunda auditoria, achado N-9: o teste de lote
 * precisa de N conversas reais para provar reivindicação em lote de
 * verdade) — sem isso, chamar duas vezes com o mesmo `id_externo`/`remetente`
 * cairia no caminho de idempotência e reaproveitaria a MESMA conversa.
 */
async function prepararConversa(repositorio, overrides = {}) {
  const atendimentoDeSetup = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } },
  });
  // `estrategia_ia: 'openclaw_gerencia'` faz `receberMensagem` gravar a
  // conversa/mensagem e voltar ANTES de decidir automação nenhuma — sem isso,
  // com o Comando 7 / achado A-2 (sem orquestrador configurado agora
  // escalona de verdade), este setup marcaria a conversa como
  // `assumida_por_humano`, e os testes que processam o trabalho de verdade
  // logo depois encontrariam a barreira já fechada por engano.
  const resultado = await atendimentoDeSetup.receberMensagem({
    ...EVENTO, estrategia_ia: 'openclaw_gerencia', ...overrides,
  });
  const conversa = await repositorio.obterConversa(resultado.conversa_id);
  const [mensagemEntrada] = await repositorio.listarMensagens(conversa.id);
  return { conversa, mensagemEntrada };
}

// ------------------------------------------------------------- idempotência

test('enfileirar duas vezes para a mesma conversa e mensagem não cria dois trabalhos', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);

  const primeiro = await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });
  const segundo = await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  assert.equal(primeiro.criado, true);
  assert.equal(segundo.criado, false);
  assert.equal(primeiro.trabalho.id, segundo.trabalho.id);

  const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
  assert.equal(fila.pendente, 1);
});

// ---------------------------------------------------------- exclusão entre workers

test('dois workers reivindicando ao mesmo tempo não pegam o mesmo trabalho', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await repositorio.enfileirarTrabalhoDeOutbox({
    conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id, chaveIdempotencia: 'outbox:teste:1',
  });

  const agora = new Date().toISOString();
  const peloWorkerA = await repositorio.reivindicarTrabalhosDeOutbox({ agora, limite: 20, worker: 'worker-a' });
  const peloWorkerB = await repositorio.reivindicarTrabalhosDeOutbox({ agora, limite: 20, worker: 'worker-b' });

  assert.equal(peloWorkerA.length, 1, 'o primeiro worker reivindica o único trabalho pendente');
  assert.equal(peloWorkerB.length, 0, 'o segundo worker não pode reivindicar o que já foi pego');
  assert.equal(peloWorkerA[0].reivindicado_por, 'worker-a');
});

// ----------------------------------------------------------------- posse (fencing)
//
// A prova PRINCIPAL da posse (migration 033, `posse_token`) roda contra
// PostgreSQL real em testes/outbox-fencing-pg.test.js — é lá que a guarda de
// SQL é o que importa. Este teste fecha uma lacuna que a auditoria
// independente desta sessão encontrou: nenhum teste exercitava o caminho
// `perdeuPosse` DENTRO do serviço (`processarUm`, automacao-outbox-servico.js)
// nem as guardas equivalentes do repositório EM MEMÓRIA
// (repositorio-memoria.js) — só a versão contra Postgres tinha prova.

test('worker que perdeu a posse: processarUm devolve posse_perdida e audita, sem sobrescrever quem venceu (repositório em memória)', async () => {
  let agoraSimulado = new Date('2026-08-13T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => agoraSimulado });
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, agora: () => agoraSimulado });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  const [paraA] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: agoraSimulado.toISOString(), limite: 20, worker: 'worker-A',
  });
  const tokenDeA = paraA.posse_token;
  assert.equal(tokenDeA, 1, 'primeira reivindicação leva a posse ao token 1');

  // O lease de A vence — mesma simulação de tempo do teste de recuperarPresos acima.
  agoraSimulado = new Date(agoraSimulado.getTime() + LEASE_MS + 60 * 1000);
  const liberados = await outbox.recuperarPresos();
  assert.equal(liberados.length, 1, 'o trabalho preso precisa ter voltado à fila');

  const [paraB] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: agoraSimulado.toISOString(), limite: 20, worker: 'worker-B',
  });
  assert.ok(paraB, 'B precisa ter reivindicado o trabalho liberado');
  assert.ok(paraB.posse_token > tokenDeA, 'a nova posse precisa ter token maior que a de A');

  // A volta (alheio a tudo) com o token velho. `processarUm` ainda ENVIA — a
  // barreira de posse protege só a ESCRITA do desfecho, não o envio em si
  // (ver o comentário no início de `processarUm`, automacao-outbox-servico.js)
  // — mas não pode sobrescrever o registro de quem já assumiu.
  const resultado = await outbox.processarUm(paraA, { worker: 'worker-A', posseToken: tokenDeA });
  assert.equal(resultado.status, 'posse_perdida');
  assert.equal(resultado.trabalho, null);

  assert.ok(
    repositorio._auditoria.some((r) => r.acao === 'outbox_posse_perdida' && r.entidadeId === paraA.id),
    'a perda de posse precisa ficar auditada — é como a equipe descobre, sem log manual',
  );

  // O registro real continua com B, intocado pela tentativa de A.
  const registro = await repositorio.obterTrabalhoDeOutbox(paraA.id);
  assert.equal(registro.reivindicado_por, 'worker-B');
  assert.equal(registro.posse_token, paraB.posse_token);
});

// --------------------------------------------------------------- lease e recuperação

test('trabalho preso além do lease volta para a fila (e conta como tentativa)', async () => {
  let agoraSimulado = new Date('2026-08-13T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => agoraSimulado });
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, agora: () => agoraSimulado });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  const { trabalho } = await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  // Um worker reivindica e "morre" — nunca conclui.
  await repositorio.reivindicarTrabalhosDeOutbox({ agora: agoraSimulado.toISOString(), limite: 20, worker: 'worker-morto' });

  // Tempo passa, além do lease (Comando 7, achado M-1: relativo a LEASE_MS,
  // não a um número fixo — a folga muda se o lease mudar).
  agoraSimulado = new Date(agoraSimulado.getTime() + LEASE_MS + 60 * 1000);

  const liberados = await outbox.recuperarPresos();
  assert.equal(liberados.length, 1);
  assert.equal(liberados[0].id, trabalho.id);
  assert.equal(liberados[0].status, 'pendente');
  assert.equal(liberados[0].tentativas, 1);

  const registro = await repositorio.obterTrabalhoDeOutbox(trabalho.id);
  assert.equal(registro.reivindicado_por, null, 'o lease velho não pode continuar valendo');
});

test('trabalho preso repetidas vezes esgota as tentativas e vai para dead-letter, com escalonamento', async () => {
  let agoraSimulado = new Date('2026-08-13T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => agoraSimulado });
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, agora: () => agoraSimulado, maxTentativas: 2 });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await repositorio.enfileirarTrabalhoDeOutbox({
    conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id, chaveIdempotencia: 'outbox:dead:1', maxTentativas: 2,
  });

  // Duas rodadas de "reivindicar e morrer" esgotam max_tentativas = 2.
  for (let volta = 0; volta < 2; volta += 1) {
    await repositorio.reivindicarTrabalhosDeOutbox({ agora: agoraSimulado.toISOString(), limite: 20, worker: `worker-${volta}` });
    agoraSimulado = new Date(agoraSimulado.getTime() + LEASE_MS + 60 * 1000);
    await outbox.recuperarPresos();
  }

  const registro = (await repositorio.contarTrabalhosDeOutboxPorEstado());
  assert.equal(registro.morto, 1);
  assert.equal(registro.pendente, 0);

  const conversaDepois = await repositorio.obterConversa(conversa.id);
  assert.equal(conversaDepois.assumida_por_humano, true, 'dead-letter tem que escalonar para a equipe');
  assert.ok(repositorio._auditoria.some((r) => r.acao === 'escalonada' && r.entidadeId === conversa.id));
  assert.ok(repositorio._auditoria.some((r) => r.acao === 'outbox_morto'));
});

// ----------------------------------------------------------------------- backoff

test('processarUm com falha transitória agenda a próxima tentativa com backoff crescente', async () => {
  const inicio = new Date('2026-08-13T10:00:00.000Z');
  let agoraSimulado = inicio;
  const repositorio = criarRepositorioEmMemoria({ agora: () => agoraSimulado });

  let chamadas = 0;
  const repositorioInstavel = {
    ...repositorio,
    async obterConversa() {
      chamadas += 1;
      throw new Error('banco piscou');
    },
  };
  const atendimento = criarAtendimento({ repositorio: repositorioInstavel, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, agora: () => agoraSimulado });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  const [reivindicado] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: agoraSimulado.toISOString(), limite: 1, worker: 'w',
  });
  const resultado1 = await outbox.processarUm(reivindicado);
  assert.equal(resultado1.status, 'pendente');
  assert.equal(resultado1.trabalho.tentativas, 1);
  const atraso1 = new Date(resultado1.trabalho.disponivel_em).getTime() - agoraSimulado.getTime();
  assert.equal(atraso1, 5000, 'primeira retentativa: base (5s)');

  // O relógio avança até (pelo menos) a hora agendada da retentativa — sem
  // isso a reivindicação não encontraria o trabalho, e estaria certa em não
  // encontrar: backoff existe para NÃO tentar de novo antes da hora.
  agoraSimulado = new Date(resultado1.trabalho.disponivel_em);

  const [reivindicado2] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: agoraSimulado.toISOString(), limite: 1, worker: 'w',
  });
  assert.ok(reivindicado2, 'o trabalho tem que estar disponível assim que a hora do backoff chega');
  const resultado2 = await outbox.processarUm(reivindicado2);
  assert.equal(resultado2.trabalho.tentativas, 2);
  const atraso2 = new Date(resultado2.trabalho.disponivel_em).getTime() - agoraSimulado.getTime();
  assert.equal(atraso2, 10000, 'segunda retentativa: dobra (10s)');

  assert.ok(chamadas >= 2);
});

test('retentar antes da hora do backoff não encontra o trabalho', async () => {
  const agora = new Date('2026-08-13T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => agora });
  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await repositorio.enfileirarTrabalhoDeOutbox({
    conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id, chaveIdempotencia: 'outbox:cedo:1',
  });
  await repositorio.concluirTrabalhoDeOutbox(1, {
    status: 'pendente', tentativas: 1, disponivelEm: new Date(agora.getTime() + 5000).toISOString(),
  });

  const reivindicados = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: agora.toISOString(), limite: 20, worker: 'w',
  });
  assert.equal(reivindicados.length, 0, 'ainda não é hora — o backoff precisa ser respeitado');
});

// ------------------------------------------------------- entrega incerta

test('entrega com desfecho incerto (timeout) nunca é retentada automaticamente', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso({ comportamento: 'indeterminado' });
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá!' }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: new Date().toISOString(), limite: 1, worker: 'w',
  });
  const resultado = await outbox.processarUm(trabalho);

  assert.equal(resultado.status, 'incerto');
  assert.equal(canal.envios.length, 0, 'o único envio tentado foi o que já falhou como indeterminado');

  const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
  assert.equal(fila.incerto, 1);
  assert.equal(fila.pendente, 0, 'não pode voltar pendente — isso permitiria uma retentativa automática');

  // A conversa já foi escalonada pelo próprio atendimento (ver atendimento.js).
  const conversaDepois = await repositorio.obterConversa(conversa.id);
  assert.equal(conversaDepois.assumida_por_humano, true);
});

// ---------------------------------------------- reenvio de resposta já entregue
//
// Migration 038, achado real desta sessão (não hipótese): o trabalho que já
// entregou a resposta pode voltar para "processando de novo" — o banco pisca
// entre enviar e concluir, ou o processo morre sem desligamento gracioso — e
// o próximo ciclo relia (`respostaAnterior`, atendimento.js) sem checar se já
// tinha sido entregue. Estes dois testes reproduzem exatamente isso, sem
// mexer no worker nem no lease: chamam `responderSePossivel` uma SEGUNDA vez
// para o mesmo par (conversa, mensagem de entrada) — é o que a fila faz
// sozinha quando reivindica de novo um trabalho "abandonado".

test('resposta já entregue não é reenviada quando responderSePossivel roda de novo para o mesmo inbound', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso({ comportamento: 'sucesso' });
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá! Temos horários esta semana.' }) },
  });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);

  const primeira = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: mensagemEntrada.id });
  assert.equal(primeira.acao, 'respondida_pela_automacao');
  assert.equal(canal.envios.length, 1, 'a primeira chamada precisa ter enviado');

  // "O trabalho voltou à fila depois de já ter entregado" — simulado chamando
  // de novo, exatamente como um worker que reivindicou o trabalho "abandonado"
  // faria ao processá-lo mais uma vez.
  const segunda = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: mensagemEntrada.id });

  assert.equal(canal.envios.length, 1, 'a segunda chamada NÃO pode ter enviado de novo — o paciente já recebeu');
  assert.equal(segunda.acao, 'respondida_pela_automacao');
  assert.equal(segunda.duplicada, true);
  assert.equal(segunda.entregue, true, 'precisa reportar que já está entregue, sem fingir que não sabe');
});

test('resposta com entrega indeterminada não é reenviada na segunda chamada', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso({ comportamento: 'indeterminado' });
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá!' }) },
  });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);

  const primeira = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: mensagemEntrada.id });
  assert.equal(primeira.acao, 'escalonada_por_falha_entrega');
  assert.equal(primeira.entregaIncerta, true);
  assert.equal(canal.chamadas, 1, 'a única tentativa é a que ficou indeterminada');

  // A própria escalação da primeira chamada já marca a conversa como
  // `assumida_por_humano` (achado A-2, ver teste "entrega com desfecho
  // incerto" acima) — isso, sozinho, já barra uma automação de responder de
  // novo. Para provar que o *migration 038* (marcar a entrega indeterminada
  // na própria mensagem) é quem protege depois que a equipe devolve a
  // conversa — cenário real: humano viu o aviso, devolveu para a fila
  // automática sem responder — simulamos exatamente essa devolução aqui.
  // Sem a checagem de `entrega_indeterminada` em `respostaAnterior`
  // (atendimento.js), este segundo `responderSePossivel` tentaria reenviar.
  await repositorio.atualizarConversa(conversa.id, { assumida_por_humano: false });

  const segunda = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: mensagemEntrada.id });

  assert.equal(canal.chamadas, 1, 'entrega indeterminada nunca é retentada automaticamente — nem depois que a equipe devolve a conversa');
  assert.equal(segunda.acao, 'escalonada_por_falha_entrega');
  assert.equal(segunda.motivo, 'entrega_indeterminada');
  assert.equal(segunda.entregaIncerta, true);
  assert.equal(segunda.entregue, false);
});

// ----------------------------------------------------- Comando 7, achado A-2
//
// Antes: um trabalho processado sem o orquestrador configurado voltava como
// `sem_orquestrador`, `decidirDesfecho` tratava isso como "resolvido" (correto
// — não é uma falha transitória, retentar não ajudaria) e a outbox marcava
// `concluido` SEM que `atendimento` tivesse escalonado nada. Resultado:
// paciente sem resposta, conversa "aberta" sem dono, trabalho "concluído" —
// nada gritava. Este teste prova, pelo caminho real do worker (não pelo
// atalho de teste de atendimento.test.js), que agora a escalação acontece.

test('trabalho processado sem orquestrador configurado escalona para a equipe e conclui — não fica silencioso', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: new Date().toISOString(), limite: 1, worker: 'w',
  });
  const resultado = await outbox.processarUm(trabalho);

  // O trabalho está mesmo resolvido — não é caso de retentativa (a config não
  // vai se consertar sozinha entre uma tentativa e outra).
  assert.equal(resultado.status, 'concluido');
  assert.equal(resultado.acao, 'escalonada_para_equipe');

  // Mas a equipe FOI avisada: é essa a diferença do achado A-2.
  const conversaDepois = await repositorio.obterConversa(conversa.id);
  assert.equal(conversaDepois.assumida_por_humano, true, 'sem isso, ninguém sabe que o paciente ficou sem resposta');
});

// -------------------------------------------------- barreira de controle (Comando 2)

test('Serena desligada enquanto o trabalho espera na fila cancela a entrega quando o worker processa', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, serena, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá!' }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  // "A espera": o trabalho fica pendente na fila por um tempo antes de o
  // worker rodar — é exatamente aí, no mundo real, que a equipe clica em
  // Desligar.
  await serena.definirAtiva(false, { motivo: 'teste: desligar durante a espera', usuarioId: null });

  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: new Date().toISOString(), limite: 1, worker: 'w',
  });
  const resultado = await outbox.processarUm(trabalho);

  assert.equal(canal.envios.length, 0, 'nada pode ter sido enviado ao paciente');
  assert.equal(resultado.status, 'concluido', 'a barreira funcionando é um desfecho resolvido, não uma falha');
  assert.equal(resultado.acao, 'aguardando_equipe');
});

test('conversa assumida enquanto o trabalho espera na fila cancela a entrega', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá!' }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  await atendimento.assumir(conversa.id, null);

  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: new Date().toISOString(), limite: 1, worker: 'w',
  });
  const resultado = await outbox.processarUm(trabalho);

  assert.equal(canal.envios.length, 0);
  assert.equal(resultado.status, 'concluido');
  assert.equal(resultado.acao, 'aguardando_equipe');
});

// ---------------------------------------------------------------- processarLote

test('processarLote reivindica, processa e resume os desfechos de um ciclo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Olá! Posso ajudar?' }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });

  const resultado = await outbox.processarLote({ limite: 20, worker: 'w' });

  assert.equal(resultado.reivindicados, 1);
  assert.equal(resultado.concluidos, 1);
  assert.equal(canal.envios.length, 1);

  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.ok(mensagens.some((m) => m.direcao === 'saida' && m.autor_tipo === 'automacao'));
});

// ------------------------------------------------------ Comando 7, achado N-9
//
// Segunda auditoria independente: `reivindicarTrabalhosDeOutbox` carimba
// `reivindicado_em` com UM ÚNICO instante para o lote inteiro, mas
// `processarLote` processa serialmente. Com trabalhos que levam perto do
// pior caso documentado (~75s cada — ver LEASE_MS em automacao-outbox.js)
// e um lote grande o bastante, o carimbo do lote todo já pode estar vencido
// antes mesmo de o último trabalho começar a ser processado — e uma
// varredura concorrente (`recuperarPresos`, rodando em outro worker de
// verdade em produção) devolveria esse trabalho À FILA enquanto ele ainda
// está em voo. Dois workers tentando entregar a MESMA resposta ao mesmo
// tempo é exatamente o risco que o M-1 original corrigiu para o caso de
// UM trabalho — este é o mesmo risco, mas no nível do LOTE.
test('N-9: cada trabalho renova o próprio lease ao começar a ser processado — uma varredura concorrente não pode reivindicar de volta um trabalho em voo', async () => {
  let agoraSimulado = new Date('2026-08-13T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => agoraSimulado });
  const canal = canalFalso();

  // Cinco conversas distintas, cinco trabalhos, todos reivindicados no
  // MESMO instante por um único processarLote — exatamente como
  // reivindicarTrabalhosDeOutbox carimba um lote de verdade.
  const N = 5;
  // Um pouco acima do pior caso documentado (~75s) para garantir margem
  // estrita sobre o corte de LEASE_MS ao somar as N-1 chamadas anteriores.
  const TEMPO_POR_TRABALHO_MS = 80 * 1000;
  const idsDosTrabalhos = [];
  for (let i = 0; i < N; i += 1) {
    const { conversa, mensagemEntrada } = await prepararConversa(repositorio, {
      id_externo: `wa:outbox:n9:${i}`,
      remetente: `55169999900${i}`,
    });
    const { trabalho } = await repositorio.enfileirarTrabalhoDeOutbox({
      conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id, chaveIdempotencia: `outbox:n9:${i}`,
    });
    idsDosTrabalhos.push(trabalho.id);
  }

  let chamada = 0;
  let outboxRef;
  let estadoDoUltimoTrabalhoNaVarreduraConcorrente = null;
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: {
      disponivel: true,
      async despacharEvento() {
        chamada += 1;
        if (chamada === N) {
          // No exato início do processamento do ÚLTIMO trabalho do lote —
          // ele acabou de ter o PRÓPRIO lease renovado por processarLote,
          // um instante antes desta chamada —, uma varredura concorrente
          // roda (o equivalente a outro worker chamando recuperarPresos ao
          // mesmo tempo). Sob o carimbo por LOTE antigo, as N-1 chamadas
          // anteriores (80s cada) já teriam somado tempo suficiente para
          // vencer o lease a partir do carimbo original do lote inteiro.
          await outboxRef.recuperarPresos();
          estadoDoUltimoTrabalhoNaVarreduraConcorrente = await repositorio.obterTrabalhoDeOutbox(
            idsDosTrabalhos.at(-1),
          );
        }
        // Avança o relógio simulando o tempo real de processamento de CADA
        // trabalho — é a soma dessas N-1 chamadas que, sem a renovação por
        // trabalho, deixaria o carimbo único do lote vencido bem antes do
        // último trabalho começar.
        agoraSimulado = new Date(agoraSimulado.getTime() + TEMPO_POR_TRABALHO_MS);
        return { resposta: 'Olá! Posso ajudar?' };
      },
    },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, agora: () => agoraSimulado });
  outboxRef = outbox;

  const resultado = await outbox.processarLote({ limite: N, worker: 'worker-1' });

  assert.ok(estadoDoUltimoTrabalhoNaVarreduraConcorrente, 'a checagem concorrente precisa ter rodado de verdade');
  assert.equal(
    estadoDoUltimoTrabalhoNaVarreduraConcorrente.status,
    'processando',
    'a varredura concorrente não pode ter devolvido à fila um trabalho cujo lease acabou de ser renovado — isso é o achado N-9',
  );
  assert.equal(estadoDoUltimoTrabalhoNaVarreduraConcorrente.tentativas, 0, 'não pode ter contado como tentativa abandonada');

  assert.equal(resultado.reivindicados, N);
  assert.equal(resultado.concluidos, N,
    'nenhum trabalho do lote pode ter sido perdido/reagendado por lease vencido enquanto ainda estava sendo processado');
  assert.equal(resultado.reagendados, 0,
    'devolver à fila um trabalho ainda em voo (por causa do carimbo por LOTE, não por trabalho) é exatamente o achado N-9');
  assert.equal(canal.envios.length, N, 'as N respostas de fato saíram — nada foi perdido nem duplicado');
});

test('N-9: se a renovação descobre que o trabalho já não é mais deste worker, ele desiste em vez de processar de novo', async () => {
  // Isola a guarda de `renovarReivindicacaoDeOutbox` sem depender de duas
  // conexões concorrentes de verdade: um repositório espião devolve, na
  // reivindicação, um trabalho "congelado" que na prática já foi retomado
  // por outro worker — situação que `FOR UPDATE SKIP LOCKED` impede
  // acontecer por reivindicação dupla, mas que a renovação por trabalho
  // (N-9) também precisa cobrir como última linha de defesa.
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) },
  });

  const { conversa, mensagemEntrada } = await prepararConversa(repositorio);
  const { trabalho } = await repositorio.enfileirarTrabalhoDeOutbox({
    conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id, chaveIdempotencia: 'outbox:corrida:1',
  });

  // O trabalho já pertence de fato a "worker-2" no repositório real.
  await repositorio.reivindicarTrabalhosDeOutbox({ agora: new Date().toISOString(), limite: 1, worker: 'worker-2' });

  const repositorioComTrabalhoJaRoubado = {
    ...repositorio,
    async reivindicarTrabalhosDeOutbox() {
      // Devolve o objeto como se "worker-1" tivesse acabado de reivindicá-lo
      // — o cenário que `renovarReivindicacaoDeOutbox` precisa recusar.
      return [{ ...trabalho, status: 'processando', reivindicado_por: 'worker-1' }];
    },
  };

  const outbox = criarServicoDeOutbox({ repositorio: repositorioComTrabalhoJaRoubado, atendimento });
  const resultado = await outbox.processarLote({ limite: 1, worker: 'worker-1' });

  assert.equal(resultado.reivindicados, 1);
  assert.equal(resultado.concluidos, 0, 'não pode ter processado um trabalho que já não é mais deste worker');
  assert.equal(canal.envios.length, 0, 'nada pode ter sido enviado por este worker — o outro é quem tem a posse agora');

  const registroDaAuditoria = repositorio._auditoria.find((r) => r.acao === 'outbox_lease_perdido');
  assert.ok(registroDaAuditoria, 'a desistência precisa ficar registrada, não sumir em silêncio');
});

// -------------------------------------------------------------- dados sensíveis

test('nada do texto da conversa aparece nos registros técnicos da outbox', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const TEXTO_CLINICO = 'Preciso remarcar minha consulta de acompanhamento psiquiátrico';
  const RESPOSTA_CLINICA = 'Claro, sua próxima consulta de psiquiatria pode ser remarcada';

  const atendimento = criarAtendimento({
    repositorio,
    canal: canalFalso({ comportamento: 'falha_definitiva' }),
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: RESPOSTA_CLINICA }) },
  });
  const outbox = criarServicoDeOutbox({ repositorio, atendimento, maxTentativas: 1 });

  const atendimentoDeSetup = criarAtendimento({
    repositorio, orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não'); } },
  });
  await atendimentoDeSetup.receberMensagem({
    ...EVENTO, id_externo: 'wa:sensivel:1', texto: TEXTO_CLINICO, estrategia_ia: 'openclaw_gerencia',
  });
  const [conversa] = await repositorio.listarConversas({});
  const [mensagemEntrada] = await repositorio.listarMensagens(conversa.id);

  await outbox.enfileirar({ conversaId: conversa.id, mensagemEntradaId: mensagemEntrada.id });
  const [trabalho] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: new Date().toISOString(), limite: 1, worker: 'w',
  });
  await outbox.processarUm(trabalho);

  const registro = await repositorio.obterTrabalhoDeOutbox(trabalho.id);
  const serializadoDoTrabalho = JSON.stringify(registro);
  assert.ok(!serializadoDoTrabalho.includes(RESPOSTA_CLINICA));
  assert.ok(!serializadoDoTrabalho.includes('psiqui'));

  const serializadoDaAuditoria = JSON.stringify(repositorio._auditoria);
  assert.ok(!serializadoDaAuditoria.includes(RESPOSTA_CLINICA));
  assert.ok(!serializadoDaAuditoria.includes(TEXTO_CLINICO));
  assert.ok(!serializadoDaAuditoria.includes('psiqui'));
});
