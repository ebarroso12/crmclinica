'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');

// Concorrência: dois workers ao mesmo tempo.
//
// Este é o teste que existe para impedir o erro que ninguém vê em
// desenvolvimento — porque em desenvolvimento sempre há um worker só. Em
// produção há dois no dia de um deploy, ou no dia em que alguém sobe uma
// segunda instância para dar conta do volume, e aí o paciente recebe a mesma
// mensagem duas vezes.
//
// A suíte roda contra as duas implementações:
//
//   • memória — a reivindicação seleciona e marca sem `await` no meio, o que em
//     thread única é atômico;
//   • postgres — a reivindicação usa `FOR UPDATE SKIP LOCKED`, com duas conexões
//     de verdade disputando as mesmas linhas.
//
// Sem `CRMCLINICA_TEST_DATABASE_URL`, só a de memória roda. Com ela, o
// PostgreSQL entra na mesma bateria:
//
//   CRMCLINICA_TEST_DATABASE_URL="postgres://..." npm test

const HORA = 60 * 60 * 1000;
const CONSULTA = new Date('2026-08-03T17:00:00.000Z');
const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';

/** Entrega que conta quantas vezes cada referência passou por ela. */
function entregaContadora() {
  const porReferencia = new Map();
  return {
    modo: 'dry_run',
    porReferencia,
    descrever: () => ({ modo: 'dry_run' }),
    async enviar(envelope) {
      // Uma volta pelo event loop no meio do envio: sem isto, o envio seria
      // instantâneo e a corrida que o teste quer provocar nunca aconteceria.
      await new Promise((resolve) => setImmediate(resolve));
      porReferencia.set(envelope.referencia, (porReferencia.get(envelope.referencia) ?? 0) + 1);
      return { entregue: false, modo: 'dry_run', referencia: `dry-run:${envelope.referencia}` };
    },
  };
}

const implementacoes = [
  {
    nome: 'memória',
    async montar() {
      const repositorio = criarRepositorioEmMemoria();
      return { repositorio, encerrar: async () => {} };
    },
  },
];

if (URL_DE_TESTE) {
  implementacoes.push({
    nome: 'postgres',
    async montar() {
      const { criarPool } = require('../src/dados/pool');
      const { criarRepositorio } = require('../src/dados/repositorio');

      const pool = criarPool({ configurado: true, url: URL_DE_TESTE, poolMax: 6, tempoLimiteMs: 10000 });
      await pool.query(`
        TRUNCATE lembretes, agendamentos, disponibilidades, agenda_bloqueios, profissionais,
                 conversa_etiquetas, mensagens, notas_internas, leads, conversas, contatos,
                 sessoes, audit_log, eventos_recebidos, usuarios
        RESTART IDENTITY CASCADE
      `);

      return { repositorio: criarRepositorio(pool), encerrar: () => pool.end() };
    },
  });
}

for (const { nome, montar } of implementacoes) {
  test(`[${nome}] dois workers não enviam o mesmo lembrete duas vezes`, async (t) => {
    const { repositorio, encerrar } = await montar();
    t.after(() => encerrar());

    const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });

    // Vinte agendamentos, cada um com dois lembretes vencidos: fila grande o
    // bastante para os dois workers se cruzarem de verdade.
    const quantos = 20;
    for (let indice = 0; indice < quantos; indice += 1) {
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: `55169999${String(10000 + indice).slice(-5)}`,
        nome: `Paciente ${indice}`,
      });
      const inicio = new Date(CONSULTA.getTime() + indice * HORA);
      const agendamento = await repositorio.criarAgendamento({
        profissionalId: profissional.id,
        contatoId: contato.id,
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      });

      for (const tipo of ['confirmacao_24h', 'confirmacao_2h']) {
        await repositorio.enfileirarLembrete({
          agendamentoId: agendamento.id,
          contatoId: contato.id,
          tipo,
          janela: inicio.toISOString(),
          // Todos vencidos e dentro da tolerância: a fila inteira está pronta.
          agendarPara: new Date(inicio.getTime() - (tipo === 'confirmacao_24h' ? 24 : 2) * HORA).toISOString(),
        });
      }
    }

    const entrega = entregaContadora();
    // Cada worker tem seu próprio serviço, como dois processos teriam.
    const relogio = () => new Date(CONSULTA.getTime() - HORA);
    const criarWorker = (identificador) => ({
      identificador,
      servico: criarServicoDeLembretes({ repositorio, entrega, agora: relogio }),
    });

    const workers = [criarWorker('worker-a'), criarWorker('worker-b')];

    // Os dois trabalham ao mesmo tempo, várias rodadas, até a fila esvaziar.
    for (let rodada = 0; rodada < 6; rodada += 1) {
      await Promise.all(workers.map(({ identificador, servico }) => (
        servico.processarLote({ limite: 8, worker: identificador })
      )));
    }

    // A prova: nenhuma referência passou pela entrega mais de uma vez.
    const repetidas = [...entrega.porReferencia.entries()].filter(([, vezes]) => vezes > 1);
    assert.deepEqual(repetidas, [], 'nenhum lembrete pode ser entregue duas vezes');

    // E a fila terminou coerente: tudo que devia sair, saiu uma vez só.
    const enviados = await repositorio.listarLembretes({ estado: 'enviado', limite: 500 });
    const pendentes = await repositorio.listarLembretes({ estado: 'pendente', limite: 500 });
    const processando = await repositorio.listarLembretes({ estado: 'processando', limite: 500 });

    assert.equal(entrega.porReferencia.size, enviados.length);
    assert.equal(processando.length, 0, 'nenhuma linha pode ficar presa em processando');
    assert.ok(enviados.length + pendentes.length > 0);
  });

  test(`[${nome}] enfileirar em paralelo não cria lembrete duplicado`, async (t) => {
    const { repositorio, encerrar } = await montar();
    t.after(() => encerrar());

    const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });
    const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990000', nome: 'Marina' });
    const agendamento = await repositorio.criarAgendamento({
      profissionalId: profissional.id,
      contatoId: contato.id,
      inicio: CONSULTA.toISOString(),
      fim: new Date(CONSULTA.getTime() + 30 * 60_000).toISOString(),
    });

    // Dez tentativas simultâneas de enfileirar o mesmo lembrete. A constraint
    // `lembretes_unicos` responde por todas: uma cria, nove encontram.
    const tentativas = Array.from({ length: 10 }, () => repositorio.enfileirarLembrete({
      agendamentoId: agendamento.id,
      contatoId: contato.id,
      tipo: 'confirmacao_24h',
      janela: CONSULTA.toISOString(),
      agendarPara: new Date(CONSULTA.getTime() - 24 * HORA).toISOString(),
    }));

    const resultados = await Promise.all(tentativas);
    const criados = resultados.filter((resultado) => resultado.criado);

    assert.equal(criados.length, 1, 'só uma das tentativas pode criar a linha');
    const fila = await repositorio.listarLembretes({ agendamentoId: agendamento.id, limite: 50 });
    assert.equal(fila.length, 1);
    // E todas devolveram o mesmo lembrete, não `null`.
    assert.ok(resultados.every((resultado) => resultado.lembrete?.id === fila[0].id));
  });
}
