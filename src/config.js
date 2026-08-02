'use strict';

// Leitura única do ambiente. Nenhum segredo é impresso, serializado ou devolvido
// por rota HTTP: o restante do sistema só enxerga o resultado de `descreverConfiguracao`.

const NIVEIS_VALIDOS = new Set(['development', 'test', 'production']);

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function inteiro(valor, padrao) {
  const numero = Number.parseInt(texto(valor), 10);
  return Number.isInteger(numero) && numero > 0 ? numero : padrao;
}

function urlValida(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  try {
    const url = new URL(bruto);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return bruto.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function carregarConfiguracao(ambiente = process.env) {
  const nodeEnv = NIVEIS_VALIDOS.has(texto(ambiente.NODE_ENV)) ? texto(ambiente.NODE_ENV) : 'development';
  const producao = nodeEnv === 'production';

  return {
    nodeEnv,
    producao,
    porta: inteiro(ambiente.PORT, 4100),
    // Em produção o processo pode ficar atrás de um proxy; localmente ficamos presos ao loopback.
    endereco: texto(ambiente.HOST) || (producao ? '0.0.0.0' : '127.0.0.1'),
    limiteCorpoBytes: inteiro(ambiente.LIMITE_CORPO_BYTES, 64 * 1024),
    // O banco é a fonte de verdade do inbox: contatos, conversas e mensagens vivem nele.
    banco: {
      configurado: Boolean(texto(ambiente.CRMCLINICA_DATABASE_URL)),
      url: texto(ambiente.CRMCLINICA_DATABASE_URL),
      poolMax: inteiro(ambiente.CRMCLINICA_DB_POOL_MAX, 10),
      tempoLimiteMs: inteiro(ambiente.CRMCLINICA_DB_TIMEOUT_MS, 10000),
    },
    openclaw: {
      // `OPENCLAW_API_URL` tem prioridade quando a API fica em host distinto da interface.
      baseUrl: urlValida(ambiente.OPENCLAW_API_URL) || urlValida(ambiente.OPENCLAW_BASE_URL),
      token: texto(ambiente.OPENCLAW_TOKEN),
      sessao: texto(ambiente.OPENCLAW_SESSION_ID),
      segredoWebhook: texto(ambiente.OPENCLAW_WEBHOOK_SECRET),
      tempoLimiteMs: inteiro(ambiente.OPENCLAW_TIMEOUT_MS, 10000),
    },
    serena: {
      baseUrl: urlValida(ambiente.SERENA_BASE_URL),
      token: texto(ambiente.SERENA_TOKEN),
    },
    // Provedor de modelo é opcional e nunca controla o fluxo do produto.
    kimi: {
      habilitado: Boolean(texto(ambiente.KIMI_API_KEY)),
      chave: texto(ambiente.KIMI_API_KEY),
      baseUrl: urlValida(ambiente.KIMI_BASE_URL) || 'https://api.moonshot.cn/v1',
      modelo: texto(ambiente.KIMI_MODEL) || 'kimi-latest',
    },
  };
}

// Lista de problemas que impedem o sistema de operar com segurança em produção.
function validarConfiguracao(configuracao) {
  const problemas = [];

  if (configuracao.openclaw.baseUrl && configuracao.producao && !configuracao.openclaw.baseUrl.startsWith('https://')) {
    problemas.push('OPENCLAW_BASE_URL deve usar HTTPS em produção');
  }
  if (configuracao.serena.baseUrl && configuracao.producao && !configuracao.serena.baseUrl.startsWith('https://')) {
    problemas.push('SERENA_BASE_URL deve usar HTTPS em produção');
  }
  if (configuracao.producao && !configuracao.openclaw.segredoWebhook) {
    problemas.push('OPENCLAW_WEBHOOK_SECRET é obrigatório em produção');
  }
  if (configuracao.producao && configuracao.openclaw.segredoWebhook.length < 32) {
    problemas.push('OPENCLAW_WEBHOOK_SECRET deve ter ao menos 32 caracteres');
  }

  // O inbox é o próprio produto: sem banco, ele não tem onde guardar conversa.
  if (configuracao.producao && !configuracao.banco.configurado) {
    problemas.push('CRMCLINICA_DATABASE_URL é obrigatório em produção');
  }

  return problemas;
}

// Retrato seguro da configuração: diz o que está ligado sem revelar nenhum valor sensível.
function descreverConfiguracao(configuracao) {
  return {
    ambiente: configuracao.nodeEnv,
    banco: configuracao.banco.configurado ? 'configurado' : 'ausente',
    orquestrador: {
      nome: 'OpenClaw',
      integracao: configuracao.openclaw.baseUrl ? 'configurada' : 'ausente',
      assinaturaWebhook: configuracao.openclaw.segredoWebhook ? 'exigida' : 'ausente',
    },
    atendimento: {
      nome: 'Serena',
      integracao: configuracao.serena.baseUrl ? 'configurada' : 'ausente',
    },
    inbox: {
      nome: 'Inbox do crmclinica',
      papel: 'atendimento da equipe, dentro do próprio produto',
      // O inbox depende só do banco: não há serviço externo de conversas.
      integracao: configuracao.banco.configurado ? 'configurada' : 'ausente',
    },
    provedorModelo: {
      nome: 'Kimi',
      papel: 'provedor opcional',
      estado: configuracao.kimi.habilitado ? 'disponível' : 'não configurado',
    },
  };
}

module.exports = { carregarConfiguracao, validarConfiguracao, descreverConfiguracao };
