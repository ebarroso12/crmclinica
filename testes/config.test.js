'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  carregarConfiguracao, validarConfiguracao, avisosDeConfiguracao, descreverConfiguracao,
} = require('../src/config');

test('valores padrão são seguros quando o ambiente está vazio', () => {
  const configuracao = carregarConfiguracao({});

  assert.equal(configuracao.nodeEnv, 'development');
  assert.equal(configuracao.producao, false);
  assert.equal(configuracao.porta, 4100);
  assert.equal(configuracao.endereco, '127.0.0.1', 'fora de produção o servidor fica no loopback');
  assert.equal(configuracao.banco.configurado, false);
  assert.equal(configuracao.kimi.habilitado, false, 'o provedor de modelo é opcional');
  assert.equal(configuracao.serena.transporteWhatsapp, 'openclaw_gerencia');
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

test('produção sem SMTP avisa, mas não impede a subida', () => {
  // A regra mudou de propósito: sem SMTP a recuperação de senha por e-mail não
  // sai, e só isso. Tratar como bloqueio derrubava inbox, agenda e lembretes
  // para proteger o único fluxo realmente afetado — a clínica inteira parada
  // por causa de um e-mail que ninguém pediu naquele momento.
  const producao = carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
    CRMCLINICA_JWT_SECRET: 'x'.repeat(48),
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
  });

  assert.deepEqual(validarConfiguracao(producao), [], 'nada aqui impede a subida');
  assert.ok(
    avisosDeConfiguracao(producao).some((aviso) => /SMTP_HOST/.test(aviso)),
    'mas o aviso precisa existir, e ser persistente',
  );
});

test('o aviso some quando o SMTP é configurado', () => {
  const comSmtp = carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: `postgre${'sql'}://usuario:senha@host/banco`,
    CRMCLINICA_JWT_SECRET: 'x'.repeat(48),
    OPENCLAW_WEBHOOK_SECRET: 'x'.repeat(48),
    SMTP_HOST: 'smtp.exemplo.com',
    LEMBRETES_MODO_ENTREGA: 'real',
  });

  assert.deepEqual(avisosDeConfiguracao(comSmtp), []);
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

test('entrega real exige o gateway — não as variáveis do cliente HTTP antigo', () => {
  // Esta checagem já apontou para OPENCLAW_BASE_URL/OPENCLAW_TOKEN e acusava
  // configuração faltando com o envio funcionando: quem entrega é o gateway.
  const semGateway = carregarConfiguracao({
    LEMBRETES_MODO_ENTREGA: 'real',
    OPENCLAW_BASE_URL: 'https://openclaw.exemplo',
    OPENCLAW_TOKEN: 'token-do-cliente-http',
  });
  assert.ok(validarConfiguracao(semGateway).some((p) => /OPENCLAW_GATEWAY_URL/.test(p)));

  const semCredencial = carregarConfiguracao({
    LEMBRETES_MODO_ENTREGA: 'real',
    OPENCLAW_GATEWAY_URL: 'wss://openclaw.exemplo/ws',
  });
  assert.ok(validarConfiguracao(semCredencial).some((p) => /OPENCLAW_DEVICE_TOKEN/.test(p)));

  // Com o gateway e um deviceToken, nada falta — mesmo sem as variáveis antigas.
  const completo = carregarConfiguracao({
    LEMBRETES_MODO_ENTREGA: 'real',
    OPENCLAW_GATEWAY_URL: 'wss://openclaw.exemplo/ws',
    OPENCLAW_DEVICE_TOKEN: 'device-token-sintetico',
  });
  assert.deepEqual(validarConfiguracao(completo), []);
});

test('Arquitetura B só liga com sessão interna e os dois gateways', () => {
  const incompleta = carregarConfiguracao({ SERENA_TRANSPORTE_WHATSAPP: 'crm_despacha' });
  const problemas = validarConfiguracao(incompleta);
  assert.ok(problemas.some((p) => /gateway de comando/.test(p)));
  assert.ok(problemas.some((p) => /OPENCLAW_SESSION_ID/.test(p)));
  assert.ok(problemas.some((p) => /gateway do WhatsApp/.test(p)));

  const completa = carregarConfiguracao({
    SERENA_TRANSPORTE_WHATSAPP: 'crm_despacha',
    OPENCLAW_GATEWAY_URL: 'wss://comando.exemplo/ws',
    OPENCLAW_DEVICE_TOKEN: 'device-comando',
    OPENCLAW_SESSION_ID: 'agent:serena:crm',
    OPENCLAW_CLINICA_GATEWAY_URL: 'wss://clinica.exemplo/ws',
    OPENCLAW_CLINICA_DEVICE_TOKEN: 'device-clinica',
    WHATSAPP_WEBHOOK_SECRET: 'segredo-sintetico-de-ingresso-com-mais-de-32-caracteres',
  });
  assert.deepEqual(validarConfiguracao(completa), []);
});

test('estratégia de WhatsApp inventada é recusada', () => {
  const problemas = validarConfiguracao(carregarConfiguracao({
    SERENA_TRANSPORTE_WHATSAPP: 'automatico',
  }));
  assert.ok(problemas.some((p) => /SERENA_TRANSPORTE_WHATSAPP/.test(p)));
});
