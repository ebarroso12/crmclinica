'use strict';

// Incidente de 22/08: fila, worker, canal e Evolution reportavam "ok" cada um
// isoladamente e mesmo assim nenhuma resposta da Serena chegava ao paciente —
// a causa (credencial da Evolution ausente no `.env` do worker do VPS, um
// ambiente que este processo nem enxerga) não tinha sonda nenhuma que a
// alcançasse. `sondaDeEntregasFalhadas` cobre isso pelo resultado observável
// (entrega que não confirma), não pela causa específica.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sondaDeEntregasFalhadas } = require('../src/dominio/diagnostico-sondas');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('sem nenhuma falha de entrega registrada, total zero', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const sonda = sondaDeEntregasFalhadas(repositorio);

  const resultado = await sonda();

  assert.equal(resultado.total, 0);
});

test('conta resposta_nao_entregue dentro da janela', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({
    entidade: 'conversa', entidadeId: 1, acao: 'resposta_nao_entregue',
    detalhe: { motivo: 'OutboundDeliveryError: No active WhatsApp Web listener' },
  });
  await repositorio.registrarAuditoria({
    entidade: 'conversa', entidadeId: 2, acao: 'resposta_nao_entregue',
    detalhe: { motivo: 'timeout' },
  });

  const sonda = sondaDeEntregasFalhadas(repositorio);
  const resultado = await sonda();

  assert.equal(resultado.total, 2);
});

test('não conta outras ações de auditoria — só resposta_nao_entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({ entidade: 'conversa', entidadeId: 1, acao: 'respondida_pela_automacao' });
  await repositorio.registrarAuditoria({ entidade: 'conversa', entidadeId: 1, acao: 'escalonada' });

  const sonda = sondaDeEntregasFalhadas(repositorio);
  const resultado = await sonda();

  assert.equal(resultado.total, 0);
});

test('não conta falha fora da janela configurada', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.registrarAuditoria({ entidade: 'conversa', entidadeId: 1, acao: 'resposta_nao_entregue' });

  // Janela de 1ms: por essa altura da execução do teste, o registro acima já
  // "envelheceu" mais que isso — não precisa de relógio simulado.
  const sonda = sondaDeEntregasFalhadas(repositorio, { janelaMs: 1 });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  const resultado = await sonda();

  assert.equal(resultado.total, 0);
});
