'use strict';

// Achado da auditoria adversarial (2026-08-16, protocolo SRE) sobre o
// emissor de conversas (Pendência 4 / gate final do PR #34): `empurrar()`
// chamava `assinatura.res.write(linha)` e ignorava o valor de retorno.
//
// `res.write()` do Node devolve `false` quando o buffer interno do socket
// está cheio — sinal de que quem lê do outro lado (o navegador) está mais
// lento do que quem escreve. Sem checar isso, um cliente lento (rede ruim,
// aba em segundo plano por horas, ou um cliente deliberadamente lento)
// nunca dá "drain", e o processo (VPS ou cada função da Vercel) acumula o
// conteúdo não entregue na memória, sem teto — degradação silenciosa até
// esgotar memória sob uso real, não um crash imediato que apareceria óbvio
// em teste superficial.
//
// A correção: contar escritas consecutivas sem drenar por assinante; depois
// de um limite, tratar como cliente morto/lento e desconectar (mesma
// filosofia de fail-safe já usada no resto deste arquivo — nunca deixar
// estado não regulado crescer sem limite). O contador zera no evento
// `drain` do `res`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');

/**
 * `res` fake mínimo: grava quantas vezes `write` foi chamado, devolve o
 * valor de retorno programado a cada chamada, permite registrar o
 * ouvinte de `drain` e dispará-lo manualmente, e marca se `end()` foi
 * chamado — sem servidor HTTP real, sem rede.
 */
function criarResFalso({ escritasQueDrenam = [] } = {}) {
  const chamadasDeWrite = [];
  const ouvintesDeDrain = [];
  let encerrado = false;
  return {
    res: {
      write(linha) {
        const indice = chamadasDeWrite.length;
        chamadasDeWrite.push(linha);
        // Por padrão nunca drena (pior caso — cliente parado). Se o teste
        // passar índices específicos em `escritasQueDrenam`, aquela escrita
        // devolve `true`.
        return escritasQueDrenam.includes(indice);
      },
      on(evento, ouvinte) {
        if (evento === 'drain') ouvintesDeDrain.push(ouvinte);
      },
      end() {
        encerrado = true;
      },
    },
    chamadasDeWrite,
    dispararDrain() {
      for (const ouvinte of ouvintesDeDrain) ouvinte();
    },
    foiEncerrado: () => encerrado,
  };
}

function repositorioFalso() {
  let proximoId = 1;
  return {
    async registrarEventoDeConversa({ conversaId, tipo, payload }) {
      return { id: proximoId++, conversa_id: conversaId, tipo, payload, criado_em: new Date().toISOString() };
    },
    async obterEscopoDaConversa() {
      // Não usado neste teste: os assinantes são 'gestor' (acesso global,
      // não consulta escopo) para isolar o comportamento de backpressure
      // do comportamento de autorização, já coberto por
      // testes/conversas-eventos-escopo.test.js.
      return { estado: 'existe', atribuidoA: null };
    },
  };
}

test('assinante que nunca drena é desconectado após o limite, sem crescer o Set para sempre', async () => {
  const emissor = criarEmissorDeConversas({ repositorio: repositorioFalso() });
  const lento = criarResFalso(); // nunca drena — pior caso
  const cancelarInscricao = emissor.inscrever(lento.res, { depoisDeCursor: 0, usuarioId: 1, papel: 'gestor' });

  assert.equal(emissor.total(), 1, 'assinante inscrito');

  // Publica eventos suficientes para estourar o limite de escritas sem
  // drenar. Cada `publicar` é um evento novo — nenhum é filtrado pelo
  // cursor (todos com id > 0).
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emissor.publicar({ conversaId: 99, tipo: 'erro', payload: {} });
  }

  assert.ok(
    lento.chamadasDeWrite.length < 8,
    'depois de desconectado, eventos seguintes não tentam mais escrever nesse assinante — ' +
      `mas write foi chamado ${lento.chamadasDeWrite.length} vezes para 8 eventos publicados`,
  );
  assert.equal(emissor.total(), 0, 'assinante lento removido do Set — não fica para sempre acumulando buffer');
  assert.ok(lento.foiEncerrado(), 'a conexão do assinante lento precisa ser encerrada (res.end()), não só desinscrita');

  cancelarInscricao(); // idempotente mesmo já removido — não pode lançar
});

test('assinante que drena normalmente nunca é desconectado, mesmo depois de muitos eventos', async () => {
  const emissor = criarEmissorDeConversas({ repositorio: repositorioFalso() });
  const normal = criarResFalso({ escritasQueDrenam: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }); // sempre drena
  emissor.inscrever(normal.res, { depoisDeCursor: 0, usuarioId: 1, papel: 'gestor' });

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emissor.publicar({ conversaId: 99, tipo: 'erro', payload: {} });
  }

  assert.equal(normal.chamadasDeWrite.length, 10, 'todo evento chega a um assinante que drena normalmente');
  assert.equal(emissor.total(), 1, 'assinante normal nunca é desconectado');
  assert.equal(normal.foiEncerrado(), false);
});

test('o evento drain zera o contador — uma escrita ruim isolada não acumula rumo ao limite', async () => {
  const emissor = criarEmissorDeConversas({ repositorio: repositorioFalso() });
  // Nenhuma escrita drena sozinha (índices não listados) — o teste dispara
  // `drain` manualmente entre publicações para simular o socket aliviando.
  const intermitente = criarResFalso();
  emissor.inscrever(intermitente.res, { depoisDeCursor: 0, usuarioId: 1, papel: 'gestor' });

  // Publica 4 eventos que não drenam (abaixo do limite de 5), dispara
  // drain, depois publica mais 4 — se o contador não tivesse zerado, o
  // total (4+4=8) estouraria o limite de 5 antes do fim.
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emissor.publicar({ conversaId: 99, tipo: 'erro', payload: {} });
  }
  assert.equal(emissor.total(), 1, 'ainda abaixo do limite, continua inscrito');

  intermitente.dispararDrain();

  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emissor.publicar({ conversaId: 99, tipo: 'erro', payload: {} });
  }

  assert.equal(emissor.total(), 1, 'drain no meio zera o contador — 4+4 sem reset estouraria o limite de 5, mas com reset não');
});
