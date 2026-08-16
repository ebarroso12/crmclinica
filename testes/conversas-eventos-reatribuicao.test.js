'use strict';

// BLOQUEADOR 1 do gate final do PR #34: a decisão de autorização do chat ao
// vivo era servida de um CACHE COM TTL (`ttlCacheDeEscopoMs = 5000`, em
// src/servidor/eventos-conversas.js). Provado contra PostgreSQL 18.4 real:
//
//   1) evento com conversa atribuida a A: A recebeu = true
//   2) reatribuicao confirmada no banco: atribuido_a = 2 (B = 2)
//   3) evento imediatamente apos a reatribuicao: A AINDA recebeu = true
//   4) evento >5s apos a reatribuicao: A recebeu = false
//
// Ou seja: durante até 5 segundos DEPOIS de a conversa ser tirada dele, o
// atendente antigo continuava recebendo o conteúdo ao vivo. Numa clínica isso
// é dado de paciente indo para quem já perdeu o direito de ver.
//
// Invalidar o cache localmente no `conversa_assumida` NÃO resolve: a produção
// roda em mais de um processo (VPS + Vercel). A reatribuição feita no processo
// X não invalida cache nenhum do processo Y, e o atendente antigo conectado
// em Y segue recebendo. A única correção que vale para N processos é NÃO TER
// ESTADO DE AUTORIZAÇÃO CACHEADO: cada evento consulta a atribuição ATUAL.
//
// Este arquivo prova isso SEM ESPERAR os 5 segundos — a prova é que o evento
// IMEDIATAMENTE seguinte à reatribuição já não chega. Se algum dia alguém
// reintroduzir qualquer TTL, o teste falha na hora, não "depois de 5s".
//
// Achado acoplado, provado junto: `obterAtribuidoDaConversa` devolvia `null`
// tanto para "conversa existe e está livre" quanto para "conversa não
// existe", e `podeAcessarConversaAoVivo` lê `null` como "livre" → CONVERSA
// INEXISTENTE CONCEDIA ACESSO. Os três estados (existe/inexistente/erro)
// agora são distintos e explícitos.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');

// Ids de usuário puros: o emissor só compara números (`podeAcessarConversaAoVivo`)
// e o repositório em memória não tem FK. Criar sessões HTTP reais aqui só
// acrescentaria latência e ruído a um teste que é sobre uma decisão de
// autorização, não sobre o transporte.
const ATENDENTE_A = 101;
const ATENDENTE_B = 202;

function orquestradorFalso() {
  return {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'Olá! Posso ajudar?' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

/**
 * Resposta HTTP falsa: guarda as linhas SSE escritas. Não há socket, não há
 * rede e não há tempo envolvido — o que este teste mede é QUEM recebeu, e
 * isso é decidido de forma síncrona depois que `publicar` resolve.
 */
function respostaFalsa() {
  const linhas = [];
  return {
    linhas,
    write(linha) { linhas.push(linha); return true; },
    /** Ids dos eventos entregues, na ordem em que foram escritos. */
    idsRecebidos() {
      return linhas.map((linha) => Number(/^id: (\d+)/m.exec(linha)?.[1])).filter(Number.isInteger);
    },
    recebeu(eventoId) { return this.idsRecebidos().includes(Number(eventoId)); },
    limpar() { linhas.length = 0; },
  };
}

/**
 * Envolve o repositório contando quantas vezes o escopo da conversa foi
 * consultado. Conta as DUAS formas (a antiga `obterAtribuidoDaConversa` e a
 * nova `obterEscopoDaConversa`) de propósito: assim o teste falha por causa
 * do TTL/da consulta por assinante, não por "método não existe".
 */
function contandoConsultasDeEscopo(repositorio) {
  const contador = { total: 0 };
  const espiao = Object.create(repositorio);
  if (typeof repositorio.obterAtribuidoDaConversa === 'function') {
    espiao.obterAtribuidoDaConversa = async function (conversaId) {
      contador.total += 1;
      return repositorio.obterAtribuidoDaConversa(conversaId);
    };
  }
  if (typeof repositorio.obterEscopoDaConversa === 'function') {
    espiao.obterEscopoDaConversa = async function (conversaId) {
      contador.total += 1;
      return repositorio.obterEscopoDaConversa(conversaId);
    };
  }
  return { espiao, contador };
}

async function montarCenario() {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: orquestradorFalso() });

  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:reatribuicao:1',
    remetente: '5516900000201', nome: 'Conversa reatribuída', texto: 'oi',
  });
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:reatribuicao:livre',
    remetente: '5516900000202', nome: 'Conversa livre', texto: 'oi',
  });

  const todas = await repositorio.listarConversas({});
  const conversa = todas.find((c) => c.contato.nome === 'Conversa reatribuída');
  const conversaLivre = todas.find((c) => c.contato.nome === 'Conversa livre');

  await repositorio.assumirConversaSeNecessario(conversa.id, { usuarioId: ATENDENTE_A });

  return { repositorio, conversa, conversaLivre };
}

// ---------------------------------------------------------------- janela residual

test('[reatribuição] o evento IMEDIATAMENTE seguinte já não chega ao atendente antigo — sem janela residual', async () => {
  const { repositorio, conversa } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });

  const respostaA = respostaFalsa();
  const respostaB = respostaFalsa();
  const respostaGestor = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });
  emissor.inscrever(respostaB, { usuarioId: ATENDENTE_B, papel: 'atendente' });
  emissor.inscrever(respostaGestor, { usuarioId: 999, papel: 'gestor' });

  // (1) Enquanto a conversa é de A, A recebe e B não.
  const antes = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.ok(antes, 'a publicação precisa ter sido gravada para o teste fazer sentido');
  assert.equal(respostaA.recebeu(antes.id), true, 'A precisa receber enquanto a conversa é dele');
  assert.equal(respostaB.recebeu(antes.id), false, 'B não pode receber conversa que ainda é de A');
  assert.equal(respostaGestor.recebeu(antes.id), true, 'gestor vê tudo');

  // (2) Reatribuição confirmada NO REPOSITÓRIO (não é suposição do teste).
  await repositorio.atualizarConversa(conversa.id, { atribuido_a: ATENDENTE_B });
  const conferida = (await repositorio.listarConversas({})).find((c) => c.id === conversa.id);
  assert.equal(Number(conferida.atribuido_a), ATENDENTE_B, 'reatribuição precisa estar confirmada no repositório');

  // (3) Evento IMEDIATAMENTE posterior — nenhum relógio avançado, nenhum
  // sleep. É exatamente aqui que o TTL de 5s deixava A continuar recebendo.
  const depois = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.ok(depois, 'a segunda publicação precisa ter sido gravada');
  assert.equal(
    respostaA.recebeu(depois.id), false,
    'JANELA RESIDUAL: A não pode receber o evento imediatamente posterior à reatribuição',
  );
  assert.equal(respostaB.recebeu(depois.id), true, 'B precisa passar a receber assim que a conversa é dele');
  assert.equal(respostaGestor.recebeu(depois.id), true, 'gestor continua vendo tudo depois da reatribuição');
});

test('[reatribuição] a volta também vale na hora: devolver a conversa para A restaura o acesso de A sem TTL', async () => {
  const { repositorio, conversa } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });
  const respostaA = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });

  await repositorio.atualizarConversa(conversa.id, { atribuido_a: ATENDENTE_B });
  const negado = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.equal(respostaA.recebeu(negado.id), false, 'sanity: com a conversa em B, A não recebe');

  await repositorio.atualizarConversa(conversa.id, { atribuido_a: ATENDENTE_A });
  const permitido = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.equal(
    respostaA.recebeu(permitido.id), true,
    'o acesso restaurado também precisa valer no evento seguinte — um cache negativo com TTL falharia aqui',
  );
});

// ---------------------------------------------------------------- consulta por evento, não por assinante (e sem TTL)

test('[sem TTL] cada evento publicado consulta a atribuição ATUAL exatamente uma vez', async () => {
  const { repositorio, conversa } = await montarCenario();
  const { espiao, contador } = contandoConsultasDeEscopo(repositorio);
  const emissor = criarEmissorDeConversas({ repositorio: espiao });

  // Três atendentes conectados na mesma conversa (recepção com várias abas).
  for (const usuarioId of [ATENDENTE_A, ATENDENTE_B, 303]) {
    emissor.inscrever(respostaFalsa(), { usuarioId, papel: 'atendente' });
  }

  await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_enviada' });

  // 2 é o número certo por DOIS motivos, e cada um pega um defeito diferente:
  //   - mais que 2 (ex.: 6) = consulta POR ASSINANTE, o custo que o cache
  //     existia para evitar — a correção precisa resolver isso sem cache;
  //   - menos que 2 (ex.: 1) = a decisão do segundo evento reaproveitou a
  //     leitura do primeiro, ou seja, TTL/cache — a janela residual de volta.
  assert.equal(
    contador.total, 2,
    'cada evento precisa de UMA consulta da atribuição atual: nem por assinante, nem reaproveitada entre eventos',
  );
});

test('[sem TTL] só admin/gestor conectados: nenhuma consulta de escopo é feita', async () => {
  const { repositorio, conversa } = await montarCenario();
  const { espiao, contador } = contandoConsultasDeEscopo(repositorio);
  const emissor = criarEmissorDeConversas({ repositorio: espiao });

  const respostaAdmin = respostaFalsa();
  const respostaGestor = respostaFalsa();
  emissor.inscrever(respostaAdmin, { usuarioId: 1, papel: 'admin' });
  emissor.inscrever(respostaGestor, { usuarioId: 2, papel: 'gestor' });

  const evento = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });

  assert.equal(respostaAdmin.recebeu(evento.id), true, 'admin recebe');
  assert.equal(respostaGestor.recebeu(evento.id), true, 'gestor recebe');
  assert.equal(
    contador.total, 0,
    'admin/gestor não dependem de `atribuido_a` — a otimização legítima é não consultar o banco por eles',
  );
});

test('[sem TTL] sem assinante nenhum: nenhuma consulta de escopo é feita', async () => {
  const { repositorio, conversa } = await montarCenario();
  const { espiao, contador } = contandoConsultasDeEscopo(repositorio);
  const emissor = criarEmissorDeConversas({ repositorio: espiao });

  await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });

  assert.equal(contador.total, 0, 'sem ninguém conectado não há decisão de autorização a tomar');
});

// ---------------------------------------------------------------- os três estados

test('[três estados] conversa existente SEM responsável continua visível ao atendente', async () => {
  const { repositorio, conversaLivre } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });
  const respostaA = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });

  const evento = await emissor.publicar({ conversaId: conversaLivre.id, tipo: 'mensagem_recebida' });
  assert.equal(
    respostaA.recebeu(evento.id), true,
    'conversa livre (existe, atribuido_a = null) é o caso legítimo — não pode ser negada junto com "inexistente"',
  );
});

test('[três estados] conversa INEXISTENTE não concede acesso a atendente', async () => {
  const { repositorio } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });
  const respostaA = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });

  // 987654 não existe. Antes da correção, `obterAtribuidoDaConversa` devolvia
  // `null` (o mesmo valor de "livre") e o predicado liberava.
  const evento = await emissor.publicar({ conversaId: 987654, tipo: 'mensagem_recebida' });
  assert.ok(evento, 'o evento é gravado — o que está em teste é a ENTREGA, não a gravação');
  assert.equal(
    respostaA.recebeu(evento.id), false,
    'conversa que não existe não pode ser tratada como "livre": nega',
  );
});

test('[três estados] ERRO ao consultar o escopo é fail-closed para atendente e não vira "livre"', async () => {
  const { repositorio, conversa } = await montarCenario();
  const quebrado = Object.create(repositorio);
  const falha = new Error('conexão com o banco recusada');
  falha.code = '08006';
  quebrado.obterAtribuidoDaConversa = async () => { throw falha; };
  quebrado.obterEscopoDaConversa = async () => { throw falha; };

  const emissor = criarEmissorDeConversas({ repositorio: quebrado });
  const respostaA = respostaFalsa();
  const respostaGestor = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });
  emissor.inscrever(respostaGestor, { usuarioId: 999, papel: 'gestor' });

  const evento = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.ok(evento, 'a falha é só na decisão de escopo — a gravação do evento segue');
  assert.equal(respostaA.recebeu(evento.id), false, 'sem conseguir confirmar o escopo, nega (fail-closed)');
  // O gestor NÃO depende de `atribuido_a` para nada: negá-lo por causa de uma
  // consulta que a decisão dele nem usa seria transformar um erro de banco em
  // perda de funcionalidade para quem tem acesso global. Fail-closed vale para
  // a decisão que precisava do dado — não para as que não precisavam.
  assert.equal(respostaGestor.recebeu(evento.id), true, 'gestor tem acesso global e não consulta escopo');
});

test('[três estados] repositório sem a consulta de escopo: nega atendente em vez de assumir "livre"', async () => {
  const { repositorio, conversa } = await montarCenario();
  const semConsulta = Object.create(repositorio);
  semConsulta.obterAtribuidoDaConversa = undefined;
  semConsulta.obterEscopoDaConversa = undefined;

  const emissor = criarEmissorDeConversas({ repositorio: semConsulta });
  const respostaA = respostaFalsa();
  emissor.inscrever(respostaA, { usuarioId: ATENDENTE_A, papel: 'atendente' });

  const evento = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.equal(respostaA.recebeu(evento.id), false, 'sem como confirmar o escopo, nega');
});

// ---------------------------------------------------------------- paridade com o replay

test('[paridade] o replay também nega conversa inexistente — mesmo escopo do ao vivo', async () => {
  const { repositorio } = await montarCenario();

  // Evento órfão: existe no log, mas a conversa não existe. No PostgreSQL o
  // replay usa `JOIN conversas` e a linha simplesmente não aparece; o
  // repositório em memória precisa ter a MESMA semântica, senão as duas vias
  // (replay e ao vivo) divergem justamente no caso de borda.
  await repositorio.registrarEventoDeConversa({ conversaId: 987654, tipo: 'mensagem_recebida', payload: {} });

  const doAtendente = await repositorio.listarEventosDeConversasDesde({
    cursor: 0, usuarioId: ATENDENTE_A, papel: 'atendente',
  });
  assert.equal(
    doAtendente.some((linha) => Number(linha.conversa_id) === 987654), false,
    'replay não pode entregar evento de conversa que não existe',
  );
});

test('[paridade] atendente nunca recebe, ao vivo, conversa atribuída a outro atendente', async () => {
  const { repositorio, conversa } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });
  const respostaB = respostaFalsa();
  emissor.inscrever(respostaB, { usuarioId: ATENDENTE_B, papel: 'atendente' });

  const evento = await emissor.publicar({ conversaId: conversa.id, tipo: 'mensagem_recebida' });
  assert.equal(respostaB.recebeu(evento.id), false, 'a conversa é de A — B não pode ver');
});

test('[paridade] papel desconhecido não recebe nada, mesmo em conversa livre', async () => {
  const { repositorio, conversaLivre } = await montarCenario();
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 1, papel: 'financeiro' });

  const evento = await emissor.publicar({ conversaId: conversaLivre.id, tipo: 'mensagem_recebida' });
  assert.equal(resposta.recebeu(evento.id), false, 'a falta de regra nega — nunca o contrário');
});
