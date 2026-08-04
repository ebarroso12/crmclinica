'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { executarDiagnostico } = require('../src/dominio/diagnostico');

/** Sistema inteiro: é a partir daqui que cada teste quebra uma peça só. */
const SAUDAVEL = Object.freeze({
  banco: async () => ({ alcancavel: true, rlsEfetivo: true, usuario: 'crmclinica_app', migrationsPendentes: [] }),
  servicos: async () => [{ nome: 'crmclinica-lembretes', ativo: true, critico: true }],
  canal: async () => ({ vinculado: true, conectado: true, numero: '+5516993120938' }),
  fila: async () => ({ presos: 0, falhados: 0, atrasados: 0, pendentes: 3 }),
  testes: async () => ({ total: 664, passaram: 664, falhas: 0 }),
  serena: async () => ({ desejado: false, aplicado: false }),
});

const comFalha = (parte) => ({ ...SAUDAVEL, ...parte });

test('sistema inteiro não inventa problema', async () => {
  const r = await executarDiagnostico(SAUDAVEL);
  assert.equal(r.saudavel, true);
  assert.equal(r.nivel, 'ok');
  assert.deepEqual(r.achados, []);
});

test('banco fora do ar é crítico', async () => {
  const r = await executarDiagnostico(comFalha({
    banco: async () => ({ alcancavel: false, motivo: 'conexão recusada' }),
  }));
  assert.equal(r.nivel, 'critico');
  assert.ok(r.achados.some((a) => a.area === 'banco'));
});

test('RLS desligado é crítico mesmo com o banco respondendo', async () => {
  // O caso perigoso: tudo funciona, as consultas retornam, e a barreira que
  // separa os dados simplesmente não está lá.
  const r = await executarDiagnostico(comFalha({
    banco: async () => ({ alcancavel: true, rlsEfetivo: false, usuario: 'postgres', migrationsPendentes: [] }),
  }));
  assert.equal(r.nivel, 'critico');
  assert.match(r.achados[0].titulo, /RLS/);
});

test('migration pendente vira achado com reparo automático', async () => {
  const r = await executarDiagnostico(comFalha({
    banco: async () => ({
      alcancavel: true, rlsEfetivo: true, usuario: 'crmclinica_app',
      migrationsPendentes: ['serena_configuracao.agenda'],
    }),
  }));
  const item = r.achados.find((a) => a.titulo.includes('migration'));
  assert.ok(item);
  assert.equal(item.comando, 'aplicar-migrations');
});

test('WhatsApp desconectado é crítico — a clínica para de atender', async () => {
  const r = await executarDiagnostico(comFalha({
    canal: async () => ({ vinculado: false, conectado: false }),
  }));
  assert.equal(r.nivel, 'critico');
});

test('vinculado mas fora do ar é falha, não crítico', async () => {
  // A sessão costuma voltar sozinha; tratar como crítico faria a equipe correr
  // ao servidor por algo que se resolve em dois minutos.
  const r = await executarDiagnostico(comFalha({
    canal: async () => ({ vinculado: true, conectado: false, numero: '+5516993120938' }),
  }));
  assert.equal(r.nivel, 'falha');
});

test('lembrete vencido sem sair denuncia fila parada', async () => {
  const r = await executarDiagnostico(comFalha({
    fila: async () => ({ presos: 0, falhados: 0, atrasados: 7, pendentes: 7 }),
  }));
  const item = r.achados.find((a) => a.titulo.includes('venceram'));
  assert.ok(item);
  assert.equal(item.comando, 'reiniciar:crmclinica-lembretes');
});

test('painel e canal discordando sobre a Serena é crítico', async () => {
  // Foi assim que a equipe descobriu o problema: com paciente na linha, a tela
  // dizendo "desligada" e a Serena respondendo.
  const r = await executarDiagnostico(comFalha({
    serena: async () => ({ desejado: false, aplicado: true }),
  }));
  assert.equal(r.nivel, 'critico');
  assert.match(r.achados[0].titulo, /discordam/);
});

test('uma sonda que estoura não impede as outras de rodar', async () => {
  // Diagnóstico que morre na primeira falha é justamente o que não serve quando
  // várias coisas quebram juntas.
  const r = await executarDiagnostico(comFalha({
    banco: async () => { throw new Error('timeout'); },
    canal: async () => ({ vinculado: false, conectado: false }),
  }));

  assert.ok(r.achados.some((a) => a.titulo.includes('não foi possível verificar')));
  assert.ok(r.achados.some((a) => a.area === 'canal'));
});

test('os achados vêm ordenados por gravidade', async () => {
  const r = await executarDiagnostico(comFalha({
    fila: async () => ({ presos: 0, falhados: 2, atrasados: 0, pendentes: 0 }),
    canal: async () => ({ vinculado: false, conectado: false }),
  }));
  assert.equal(r.achados[0].nivel, 'critico');
});

test('sonda ausente não vira falha — nem toda instalação tem tudo', async () => {
  const r = await executarDiagnostico({ banco: SAUDAVEL.banco });
  assert.equal(r.saudavel, true);
});

test('todo achado diz o que fazer', async () => {
  // Achado sem reparo transfere para quem lê o trabalho de descobrir o que fazer
  // — que é justamente o trabalho que a varredura deveria poupar.
  const r = await executarDiagnostico(comFalha({
    banco: async () => ({ alcancavel: false, motivo: 'x' }),
    canal: async () => ({ vinculado: false, conectado: false }),
    fila: async () => ({ presos: 1, falhados: 1, atrasados: 1, pendentes: 0 }),
    testes: async () => ({ total: 10, passaram: 8, falhas: 2 }),
  }));

  for (const item of r.achados) {
    assert.ok(item.reparo, `achado sem reparo: ${item.titulo}`);
  }
});
