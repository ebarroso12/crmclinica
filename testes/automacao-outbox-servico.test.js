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
  return {
    envios,
    async enviar(carga) {
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

/** Monta conversa + mensagem de entrada, sem processar nada ainda. */
async function prepararConversa(repositorio) {
  const atendimentoDeSetup = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } },
  });
  await atendimentoDeSetup.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
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

  // Tempo passa, além do lease.
  agoraSimulado = new Date(agoraSimulado.getTime() + 3 * 60 * 1000);

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
    agoraSimulado = new Date(agoraSimulado.getTime() + 3 * 60 * 1000);
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
  await atendimentoDeSetup.receberMensagem({ ...EVENTO, id_externo: 'wa:sensivel:1', texto: TEXTO_CLINICO });
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
