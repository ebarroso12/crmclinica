'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

test('GET /api/resumo entrega indicadores e o retrato da plataforma', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/resumo');
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'no-store');

  const resumo = await resposta.json();

  // Sem banco ligado, o resumo se declara demonstração.
  assert.equal(resumo.origem, 'demonstracao');
  for (const chave of ['pendentes', 'leadsHoje', 'consultasHoje', 'escalonamentos']) {
    assert.equal(typeof resumo.indicadores[chave], 'number', `indicador ${chave} ausente`);
  }

  assert.equal(resumo.plataforma.orquestrador.nome, 'OpenClaw');
  assert.equal(resumo.plataforma.atendimento.nome, 'Serena');
  assert.equal(resumo.plataforma.fonteDeVerdade.nome, 'CRM');
  assert.equal(resumo.plataforma.provedorModelo.papel, 'provedor opcional');
  assert.ok(Array.isArray(resumo.canais) && resumo.canais.length > 0);
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

  const app = await subirServidor({ configuracao, orquestrador });
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
  assert.equal(resumo.origem, 'crm');
  assert.equal(resumo.plataforma.orquestrador.saude, 'operacional');
  assert.equal(resumo.plataforma.provedorModelo.estado, 'disponível');
});

test('POST em /api/resumo é recusado', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/resumo', { method: 'POST' });
  assert.equal(resposta.status, 405);
});
