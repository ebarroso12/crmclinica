'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { assinar } = require('../src/integracoes/openclaw');

// E2E CRÍTICO, automatizado no CI (P2-07): o caminho inteiro pela borda HTTP —
// webhook assinado → persistência → decisão da Serena → despacho → resposta →
// entrega pelo canal → handoff → métricas. Com dublês de orquestrador e canal:
// nenhuma rede, nenhum dado real, roda em qualquer máquina do CI.
//
// Também cobre P2-06: indisponibilidade do orquestrador, retry idempotente e
// entregas concorrentes do mesmo evento.

const SEGREDO = 'segredo-apenas-para-teste-com-32-caracteres';

function montarMundo({ respostaDaIa = { resposta: 'Olá! Como posso ajudar?' } } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });

  const despachos = [];
  const orquestrador = {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => {
      despachos.push(carga);
      if (respostaDaIa instanceof Error) throw respostaDaIa;
      return respostaDaIa;
    },
  };

  const envios = [];
  const canal = {
    envios,
    enviar: async ({ telefone, texto, chave }) => {
      const repetido = envios.some((envio) => envio.chave === chave);
      envios.push({ telefone, texto, chave, deduplicado: repetido });
      return { identificador: `env-${envios.length}` };
    },
  };

  const atendimento = criarAtendimento({ repositorio, orquestrador, serena, canal });
  return { repositorio, serena, orquestrador, canal, atendimento };
}

function eventoDeSite(sufixo, texto = 'Quero agendar uma avaliação') {
  return JSON.stringify({
    tipo: 'mensagem.recebida',
    canal: 'site',
    id_externo: `site:e2e:${sufixo}`,
    remetente: '5511944440001',
    nome: 'Paciente E2E',
    texto,
  });
}

function postarEvento(app, corpo) {
  return app.pedirSemAuth('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': assinar(corpo, SEGREDO) },
    body: corpo,
  });
}

test('E2E: inbound → CRM → Serena → outbound, com evidência persistida em cada elo', async (t) => {
  const mundo = montarMundo();
  const app = await subirServidor({
    repositorio: mundo.repositorio,
    atendimento: mundo.atendimento,
    servicoDaSerena: mundo.serena,
    configuracao: configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO }),
  });
  t.after(() => app.encerrar());

  // 1. O inbound chega assinado e é aceito.
  const recibo = await (await postarEvento(app, eventoDeSite(1))).json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.decisao, 'respondida_pela_automacao');

  // 2. Persistência ANTES da resposta: entrada e saída no mesmo histórico.
  const mensagens = await mundo.repositorio.listarMensagens(recibo.conversa_id);
  assert.equal(mensagens.filter((m) => m.direcao === 'entrada').length, 1);
  const resposta = mensagens.find((m) => m.autor_tipo === 'automacao');
  assert.equal(resposta.conteudo, 'Olá! Como posso ajudar?');

  // 3. A IA foi consultada UMA vez, com chave determinística.
  assert.equal(mundo.orquestrador.despachos.length, 1);
  assert.match(mundo.orquestrador.despachos[0].chave_idempotencia, /^conversa:\d+:\d+$/);

  // 4. O outbound SAIU pelo canal, com chave idempotente.
  assert.equal(mundo.canal.envios.length, 1);
  assert.equal(mundo.canal.envios[0].telefone, '5511944440001');
  assert.match(mundo.canal.envios[0].chave, /^serena:\d+:\d+$/);

  // 5. A trilha de auditoria registrou a resposta com o elo de entrega.
  assert.ok(mundo.repositorio._auditoria.some(
    (registro) => registro.acao === 'respondida_pela_automacao' && registro.detalhe?.entregue === true,
  ));

  // 6. E a métrica enxerga o que aconteceu.
  const resumo = await (await app.pedir('/api/metricas/resumo')).json();
  assert.equal(resumo.serena.respostas_automacao, 1);
});

test('E2E: reentrega concorrente do mesmo evento gera UMA resposta e UM envio', async (t) => {
  const mundo = montarMundo();
  const app = await subirServidor({
    repositorio: mundo.repositorio,
    atendimento: mundo.atendimento,
    servicoDaSerena: mundo.serena,
    configuracao: configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO }),
  });
  t.after(() => app.encerrar());

  const corpo = eventoDeSite(2);
  // Três entregas do MESMO evento disparadas juntas — o retry agressivo real.
  const respostas = await Promise.all([
    postarEvento(app, corpo), postarEvento(app, corpo), postarEvento(app, corpo),
  ]);
  for (const resposta of respostas) assert.ok([200, 202].includes(resposta.status));

  assert.equal(mundo.orquestrador.despachos.length, 1, 'a IA é consultada uma vez');
  const naoDeduplicados = mundo.canal.envios.filter((envio) => !envio.deduplicado);
  assert.equal(naoDeduplicados.length, 1, 'o paciente recebe UMA resposta');

  const [conversa] = await mundo.repositorio.listarConversas({});
  const mensagens = await mundo.repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.length, 2, 'uma entrada, uma saída — nada duplicado no histórico');
});

test('E2E: orquestrador fora do ar escala para a equipe; o retry com a mesma chave responde depois', async (t) => {
  const falha = Object.assign(new Error('gateway fora do ar'), { codigo: 'gateway_timeout' });
  const mundo = montarMundo({ respostaDaIa: falha });
  const app = await subirServidor({
    repositorio: mundo.repositorio,
    atendimento: mundo.atendimento,
    servicoDaSerena: mundo.serena,
    configuracao: configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO }),
  });
  t.after(() => app.encerrar());

  const recibo = await (await postarEvento(app, eventoDeSite(3))).json();
  assert.equal(recibo.decisao, 'escalonada_por_falha');

  // A mensagem NÃO se perdeu; a conversa foi para a equipe (com a nota privada
  // de sistema da escalonação — que não conta como resposta ao paciente).
  const conversa = await mundo.repositorio.obterConversa(recibo.conversa_id);
  assert.equal(conversa.assumida_por_humano, true, 'indisponibilidade não deixa conversa órfã');
  const aposFalha = await mundo.repositorio.listarMensagens(recibo.conversa_id);
  assert.equal(aposFalha.filter((m) => m.direcao === 'entrada').length, 1);
  assert.equal(aposFalha.filter((m) => m.direcao === 'saida' && !m.privada).length, 0,
    'nenhuma resposta saiu durante a indisponibilidade');

  // O orquestrador volta; a equipe devolve a conversa; o retry usa a MESMA chave.
  mundo.orquestrador.despacharEvento = async (carga) => {
    mundo.orquestrador.despachos.push(carga);
    return { resposta: 'Voltei! Como posso ajudar?' };
  };
  await mundo.atendimento.liberar(recibo.conversa_id);
  const entrada = (await mundo.repositorio.listarMensagens(recibo.conversa_id))
    .find((m) => m.direcao === 'entrada');
  await mundo.atendimento.responderSePossivel(recibo.conversa_id, { mensagemEntradaId: entrada.id });

  const chaves = mundo.orquestrador.despachos.map((despacho) => despacho.chave_idempotencia);
  assert.equal(new Set(chaves).size, 1, 'retry é o mesmo evento: mesma chave de idempotência');
  assert.equal(mundo.canal.envios.filter((envio) => !envio.deduplicado).length, 1);
});

test('E2E: handoff pela API cala a Serena naquela conversa; as outras seguem atendidas', async (t) => {
  const mundo = montarMundo();
  const app = await subirServidor({
    repositorio: mundo.repositorio,
    atendimento: mundo.atendimento,
    servicoDaSerena: mundo.serena,
    configuracao: configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO }),
  });
  t.after(() => app.encerrar());

  const recibo = await (await postarEvento(app, eventoDeSite(4))).json();

  // A recepção assume pela API — o gesto real do painel.
  const assumida = await app.pedir(`/api/conversas/${recibo.conversa_id}/assumir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(assumida.status, 200);

  // Novo inbound da MESMA pessoa: silêncio da automação, mensagem registrada.
  const denovo = await (await postarEvento(app, eventoDeSite('4b', 'Continuo aqui'))).json();
  assert.equal(denovo.decisao, 'aguardando_equipe');
  assert.equal(mundo.orquestrador.despachos.length, 1, 'a IA calou na conversa assumida');
  assert.equal((await mundo.repositorio.listarMensagens(recibo.conversa_id)).length >= 2, true,
    'o inbox continua recebendo');

  // OUTRA pessoa escreve: a automação atende normalmente.
  const outra = JSON.parse(eventoDeSite(5));
  outra.remetente = '5511944440002';
  outra.nome = 'Outro Paciente';
  const corpoOutra = JSON.stringify(outra);
  const daOutra = await (await postarEvento(app, corpoOutra)).json();
  assert.equal(daOutra.decisao, 'respondida_pela_automacao');
  assert.equal(mundo.orquestrador.despachos.length, 2, 'o handoff é por conversa, não global');
});

test('E2E: Serena desligada pela API registra o inbound e não despacha nada', async (t) => {
  const mundo = montarMundo();
  const app = await subirServidor({
    repositorio: mundo.repositorio,
    atendimento: mundo.atendimento,
    servicoDaSerena: mundo.serena,
    configuracao: configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO }),
  });
  t.after(() => app.encerrar());

  const desligada = await app.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'ensaio E2E' }),
  });
  assert.equal(desligada.status, 200);

  const recibo = await (await postarEvento(app, eventoDeSite(6))).json();
  assert.equal(recibo.decisao, 'aguardando_equipe');
  assert.equal(mundo.orquestrador.despachos.length, 0);
  assert.equal((await mundo.repositorio.listarMensagens(recibo.conversa_id)).length, 1,
    'desligada, a Serena continua registrando');
});
