'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarConfiguracao, validarConfiguracao, descreverConfiguracao } = require('../src/config');

test('valores padrão são seguros quando o ambiente está vazio', () => {
  const configuracao = carregarConfiguracao({});

  assert.equal(configuracao.nodeEnv, 'development');
  assert.equal(configuracao.producao, false);
  assert.equal(configuracao.porta, 4100);
  assert.equal(configuracao.endereco, '127.0.0.1', 'fora de produção o servidor fica no loopback');
  assert.equal(configuracao.banco.configurado, false);
  assert.equal(configuracao.kimi.habilitado, false, 'o provedor de modelo é opcional');
});

test('URLs inválidas ou com protocolo estranho são descartadas', () => {
  const configuracao = carregarConfiguracao({
    OPENCLAW_BASE_URL: 'não é uma url',
    SERENA_BASE_URL: 'file:///etc/passwd',
    KIMI_BASE_URL: 'javascript:alert(1)',
  });

  assert.equal(configuracao.openclaw.baseUrl, '');
  assert.equal(configuracao.serena.baseUrl, '');
  assert.equal(configuracao.kimi.baseUrl, 'https://api.moonshot.cn/v1', 'cai no padrão seguro');
});

test('OPENCLAW_API_URL tem prioridade sobre OPENCLAW_BASE_URL', () => {
  const configuracao = carregarConfiguracao({
    OPENCLAW_BASE_URL: 'https://interface.exemplo',
    OPENCLAW_API_URL: 'https://api.exemplo/',
  });

  assert.equal(configuracao.openclaw.baseUrl, 'https://api.exemplo', 'barra final é removida');
});

test('produção exige HTTPS e segredo de webhook forte', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    OPENCLAW_BASE_URL: 'http://orquestrador.exemplo',
    SERENA_BASE_URL: 'http://serena.exemplo',
    OPENCLAW_WEBHOOK_SECRET: 'curto',
  }));

  assert.ok(problemas.some((problema) => /OPENCLAW_BASE_URL.*HTTPS/.test(problema)));
  assert.ok(problemas.some((problema) => /SERENA_BASE_URL.*HTTPS/.test(problema)));
  assert.ok(problemas.some((problema) => /32 caracteres/.test(problema)));
});

test('produção sem banco é recusada — o inbox não teria onde guardar conversa', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
  }));

  assert.ok(problemas.some((problema) => /CRMCLINICA_DATABASE_URL/.test(problema)));
});

test('produção sem segredo de assinatura é recusada', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
  }));

  assert.ok(
    problemas.some((problema) => /CRMCLINICA_JWT_SECRET/.test(problema)),
    'sem autenticação o inbox não pode ser exposto',
  );
});

test('produção sem SMTP é recusada — a recuperação de senha não chegaria a ninguém', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
    CRMCLINICA_JWT_SECRET: 'x'.repeat(48),
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
  }));

  assert.ok(problemas.some((problema) => /SMTP_HOST/.test(problema)));
});

test('login com Google pela metade é recusado', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    GOOGLE_CLIENT_ID: 'id-sintetico.apps.googleusercontent.com',
  }));

  assert.ok(problemas.some((problema) => /GOOGLE_CLIENT_SECRET/.test(problema)));
});

test('produção bem configurada não acusa problema', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
    CRMCLINICA_JWT_SECRET: 'x'.repeat(48),
    OPENCLAW_BASE_URL: 'https://orquestrador.exemplo',
    SERENA_BASE_URL: 'https://serena.exemplo',
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
    SMTP_HOST: 'smtp.exemplo.com',
    SMTP_FROM: 'nao-responda@exemplo.com',
    GOOGLE_CLIENT_ID: 'id-sintetico.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'segredo-sintetico',
    GOOGLE_REDIRECT_URI: 'https://crmclinica.exemplo/api/auth/google/retorno',
  }));

  assert.deepEqual(problemas, []);
});

test('a descrição da configuração nomeia os papéis e não carrega segredo', () => {
  const configuracao = carregarConfiguracao({
    OPENCLAW_TOKEN: 'token-sintetico',
    SERENA_TOKEN: 'token-serena-sintetico',
    KIMI_API_KEY: 'chave-sintetica',
    // Montada em pedaços para não ser confundida com credencial real pela auditoria.
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
  });

  const descricao = descreverConfiguracao(configuracao);
  const serializada = JSON.stringify(descricao);

  assert.equal(descricao.orquestrador.nome, 'OpenClaw');
  assert.equal(descricao.atendimento.nome, 'Serena');
  assert.equal(descricao.provedorModelo.papel, 'provedor opcional');

  for (const segredo of ['token-sintetico', 'token-serena-sintetico', 'chave-sintetica', 'senha']) {
    assert.ok(!serializada.includes(segredo), `a descrição vazou "${segredo}"`);
  }
});
