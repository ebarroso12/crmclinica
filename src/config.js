'use strict';

// Leitura única do ambiente. Nenhum segredo é impresso, serializado ou devolvido
// por rota HTTP: o restante do sistema só enxerga o resultado de `descreverConfiguracao`.

const crypto = require('node:crypto');
const path = require('node:path');

const NIVEIS_VALIDOS = new Set(['development', 'test', 'production']);

// Segredo de assinatura para desenvolvimento: aleatório a cada processo, para que
// nunca exista um valor "padrão" que alguém acabe levando para produção.
function segredoEfemero() {
  return crypto.randomBytes(48).toString('base64url');
}

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

/** O gateway fala WebSocket: `http(s)` aqui seria um endereço que não conecta. */
function urlWebSocketValida(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  try {
    const url = new URL(bruto);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
    return bruto.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * A chave privada do dispositivo, aceita como PEM direto ou em base64.
 *
 * Base64 existe porque PEM tem quebras de linha, e painel de variável de
 * ambiente (Vercel, systemd) costuma achatá-las — deixando uma chave que parece
 * certa e não carrega.
 */
function decodificarChave(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  if (bruto.includes('BEGIN')) return bruto.replace(/\\n/g, '\n');
  try {
    const decodificado = Buffer.from(bruto, 'base64').toString('utf8');
    return decodificado.includes('BEGIN') ? decodificado : '';
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
      // Gateway WebSocket: é por aqui que a mensagem sai de verdade. O token
      // compartilhado sozinho não concede escopo — quem envia precisa ser um
      // dispositivo pareado. Ver docs/OPENCLAW.md.
      gateway: {
        url: urlWebSocketValida(ambiente.OPENCLAW_GATEWAY_URL),
        token: texto(ambiente.OPENCLAW_GATEWAY_TOKEN),
        deviceToken: texto(ambiente.OPENCLAW_DEVICE_TOKEN),
        // Chave privada do dispositivo. Em ambiente sem disco gravável (Vercel)
        // ela vem do ambiente; fora dele, de um arquivo que o .gitignore cobre.
        chavePrivada: decodificarChave(ambiente.OPENCLAW_DEVICE_PRIVATE_KEY),
        identidadePath: texto(ambiente.OPENCLAW_DEVICE_IDENTITY_PATH)
          || path.join(__dirname, '..', '.openclaw-identidade.json'),
        timeoutMs: inteiro(ambiente.OPENCLAW_GATEWAY_TIMEOUT_MS, 20000),
        canal: texto(ambiente.OPENCLAW_CANAL) || 'whatsapp',
        contaId: texto(ambiente.OPENCLAW_ACCOUNT_ID),
      },
    },
    // Lembretes de agendamento. O modo de entrega é a variável que decide se
    // alguma mensagem sai de fato — e ela é conservadora por padrão: `dry_run`
    // roda a fila inteira sem enviar nada. Ver docs/LEMBRETES.md.
    lembretes: {
      ativos: texto(ambiente.LEMBRETES_ATIVOS).toLowerCase() !== 'nao',
      modoEntrega: texto(ambiente.LEMBRETES_MODO_ENTREGA).toLowerCase() === 'real' ? 'real' : 'dry_run',
      clinica: texto(ambiente.CRMCLINICA_NOME_CLINICA) || 'Clínica Dr. Edson Barroso',
      intervaloMs: inteiro(ambiente.LEMBRETES_INTERVALO_MS, 60 * 1000),
      lote: inteiro(ambiente.LEMBRETES_LOTE, 20),
      maxTentativas: inteiro(ambiente.LEMBRETES_MAX_TENTATIVAS, 5),
    },
    serena: {
      baseUrl: urlValida(ambiente.SERENA_BASE_URL),
      token: texto(ambiente.SERENA_TOKEN),
    },
    autenticacao: {
      // Fora de produção, um segredo efêmero permite subir sem configurar nada;
      // os tokens morrem no reinício, que é o comportamento certo em desenvolvimento.
      segredoJwt: texto(ambiente.CRMCLINICA_JWT_SECRET) || (producao ? '' : segredoEfemero()),
      configurada: Boolean(texto(ambiente.CRMCLINICA_JWT_SECRET)),
      // Endereço público da aplicação, usado nos links de recuperação por e-mail.
      urlPublica: urlValida(ambiente.CRMCLINICA_URL_PUBLICA) || `http://127.0.0.1:${inteiro(ambiente.PORT, 4100)}`,
    },
    // Proxies cujo `X-Forwarded-For` é aceito. Vazio por padrão: confiar no
    // cabeçalho de qualquer origem permitiria forjar o IP e burlar o rate limit.
    proxiesConfiaveis: texto(ambiente.CRMCLINICA_PROXIES_CONFIAVEIS)
      .split(',')
      .map((entrada) => entrada.trim())
      .filter(Boolean),
    // Admin master: conta única que libera as demais. As credenciais iniciais só
    // são usadas para semear a conta; a troca é obrigatória no primeiro acesso.
    master: {
      email: texto(ambiente.CRMCLINICA_MASTER_EMAIL),
      senhaInicial: texto(ambiente.CRMCLINICA_MASTER_SENHA),
      nome: texto(ambiente.CRMCLINICA_MASTER_NOME) || 'Administrador master',
    },
    google: {
      clienteId: texto(ambiente.GOOGLE_CLIENT_ID),
      clienteSegredo: texto(ambiente.GOOGLE_CLIENT_SECRET),
      redirecionamento: urlValida(ambiente.GOOGLE_REDIRECT_URI),
    },
    email: {
      host: texto(ambiente.SMTP_HOST),
      porta: inteiro(ambiente.SMTP_PORT, 587),
      usuario: texto(ambiente.SMTP_USER),
      senha: texto(ambiente.SMTP_PASS),
      // 465 fala TLS desde o primeiro byte; 587 começa em claro e sobe com STARTTLS.
      seguro: inteiro(ambiente.SMTP_PORT, 587) === 465,
      remetente: texto(ambiente.SMTP_FROM),
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

  // Pedir entrega real sem credencial não degrada para dry-run em silêncio: a
  // clínica acharia que está lembrando pacientes e não estaria.
  if (configuracao.lembretes.modoEntrega === 'real'
    && !(configuracao.openclaw.baseUrl && configuracao.openclaw.token)) {
    problemas.push('LEMBRETES_MODO_ENTREGA=real exige OPENCLAW_BASE_URL e OPENCLAW_TOKEN');
  }

  // O inbox é o próprio produto: sem banco, ele não tem onde guardar conversa.
  if (configuracao.producao && !configuracao.banco.configurado) {
    problemas.push('CRMCLINICA_DATABASE_URL é obrigatório em produção');
  }
  // Sem segredo de assinatura não há autenticação — e sem autenticação o inbox
  // não pode ser exposto. Em produção isto impede a subida, não só avisa.
  if (configuracao.producao && !configuracao.autenticacao.configurada) {
    problemas.push('CRMCLINICA_JWT_SECRET é obrigatório em produção');
  }
  if (configuracao.producao && configuracao.autenticacao.segredoJwt.length < 32) {
    problemas.push('CRMCLINICA_JWT_SECRET deve ter ao menos 32 caracteres');
  }

  // Login com Google é tudo ou nada: meia configuração falharia só na hora do uso.
  const partesGoogle = [
    configuracao.google.clienteId,
    configuracao.google.clienteSegredo,
    configuracao.google.redirecionamento,
  ];
  if (partesGoogle.some(Boolean) && !partesGoogle.every(Boolean)) {
    problemas.push('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI precisam ser definidos juntos');
  }
  if (configuracao.producao && configuracao.google.redirecionamento
    && !configuracao.google.redirecionamento.startsWith('https://')) {
    problemas.push('GOOGLE_REDIRECT_URI deve usar HTTPS em produção');
  }

  // Sem SMTP a recuperação de senha não chega a ninguém — em produção isso é falha.
  if (configuracao.producao && !configuracao.email.host) {
    problemas.push('SMTP_HOST é obrigatório em produção para a recuperação de senha funcionar');
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
    entrada: {
      // O que a tela de login deve oferecer. Nenhum segredo sai daqui — só se a
      // opção está ligada ou não.
      google: Boolean(configuracao.google.clienteId && configuracao.google.clienteSegredo),
      recuperacaoPorEmail: Boolean(configuracao.email.host && configuracao.email.remetente),
    },
    lembretes: {
      papel: 'confirmação de agendamento 24h e 2h antes, pelo OpenClaw',
      estado: configuracao.lembretes.ativos ? 'ativos' : 'desligados',
      // Dito por extenso porque a diferença entre "a fila rodou" e "a mensagem
      // chegou" é justamente o que um relatório de sistema costuma esconder.
      entrega: configuracao.lembretes.modoEntrega === 'real'
        ? 'real'
        : 'dry-run (a fila processa e nenhuma mensagem sai)',
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
