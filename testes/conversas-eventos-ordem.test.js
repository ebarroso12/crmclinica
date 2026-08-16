'use strict';

// BLOQUEADOR 2 do gate final do PR #34: REORDENAÇÃO DO SSE.
//
// Provado com repositório instrumentado:
//
//   ordem de entrega no stream SSE: [2,1]
//   entregue em ordem crescente de id: false
//
// Como acontecia: `empurrar` virou `async` (commit 771ff04) e passou a fazer
// I/O DENTRO do laço de assinantes (`await autorizada(...)`), e `publicar`
// fazia `await empurrar(evento)` sem nenhuma serialização. Duas publicações
// concorrentes na mesma conversa intercalam: a que resolve a consulta primeiro
// escreve primeiro, mesmo tendo `id` maior.
//
// Por que isso é EXATAMENTE o bug que este hotfix existe para corrigir: o
// cliente gravava o cursor com `cursorDeEventos = dados.id` (sem `Math.max`).
// Recebendo [2,1], o cursor termina em 1 — RETROCEDE. Na próxima reconexão o
// replay reenvia o evento 2, que a tela já mostrou → MENSAGEM DUPLICADA NO
// CHAT.
//
// A defesa é em duas camadas e as duas são obrigatórias:
//   - servidor (aqui): a etapa assíncrona de publicar/empurrar é serializada,
//     então o id é atribuído e entregue em ordem crescente;
//   - cliente (testes/chat-ao-vivo-cursor-monotonico.test.js): o cursor nunca
//     retrocede, mesmo que um evento chegue fora de ordem por qualquer outro
//     motivo (proxy, reconexão, outro processo).
//
// Nada aqui depende de tempo real: a concorrência é forçada por BARREIRA
// (promise que o teste resolve na mão), nunca por `setTimeout` longo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');

/** Deixa o event loop girar N voltas — sem prender relógio, sem sleep longo. */
async function deixarOOutroCorrer(voltas = 10) {
  for (let i = 0; i < voltas; i += 1) {
    await new Promise(setImmediate);
  }
}

function respostaFalsa() {
  const linhas = [];
  return {
    linhas,
    write(linha) { linhas.push(linha); return true; },
    idsRecebidos() {
      return linhas.map((linha) => Number(/^id: (\d+)/m.exec(linha)?.[1])).filter(Number.isInteger);
    },
  };
}

/**
 * Repositório instrumentado: ids sequenciais e uma BARREIRA na consulta de
 * escopo. Implementa as DUAS formas de consultar o escopo (a antiga
 * `obterAtribuidoDaConversa` e a nova `obterEscopoDaConversa`) de propósito —
 * assim o teste falha pela ORDEM, não por "método não existe".
 */
function criarRepositorioInstrumentado({ barrarConsultaNumero = null, falharRegistroNumero = null } = {}) {
  let proximoId = 1;
  let registros = 0;
  let consultas = 0;
  const eventos = [];
  let liberarBarreira = null;
  let avisarQueBarrou = null;
  const barrou = new Promise((resolve) => { avisarQueBarrou = resolve; });

  async function escopoBruto() {
    consultas += 1;
    if (consultas === barrarConsultaNumero) {
      avisarQueBarrou();
      await new Promise((resolve) => { liberarBarreira = resolve; });
    }
    return null; // sem responsável — conversa livre
  }

  return {
    eventos,
    /** Resolve quando a consulta barrada de fato começou a esperar. */
    esperarBarreira() { return barrou; },
    liberarBarreira() {
      assert.ok(liberarBarreira, 'a barreira precisa ter sido alcançada antes de ser liberada');
      liberarBarreira();
    },
    contarConsultas() { return consultas; },

    async registrarEventoDeConversa({ conversaId, tipo, payload = {} }) {
      registros += 1;
      if (registros === falharRegistroNumero) {
        throw new Error('falha simulada ao gravar o evento');
      }
      const evento = {
        id: proximoId, conversa_id: Number(conversaId), tipo, payload,
        criado_em: new Date(Date.UTC(2026, 7, 15)).toISOString(),
      };
      proximoId += 1;
      eventos.push(evento);
      return evento;
    },

    async obterAtribuidoDaConversa() { return escopoBruto(); },
    async obterEscopoDaConversa() {
      await escopoBruto();
      return { estado: 'existe', atribuidoA: null };
    },
  };
}

// ---------------------------------------------------------------- ordem sob concorrência

test('[ordem] duas publicações concorrentes chegam em [1,2] — nunca [2,1]', async () => {
  // A primeira consulta de escopo fica presa na barreira. Sem serialização, a
  // segunda publicação corre inteira nesse meio-tempo e escreve primeiro.
  const repositorio = criarRepositorioInstrumentado({ barrarConsultaNumero: 1 });
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente' });

  const primeira = emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' });

  // Espera a barreira ser ALCANÇADA — é o que garante que a publicação 1
  // realmente começou antes da 2, sem depender de quanto tempo isso levou.
  // Se a correção serializar antes da consulta, a barreira nunca é alcançada
  // pela publicação 1 estando a 2 pendente: aí o `Promise.race` abaixo cai no
  // outro lado e o teste segue igual — a ordem final é o que importa.
  await Promise.race([repositorio.esperarBarreira(), deixarOOutroCorrer(20)]);

  const segunda = emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' });

  // Dá ao event loop todas as chances de deixar a segunda publicação
  // ultrapassar a primeira. É exatamente essa ultrapassagem que produzia [2,1].
  await deixarOOutroCorrer(20);
  await repositorio.esperarBarreira();
  repositorio.liberarBarreira();

  await Promise.all([primeira, segunda]);

  assert.deepEqual(
    resposta.idsRecebidos(), [1, 2],
    'a entrega precisa sair em ordem crescente de id — [2,1] é o defeito que duplica mensagem no chat',
  );
});

test('[ordem] rajada de publicações concorrentes sai estritamente crescente', async () => {
  const repositorio = criarRepositorioInstrumentado({ barrarConsultaNumero: 1 });
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente' });

  const pendentes = [emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' })];
  await Promise.race([repositorio.esperarBarreira(), deixarOOutroCorrer(20)]);
  for (let i = 0; i < 6; i += 1) {
    pendentes.push(emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' }));
  }
  await deixarOOutroCorrer(20);
  await repositorio.esperarBarreira();
  repositorio.liberarBarreira();
  await Promise.all(pendentes);

  const ids = resposta.idsRecebidos();
  assert.equal(ids.length, 7, 'todas as publicações precisam ter sido entregues');
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i] > ids[i - 1], `sequência regrediu em ${ids[i - 1]} → ${ids[i]} (entregue: ${ids.join(',')})`);
  }
});

test('[ordem] assinantes diferentes recebem a MESMA sequência crescente', async () => {
  const repositorio = criarRepositorioInstrumentado({ barrarConsultaNumero: 1 });
  const emissor = criarEmissorDeConversas({ repositorio });
  const doAtendente = respostaFalsa();
  const doGestor = respostaFalsa();
  emissor.inscrever(doAtendente, { usuarioId: 7, papel: 'atendente' });
  emissor.inscrever(doGestor, { usuarioId: 9, papel: 'gestor' });

  const primeira = emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' });
  await Promise.race([repositorio.esperarBarreira(), deixarOOutroCorrer(20)]);
  const segunda = emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' });
  await deixarOOutroCorrer(20);
  await repositorio.esperarBarreira();
  repositorio.liberarBarreira();
  await Promise.all([primeira, segunda]);

  assert.deepEqual(doAtendente.idsRecebidos(), [1, 2], 'atendente recebeu fora de ordem');
  assert.deepEqual(doGestor.idsRecebidos(), [1, 2], 'gestor recebeu fora de ordem');
});

// ---------------------------------------------------------------- fila não envenenada

test('[fila] uma publicação que falha não interrompe as seguintes', async () => {
  // A 2ª gravação rejeita. Sem cuidado, uma fila construída em cima de uma
  // promise rejeitada fica rejeitada PARA SEMPRE e todo evento posterior
  // morre em silêncio — o chat congelaria até o processo reiniciar.
  const repositorio = criarRepositorioInstrumentado({ falharRegistroNumero: 2 });
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente' });

  const resultados = await Promise.all([
    emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' }),
    emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' }),
    emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' }),
  ]);

  assert.ok(resultados[0], 'a primeira publicação precisa ter sido gravada');
  assert.equal(resultados[1], null, 'a publicação que falhou devolve null — publicar nunca lança');
  assert.ok(resultados[2], 'a publicação POSTERIOR à falha precisa continuar funcionando');

  const ids = resposta.idsRecebidos();
  assert.equal(ids.includes(resultados[0].id), true, 'evento anterior à falha entregue');
  assert.equal(ids.includes(resultados[2].id), true, 'evento posterior à falha entregue — a fila não foi envenenada');
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i] > ids[i - 1], 'mesmo com uma falha no meio, a ordem entregue continua crescente');
  }
});

test('[fila] publicar continua funcionando depois de a fila drenar (nada fica preso)', async () => {
  const repositorio = criarRepositorioInstrumentado();
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente' });

  await emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' });
  await deixarOOutroCorrer(3);
  const depois = await emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' });

  assert.ok(depois, 'a fila precisa aceitar trabalho novo depois de drenar');
  assert.deepEqual(resposta.idsRecebidos(), [1, 2]);
});

// ---------------------------------------------------------------- encerramento

test('[encerramento] cancelar a inscrição não deixa fila nem entrega pendente para a conexão morta', async () => {
  const repositorio = criarRepositorioInstrumentado({ barrarConsultaNumero: 1 });
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  const cancelar = emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente' });

  const primeira = emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' });
  await Promise.race([repositorio.esperarBarreira(), deixarOOutroCorrer(20)]);
  cancelar();
  await repositorio.esperarBarreira();
  repositorio.liberarBarreira();
  await primeira;

  assert.equal(emissor.total(), 0, 'a conexão cancelada não pode continuar contando como assinante');

  // Trabalho novo depois do cancelamento continua sendo aceito e não escreve
  // no `res` morto (o que, num socket real, seria exceção a cada evento).
  const depois = await emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' });
  assert.ok(depois, 'a fila segue viva mesmo sem assinante');
  assert.equal(
    resposta.idsRecebidos().includes(depois.id), false,
    'nada pode ser escrito numa conexão já encerrada',
  );
});

test('[encerramento] escrita que lança remove o assinante e não derruba a publicação', async () => {
  const repositorio = criarRepositorioInstrumentado();
  const emissor = criarEmissorDeConversas({ repositorio });
  const quebrada = {
    write() { throw new Error('socket já fechado'); },
  };
  const boa = respostaFalsa();
  emissor.inscrever(quebrada, { usuarioId: 7, papel: 'atendente' });
  emissor.inscrever(boa, { usuarioId: 9, papel: 'gestor' });

  const evento = await emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' });

  assert.ok(evento, 'a publicação não pode falhar por causa de um socket morto');
  assert.deepEqual(boa.idsRecebidos(), [1], 'o assinante saudável continua recebendo');
  assert.equal(emissor.total(), 1, 'o assinante cuja escrita falhou precisa ser removido');
});

// ---------------------------------------------------------------- cursor do assinante

test('[cursor] evento com id <= depoisDeCursor não é reenviado (defesa contra duplicar o replay)', async () => {
  const repositorio = criarRepositorioInstrumentado();
  const emissor = criarEmissorDeConversas({ repositorio });
  const resposta = respostaFalsa();
  emissor.inscrever(resposta, { usuarioId: 7, papel: 'atendente', depoisDeCursor: 2 });

  await emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' }); // id 1
  await emissor.publicar({ conversaId: 42, tipo: 'mensagem_enviada' }); // id 2
  await emissor.publicar({ conversaId: 42, tipo: 'mensagem_recebida' }); // id 3

  assert.deepEqual(
    resposta.idsRecebidos(), [3],
    'só o que o replay ainda não entregou pode sair ao vivo — 1 e 2 já foram',
  );
});
