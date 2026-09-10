'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarFluxoDeAgentes } = require('../src/dominio/agentes/fluxo');

// Fluxo das conversas de agente com repositório, motor, entrega e
// escalonamento FALSOS. Prova as decisões do fluxo (quando responde, agrupa,
// retenta, transfere, finaliza) — NÃO prova o repositório real, o motor real
// nem a entrega pela Evolution; isso tem suíte própria e a integração com o
// atendimento tem a sua.

const AGENTE = Object.freeze({
  id: 7,
  nome: 'Agente Alpins',
  status: 'ativo',
  configuracoes: {
    limite_interacoes: 20, acao_limite: 'transferir', resumo_ao_transferir: true, tempo_resposta_segundos: 10,
  },
  canais: [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }],
  acoes_inatividade: [{ apos_minutos: 10, acao: 'finalizar', instrucao: null, ordem: 0 }],
});

function conversaBase(extra = {}) {
  return {
    id: 50, agente_id: 7, canal: 'whatsapp', status: 'aberta', contato_id: 1,
    assumida_por_humano: false, atribuido_a: null, ...extra,
  };
}

function mensagem(id, extra) {
  return {
    id, conversa_id: 50, tipo: 'texto', privada: false, criado_em: '2026-09-10T12:00:00.000Z', ...extra,
  };
}

function criarRepositorioFalso({ agente = AGENTE, conversa = conversaBase(), mensagens = [] } = {}) {
  const estado = {
    mensagens: mensagens.map((item) => ({ ...item })),
    auditoria: [],
    conversas: new Map([[conversa.id, { ...conversa }]]),
    buscasDeCanal: [],
    proximoId: 1000,
  };
  return {
    estado,
    async obterAgente(id) { return agente && agente.id === Number(id) ? agente : null; },
    async obterAgentePorCanal(canal, instancia, opcoes) {
      estado.buscasDeCanal.push({ canal, instancia, opcoes });
      return agente?.canais?.some((item) => item.canal === canal && item.instancia === instancia) ? agente : null;
    },
    async obterConversa(id) { return estado.conversas.get(Number(id)) ?? null; },
    async atualizarConversa(id, campos) {
      Object.assign(estado.conversas.get(Number(id)), campos);
      return estado.conversas.get(Number(id));
    },
    async assumirConversaSeNecessario(id, { usuarioId }) {
      const alvo = estado.conversas.get(Number(id));
      if (alvo.assumida_por_humano) return null;
      Object.assign(alvo, { assumida_por_humano: true, atribuido_a: usuarioId });
      return alvo;
    },
    async listarMensagens(conversaId, { incluirPrivadas = true } = {}) {
      return estado.mensagens.filter((item) => item.conversa_id === conversaId && (incluirPrivadas || !item.privada));
    },
    async registrarMensagem(conversaId, dados) {
      if (dados.id_externo) {
        const existente = estado.mensagens.find((item) => item.id_externo === dados.id_externo);
        if (existente) return { mensagem: existente, duplicada: true };
      }
      const nova = {
        id: estado.proximoId++, conversa_id: conversaId, tipo: 'texto', privada: false,
        criado_em: new Date().toISOString(), ...dados,
      };
      estado.mensagens.push(nova);
      return { mensagem: nova, duplicada: false };
    },
    async registrarAuditoria(entrada) { estado.auditoria.push(entrada); },
    async contarRespostasDaAutomacao(conversaId) {
      return estado.mensagens.filter((item) => item.conversa_id === conversaId
        && item.autor_tipo === 'automacao' && !item.privada).length;
    },
    async listarTreinamentos() { return [{ id: 1, tipo: 'texto', conteudo: 'Tênis do 34 ao 44.' }]; },
    async obterContato() { return { id: 1, nome: 'Cliente', telefone: '5516900000000' }; },
    async listarConversasDeAgenteParaInatividade() {
      return [...estado.conversas.values()]
        .filter((item) => item.agente_id && item.status !== 'resolvida')
        .map((item) => ({ conversa_id: item.id, agente_id: item.agente_id }));
    },
  };
}

function criarMotorFalso({ resposta = { partes: ['Olá! AHU!'], transferir: false, motivo: null }, lanca = null } = {}) {
  const chamadas = { gerarResposta: [], gerarResumo: [], gerarFollowup: [] };
  return {
    chamadas,
    decidir(conversa, agente) {
      if (!agente) return { responder: false, motivo: 'agente_nao_encontrado' };
      if (agente.status !== 'ativo') return { responder: false, motivo: `agente_${agente.status}` };
      if (conversa.assumida_por_humano) return { responder: false, motivo: 'assumida_por_humano' };
      return { responder: true, motivo: 'sem_humano_responsavel' };
    },
    async gerarResposta(argumentos) {
      chamadas.gerarResposta.push(argumentos);
      if (lanca) throw lanca;
      return resposta;
    },
    async gerarResumo(argumentos) {
      chamadas.gerarResumo.push(argumentos);
      return 'Cliente quer o tênis 42 pela Shopee.';
    },
    async gerarFollowup(argumentos) {
      chamadas.gerarFollowup.push(argumentos);
      return { partes: ['Ainda posso te ajudar?'] };
    },
  };
}

function montar({ repositorio = criarRepositorioFalso(), motor = criarMotorFalso(), entrega = null, agora } = {}) {
  const entregas = [];
  const escalonamentos = [];
  const fluxo = criarFluxoDeAgentes({
    repositorio,
    agentes: motor,
    entregar: async (conversa, texto, mensagemId, opcoes) => {
      entregas.push({ conversaId: conversa.id, texto, mensagemId, opcoes });
      return entrega ? entrega(texto) : { enviada: true, identificador: `id-${mensagemId}` };
    },
    escalonar: async (conversaId, motivo) => { escalonamentos.push({ conversaId, motivo }); },
    ...(agora ? { agora } : {}),
  });
  return { fluxo, repositorio, motor, entregas, escalonamentos };
}

const ENTRADA = mensagem(1, { direcao: 'entrada', autor_tipo: 'contato', conteudo: 'Quero um tênis' });

test('responde: grava cada parte com id_externo determinístico e entrega com origem "agente"', async () => {
  const motor = criarMotorFalso({ resposta: { partes: ['Parte um', 'Parte dois'], transferir: false } });
  const { fluxo, repositorio, entregas } = montar({ repositorio: criarRepositorioFalso({ mensagens: [ENTRADA] }), motor });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.partes, 2);
  const saidas = repositorio.estado.mensagens.filter((item) => item.autor_tipo === 'automacao');
  assert.deepEqual(saidas.map((item) => item.id_externo), ['agente:7:resposta:50:1', 'agente:7:resposta:50:1:p2']);
  assert.ok(saidas.every((item) => item.autor_nome === 'Agente Alpins'));
  assert.deepEqual(entregas.map((item) => item.opcoes.origem), ['agente', 'agente']);
  assert.equal(motor.chamadas.gerarResposta[0].chaveIdempotencia, 'agente:7:resposta:50:1');
});

test('agente desativado não gera nem entrega: fica aguardando a equipe, com auditoria sem texto', async () => {
  const repositorio = criarRepositorioFalso({ agente: { ...AGENTE, status: 'desativado' }, mensagens: [ENTRADA] });
  const { fluxo, motor, entregas } = montar({ repositorio });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'agente_desativado');
  assert.equal(motor.chamadas.gerarResposta.length, 0);
  assert.equal(entregas.length, 0);
  assert.deepEqual(repositorio.estado.auditoria[0].detalhe, { motivo: 'agente_desativado', escopo: 'agente', agente_id: 7 });
});

test('rajada: o trabalho de uma mensagem que já tem outra mais nova não responde', async () => {
  const segunda = mensagem(2, { direcao: 'entrada', autor_tipo: 'contato', conteudo: 'tamanho 42' });
  const { fluxo, motor, entregas } = montar({ repositorio: criarRepositorioFalso({ mensagens: [ENTRADA, segunda] }) });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'agrupada_com_mensagem_posterior');
  assert.equal(motor.chamadas.gerarResposta.length, 0);
  assert.equal(entregas.length, 0);
});

test('retentativa reaproveita a resposta gravada e só entrega o que falta, sem nova chamada de IA', async () => {
  const gravada = mensagem(9, {
    direcao: 'saida', autor_tipo: 'automacao', conteudo: 'Olá', id_externo: 'agente:7:resposta:50:1', entregue_em: null,
  });
  const { fluxo, motor, entregas } = montar({ repositorio: criarRepositorioFalso({ mensagens: [ENTRADA, gravada] }) });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.duplicada, true);
  assert.equal(motor.chamadas.gerarResposta.length, 0);
  assert.deepEqual(entregas.map((item) => item.mensagemId), [9]);
});

test('retentativa com entrega incerta não reenvia e sinaliza incerteza para a outbox', async () => {
  const incerta = mensagem(9, {
    direcao: 'saida', autor_tipo: 'automacao', conteudo: 'Olá', id_externo: 'agente:7:resposta:50:1', entrega_indeterminada: true,
  });
  const { fluxo, entregas } = montar({ repositorio: criarRepositorioFalso({ mensagens: [ENTRADA, incerta] }) });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.entregaIncerta, true);
  assert.equal(entregas.length, 0);
});

test('limite de interações atingido: transfere para a equipe com resumo privado, sem gerar resposta', async () => {
  const anteriores = Array.from({ length: 20 }, (_, indice) => mensagem(100 + indice, {
    direcao: 'saida', autor_tipo: 'automacao', conteudo: `r${indice}`, id_externo: `agente:7:resposta:50:x${indice}`,
  }));
  const repositorio = criarRepositorioFalso({ mensagens: [...anteriores, ENTRADA] });
  const { fluxo, motor, entregas } = montar({ repositorio });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'transferida_por_limite');
  assert.equal(motor.chamadas.gerarResposta.length, 0);
  assert.equal(entregas.length, 0);
  assert.equal(repositorio.estado.conversas.get(50).assumida_por_humano, true);
  assert.equal(repositorio.estado.conversas.get(50).atribuido_a, null, 'transferência não inventa dono');
  const privadas = repositorio.estado.mensagens.filter((item) => item.privada);
  assert.ok(privadas.some((item) => item.conteudo.includes('transferiu a conversa para a equipe')));
  assert.ok(privadas.some((item) => item.conteudo.startsWith('Resumo para a equipe:')));
  const auditoria = repositorio.estado.auditoria.find((item) => item.acao === 'transferida_para_humano');
  assert.deepEqual(auditoria.detalhe, { agente_id: 7, motivo: 'limite_de_interacoes' });
});

test('limite com ação "finalizar" resolve a conversa', async () => {
  const agente = { ...AGENTE, configuracoes: { ...AGENTE.configuracoes, limite_interacoes: 1, acao_limite: 'finalizar' } };
  const anterior = mensagem(100, { direcao: 'saida', autor_tipo: 'automacao', conteudo: 'r', id_externo: 'x' });
  const repositorio = criarRepositorioFalso({ agente, mensagens: [anterior, ENTRADA] });
  const { fluxo } = montar({ repositorio });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'finalizada_por_limite');
  assert.equal(repositorio.estado.conversas.get(50).status, 'resolvida');
});

test('o agente pede transferência: entrega a resposta e depois passa para a equipe', async () => {
  const motor = criarMotorFalso({
    resposta: { partes: ['Vou chamar alguém da equipe.'], transferir: true, motivo: 'cliente pediu humano' },
  });
  const repositorio = criarRepositorioFalso({ mensagens: [ENTRADA] });
  const { fluxo, entregas } = montar({ repositorio, motor });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });

  assert.equal(resultado.acao, 'respondida_e_transferida');
  assert.equal(entregas.length, 1);
  assert.equal(repositorio.estado.conversas.get(50).assumida_por_humano, true);
  const resumo = repositorio.estado.mensagens.find((item) => item.privada && item.conteudo.startsWith('Resumo'));
  assert.match(resumo.conteudo, /Motivo apontado pelo agente: cliente pediu humano/);
  const auditoria = repositorio.estado.auditoria.find((item) => item.acao === 'transferida_para_humano');
  assert.equal(JSON.stringify(auditoria.detalhe).includes('cliente pediu humano'), false, 'motivo em prosa nunca vai para a auditoria');
});

test('falha do motor escala para a equipe; resposta vazia também', async () => {
  const falha = montar({
    repositorio: criarRepositorioFalso({ mensagens: [ENTRADA] }),
    motor: criarMotorFalso({ lanca: Object.assign(new Error('timeout'), { codigo: 'ia_timeout' }) }),
  });
  const resultado = await falha.fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });
  assert.equal(resultado.acao, 'escalonada_por_falha');
  assert.deepEqual(falha.escalonamentos, [{ conversaId: 50, motivo: 'falha_no_motor_do_agente' }]);

  const vazio = montar({
    repositorio: criarRepositorioFalso({ mensagens: [ENTRADA] }),
    motor: criarMotorFalso({ resposta: { partes: ['   '], transferir: false } }),
  });
  const semResposta = await vazio.fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });
  assert.equal(semResposta.acao, 'sem_resposta_do_agente');
  assert.deepEqual(vazio.escalonamentos, [{ conversaId: 50, motivo: 'motor_ia_sem_resposta' }]);
});

test('entrega que falha escala e propaga a incerteza; controle mudado aborta sem escalar aqui', async () => {
  const incerta = montar({
    repositorio: criarRepositorioFalso({ mensagens: [ENTRADA] }),
    entrega: () => ({ enviada: false, motivo: 'timeout da Evolution', indeterminado: true }),
  });
  const resultado = await incerta.fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });
  assert.equal(resultado.acao, 'escalonada_por_falha_entrega');
  assert.equal(resultado.entregaIncerta, true);
  assert.deepEqual(incerta.escalonamentos, [{ conversaId: 50, motivo: 'falha_na_entrega_da_automacao' }]);

  const abortada = montar({
    repositorio: criarRepositorioFalso({ mensagens: [ENTRADA] }),
    entrega: () => ({ enviada: false, motivo: 'envio_abortado_por_controle', motivoControle: 'assumida_por_humano' }),
  });
  const parou = await abortada.fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });
  assert.equal(parou.acao, 'resposta_abortada_por_controle');
  assert.equal(abortada.escalonamentos.length, 0);
});

test('sem motor configurado a conversa de agente escala em vez de ficar muda', async () => {
  const repositorio = criarRepositorioFalso({ mensagens: [ENTRADA] });
  const escalonamentos = [];
  const fluxo = criarFluxoDeAgentes({
    repositorio,
    agentes: null,
    entregar: async () => ({ enviada: true }),
    escalonar: async (conversaId, motivo) => { escalonamentos.push(motivo); },
  });

  const resultado = await fluxo.responder(conversaBase(), { mensagemEntradaId: 1 });
  assert.equal(resultado.motivo, 'motor_de_agentes_nao_configurado');
  assert.deepEqual(escalonamentos, ['motor_de_agentes_nao_configurado']);
});

test('dono do canal: busca inclui canal inativo; sem instância nem consulta o repositório', async () => {
  const { fluxo, repositorio } = montar();
  assert.equal(await fluxo.agenteDoCanal('whatsapp', null), null);
  assert.equal(repositorio.estado.buscasDeCanal.length, 0);

  const agente = await fluxo.agenteDoCanal('whatsapp', 'alpins');
  assert.equal(agente.id, 7);
  assert.deepEqual(repositorio.estado.buscasDeCanal[0].opcoes, { incluirInativos: true });
});

test('instância de envio: só canal ativo do agente; canal desligado não envia por nenhuma instância', async () => {
  const { fluxo } = montar();
  assert.equal(await fluxo.instanciaDeEnvio(conversaBase()), 'alpins');

  const desligado = montar({
    repositorio: criarRepositorioFalso({
      agente: { ...AGENTE, canais: [{ canal: 'whatsapp', instancia: 'alpins', ativo: false }] },
    }),
  });
  assert.equal(await desligado.fluxo.instanciaDeEnvio(conversaBase()), null);
});

test('atraso de resposta vem de tempo_resposta_segundos; zero não atrasa', () => {
  const agora = () => new Date('2026-09-10T12:00:00.000Z');
  const { fluxo } = montar({ agora });
  assert.equal(fluxo.atrasoDeResposta(AGENTE), '2026-09-10T12:00:10.000Z');
  assert.equal(fluxo.atrasoDeResposta({ ...AGENTE, configuracoes: { tempo_resposta_segundos: 0 } }), null);
});

test('inatividade: finaliza depois do prazo contado da última resposta do agente', async () => {
  const resposta = mensagem(2, {
    direcao: 'saida', autor_tipo: 'automacao', conteudo: 'Olá', id_externo: 'agente:7:resposta:50:1', criado_em: '2026-09-10T12:05:00.000Z',
  });
  const cedo = montar({
    repositorio: criarRepositorioFalso({ mensagens: [ENTRADA, resposta] }),
    agora: () => new Date('2026-09-10T12:14:00.000Z'),
  });
  assert.equal((await cedo.fluxo.processarInatividade()).finalizadas, 0, '9 minutos ainda não é 10');

  const repositorio = criarRepositorioFalso({ mensagens: [ENTRADA, resposta] });
  const { fluxo } = montar({ repositorio, agora: () => new Date('2026-09-10T12:16:00.000Z') });
  const resumo = await fluxo.processarInatividade();

  assert.equal(resumo.finalizadas, 1);
  assert.equal(repositorio.estado.conversas.get(50).status, 'resolvida');
  assert.deepEqual(
    repositorio.estado.auditoria.find((item) => item.acao === 'finalizada_por_inatividade').detalhe,
    { agente_id: 7, apos_minutos: 10 },
  );
});

test('inatividade: "interagir" manda uma vez só e não reinicia o prazo do "finalizar"', async () => {
  const agente = {
    ...AGENTE,
    acoes_inatividade: [
      { apos_minutos: 5, acao: 'interagir', instrucao: 'Pergunte se ainda tem interesse', ordem: 0 },
      { apos_minutos: 30, acao: 'finalizar', instrucao: null, ordem: 1 },
    ],
  };
  const resposta = mensagem(2, {
    direcao: 'saida', autor_tipo: 'automacao', conteudo: 'Olá', id_externo: 'agente:7:resposta:50:1', criado_em: '2026-09-10T12:05:00.000Z',
  });
  const repositorio = criarRepositorioFalso({ agente, mensagens: [ENTRADA, resposta] });
  const motor = criarMotorFalso();
  let instante = new Date('2026-09-10T12:11:00.000Z');
  const { fluxo, entregas } = montar({ repositorio, motor, agora: () => instante });

  assert.equal((await fluxo.processarInatividade()).interacoes, 1);
  assert.equal(motor.chamadas.gerarFollowup[0].instrucao, 'Pergunte se ainda tem interesse');
  assert.equal(entregas.length, 1);
  assert.ok(repositorio.estado.mensagens.some((item) => item.id_externo === 'agente:7:inatividade:50:2:5'));

  instante = new Date('2026-09-10T12:12:00.000Z');
  assert.equal((await fluxo.processarInatividade()).interacoes, 0, 'a mesma ação não repete');
  assert.equal(entregas.length, 1);

  instante = new Date('2026-09-10T12:36:00.000Z');
  assert.equal((await fluxo.processarInatividade()).finalizadas, 1, '30 min contados da resposta, não do "ainda posso ajudar?"');
});

test('inatividade: a equipe escreveu depois do cliente — o agente não age', async () => {
  const equipe = mensagem(2, { direcao: 'saida', autor_tipo: 'equipe', conteudo: 'Oi', criado_em: '2026-09-10T12:01:00.000Z' });
  const repositorio = criarRepositorioFalso({ mensagens: [ENTRADA, equipe] });
  const { fluxo } = montar({ repositorio, agora: () => new Date('2026-09-10T13:00:00.000Z') });

  const resumo = await fluxo.processarInatividade();
  assert.equal(resumo.finalizadas, 0);
  assert.equal(repositorio.estado.conversas.get(50).status, 'aberta');
});
