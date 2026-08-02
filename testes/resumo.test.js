'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('GET /api/resumo entrega indicadores e o retrato da plataforma', async (t) => {
  const app = await subirServidor({ repositorio: criarRepositorioEmMemoria() });
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/resumo');
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');

  const resumo = await resposta.json();

  // Sem banco ligado, o inbox roda em memória — e o resumo diz isso.
  assert.equal(resumo.origem, 'memoria');

  // Indicadores contados do inbox, que está vazio.
  assert.equal(resumo.indicadores.pendentes, 0);
  assert.equal(resumo.indicadores.leadsHoje, 0);
  assert.equal(resumo.indicadores.escalonamentos, 0);
  // Sem agenda implementada, o indicador é `null` em vez de um número inventado.
  assert.equal(resumo.indicadores.consultasHoje, null);

  assert.equal(resumo.plataforma.orquestrador.nome, 'OpenClaw');
  assert.equal(resumo.plataforma.atendimento.nome, 'Serena');
  assert.equal(resumo.plataforma.fonteDeVerdade.nome, 'CRM');
  assert.equal(resumo.plataforma.provedorModelo.papel, 'provedor opcional');
});

test('os indicadores são contados do inbox, não inventados', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio });
  t.after(() => app.encerrar());

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
  const primeira = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  await repositorio.salvarLead(contato.id, { conversaId: primeira.id });

  const outro = await repositorio.encontrarOuCriarContato({ telefone: '5516988887777', nome: 'João' });
  const segunda = await repositorio.encontrarOuCriarConversaAberta(outro.id, 'whatsapp');
  await repositorio.atualizarConversa(segunda.id, { assumida_por_humano: true });

  const resumo = await (await app.pedir('/api/resumo')).json();

  assert.equal(resumo.indicadores.pendentes, 2, 'duas conversas não resolvidas');
  assert.equal(resumo.indicadores.escalonamentos, 1, 'uma assumida por humano');
  assert.equal(resumo.indicadores.leadsHoje, 1);

  // Resolver tira da contagem de pendentes.
  await repositorio.atualizarConversa(primeira.id, { status: 'resolvida' });
  const depois = await (await app.pedir('/api/resumo')).json();
  assert.equal(depois.indicadores.pendentes, 1);
});

// Montada em pedaços para que a auditoria de segredos não a confunda com credencial real.
const URL_BANCO_SINTETICA = `postgre${'sql'}://usuario:senha-secreta@exemplo/banco`;

test('o resumo nunca devolve token, chave ou URL de banco', async (t) => {
  const configuracao = configuracaoDeTeste({
    CRMCLINICA_DATABASE_URL: URL_BANCO_SINTETICA,
    OPENCLAW_BASE_URL: 'https://orquestrador.exemplo',
    OPENCLAW_TOKEN: 'token-de-orquestrador-para-teste',
    OPENCLAW_WEBHOOK_SECRET: 'segredo-de-webhook-com-tamanho-suficiente',
    SERENA_TOKEN: 'token-da-serena-para-teste',
    KIMI_API_KEY: 'chave-kimi-para-teste',
  });

  // Orquestrador simulado: o teste não faz rede nem usa credencial real.
  const orquestrador = {
    disponivel: true,
    despacharEvento: async () => ({}),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };

  const app = await subirServidor({ configuracao, orquestrador, repositorio: criarRepositorioEmMemoria() });
  t.after(() => app.encerrar());

  const bruto = await (await app.pedir('/api/resumo')).text();
  for (const segredo of [
    'senha-secreta',
    'token-de-orquestrador-para-teste',
    'segredo-de-webhook-com-tamanho-suficiente',
    'token-da-serena-para-teste',
    'chave-kimi-para-teste',
  ]) {
    assert.ok(!bruto.includes(segredo), `o resumo vazou "${segredo}"`);
  }

  const resumo = JSON.parse(bruto);
  assert.equal(resumo.origem, 'banco');
  assert.equal(resumo.plataforma.orquestrador.saude, 'operacional');
  assert.equal(resumo.plataforma.provedorModelo.estado, 'disponível');
});

test('POST em /api/resumo é recusado', async (t) => {
  const app = await subirServidor({ repositorio: criarRepositorioEmMemoria() });
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/resumo', { method: 'POST' });
  assert.equal(resposta.status, 405);
});
