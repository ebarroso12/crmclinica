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
  const transporteWhatsapp = texto(ambiente.SERENA_TRANSPORTE_WHATSAPP) || 'openclaw_gerencia';

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
      // Segredo exclusivo da ponte de ingresso do WhatsApp. Separá-lo do
      // webhook genérico impede que uma integração autorizada para importar
      // eventos antigos ganhe, por acidente, o direito de acionar respostas.
      segredoIngressoWhatsapp: texto(ambiente.WHATSAPP_WEBHOOK_SECRET),
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
      // Gateway da instância da clínica: outro processo, outro token, outro
      // WhatsApp. É por ele que os pacientes são atendidos, e é ele que o
      // painel vincula pelo QR. Separado do de comando de propósito.
      canalClinica: {
        url: urlWebSocketValida(ambiente.OPENCLAW_CLINICA_GATEWAY_URL),
        token: texto(ambiente.OPENCLAW_CLINICA_GATEWAY_TOKEN),
        deviceToken: texto(ambiente.OPENCLAW_CLINICA_DEVICE_TOKEN),
        // Identidade própria, sem herdar a do gateway de comando. Herdar
        // parecia conveniente — uma chave a menos para gerir — mas este cliente
        // pede `operator.admin` para vincular canal, e aprovar esse pareamento
        // daria poder de administração à mesma identidade com que o worker de
        // lembretes roda sozinho a noite inteira. São dois dispositivos.
        chavePrivada: decodificarChave(ambiente.OPENCLAW_CLINICA_DEVICE_PRIVATE_KEY),
        identidadePath: texto(ambiente.OPENCLAW_CLINICA_DEVICE_IDENTITY_PATH)
          || path.join(__dirname, '..', '.openclaw-identidade-clinica.json'),
        timeoutMs: inteiro(ambiente.OPENCLAW_CLINICA_GATEWAY_TIMEOUT_MS, 30000),
      },
      // Endereço de administração do servidor do OpenClaw, para a instrução de
      // vinculação manual. Fica fora do `app.js` — que é servido sem login — e
      // só chega a quem é master, pela API.
      hostDeAdministracao: texto(ambiente.OPENCLAW_SSH_HOST),
      // Linha da clínica. Usada só para exibir no painel quando o canal ainda
      // não respondeu qual número está vinculado — nunca para decidir envio.
      numeroWhatsapp: texto(ambiente.WHATSAPP_BUSINESS_PHONE),
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
    // Extração de qualificação (interesse, primeira consulta, pagamento,
    // urgência, disponibilidade) a partir da própria conversa, via IA — em vez
    // de deixar todo lead preso na primeira pergunta pra sempre porque
    // ninguém preencheu a ficha na mão. Nasce DESLIGADA: liga uma chamada de
    // IA por mensagem qualificável, com custo e comportamento de produção
    // novos, e isso exige decisão explícita, não vir de brinde num deploy.
    leadsQualificacaoIa: {
      ativa: texto(ambiente.LEADS_QUALIFICACAO_IA_ATIVA).toLowerCase() === 'sim',
    },
    // Espelho da agenda no Google Calendar do médico. A agenda do crmclinica
    // continua sendo a fonte de verdade — é ela que impede dois pacientes no
    // mesmo horário. O Google é para o dia aparecer no celular, sem abrir o
    // painel. Fica desligado enquanto a credencial não existir.
    googleAgenda: {
      credencial: texto(ambiente.GOOGLE_AGENDA_CREDENCIAL),
      usuario: texto(ambiente.GOOGLE_AGENDA_USUARIO),
      calendario: texto(ambiente.GOOGLE_AGENDA_CALENDARIO) || 'primary',
      timeoutMs: inteiro(ambiente.GOOGLE_AGENDA_TIMEOUT_MS, 15000),
    },
    // Token da API que a Serena usa para operar o CRM: registrar contato,
    // qualificar e mover lead. Próprio, e não o da aplicação — um agente com a
    // credencial da aplicação teria, na prática, todo o poder dela.
    agente: {
      token: texto(ambiente.CRMCLINICA_AGENTE_TOKEN),
    },
    // Resumo do atendimento, enviado à equipe quando a conversa esfria. Os
    // telefones vêm do ambiente: número de pessoa não se escreve em código, e a
    // lista muda quando alguém entra ou sai da clínica.
    // Números da clínica: quem opera, não quem é atendido. Os administradores
    // comandam a Serena e recebem os resumos — o que eles escrevem não é
    // atendimento, não vira contato e não entra no funil.
    numerosInternos: [
      ...texto(ambiente.CRMCLINICA_NUMEROS_INTERNOS).split(',').map((n) => n.trim()).filter(Boolean),
      ...texto(ambiente.CRMCLINICA_RESUMO_DESTINATARIOS).split(',').map((n) => n.trim()).filter(Boolean),
      texto(ambiente.WHATSAPP_BUSINESS_PHONE),
    ].filter(Boolean),
    resumoDeAtendimento: {
      destinatarios: texto(ambiente.CRMCLINICA_RESUMO_DESTINATARIOS)
        .split(',').map((numero) => numero.trim()).filter(Boolean),
      silencioMin: inteiro(ambiente.CRMCLINICA_RESUMO_SILENCIO_MIN, 30),
    },
    serena: {
      baseUrl: urlValida(ambiente.SERENA_BASE_URL),
      token: texto(ambiente.SERENA_TOKEN),
      // Quem responde à mensagem de WhatsApp. O padrão preserva o desenho
      // anterior; `crm_despacha` só entra por configuração explícita e mantém
      // o agente direto do canal calado para o CRM aplicar handoff e horário.
      transporteWhatsapp,
    },
    // Voz roda em processo separado do CRM. A flag nasce desligada e a
    // configuração é tudo-ou-nada: nunca cai para um serviço pago em silêncio.
    serenaVoz: {
      ativa: texto(ambiente.SERENA_VOZ_ATIVA).toLowerCase() === 'sim',
      gatewayUrl: urlWebSocketValida(ambiente.SERENA_VOZ_GATEWAY_URL),
      segredoJwt: texto(ambiente.SERENA_VOZ_JWT_SECRET),
      segredoWebhook: texto(ambiente.SERENA_VOZ_WEBHOOK_SECRET),
      tokenTtlSegundos: Math.min(inteiro(ambiente.SERENA_VOZ_TOKEN_TTL_SEGUNDOS, 60), 300),
      duracaoMaximaSegundos: Math.min(inteiro(ambiente.SERENA_VOZ_DURACAO_MAX_SEGUNDOS, 900), 3600),
      perfil: texto(ambiente.SERENA_VOZ_PERFIL) || 'local-livre',
      voz: texto(ambiente.SERENA_VOZ_VOZ) || 'serena',
    },
    autenticacao: {
      // Fora de produção, um segredo efêmero permite subir sem configurar nada;
      // os tokens morrem no reinício, que é o comportamento certo em desenvolvimento.
      segredoJwt: texto(ambiente.CRMCLINICA_JWT_SECRET) || (producao ? '' : segredoEfemero()),
      configurada: Boolean(texto(ambiente.CRMCLINICA_JWT_SECRET)),
      // Endereço público da aplicação, usado nos links de recuperação por e-mail.
      urlPublica: urlValida(ambiente.CRMCLINICA_URL_PUBLICA) || `http://127.0.0.1:${inteiro(ambiente.PORT, 4100)}`,
      // 2FA obrigatório para master e admin (P1-04). Ligado por padrão; o
      // 'nao' existe para desenvolvimento e para a suíte de testes, que
      // ligaria isto teste a teste — produção não desliga.
      segundoFatorObrigatorio: texto(ambiente.CRMCLINICA_2FA_OBRIGATORIO) !== 'nao',
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
    // Gateway multi-IA. As chaves vivem SÓ aqui, no servidor: o navegador vê
    // provedor e modelo, nunca credencial. Sem chave, o provedor simplesmente
    // não aparece como disponível — nada quebra.
    ia: {
      openaiKey: texto(ambiente.OPENAI_API_KEY),
      anthropicKey: texto(ambiente.ANTHROPIC_API_KEY),
      googleKey: texto(ambiente.GEMINI_API_KEY),
      deepseekKey: texto(ambiente.DEEPSEEK_API_KEY),
      timeoutMs: inteiro(ambiente.IA_TIMEOUT_MS, 30000),
      provedorPadrao: texto(ambiente.IA_PROVEDOR_PADRAO) || null,
    },
  };
}

function validarTransporteWhatsapp(configuracao) {
  const problemas = [];

  if (!['openclaw_gerencia', 'crm_despacha'].includes(configuracao.serena.transporteWhatsapp)) {
    problemas.push('SERENA_TRANSPORTE_WHATSAPP deve ser openclaw_gerencia ou crm_despacha');
  }

  if (configuracao.serena.transporteWhatsapp === 'crm_despacha') {
    const comando = configuracao.openclaw.gateway;
    const canal = configuracao.openclaw.canalClinica;
    if (!comando.url || (!comando.token && !comando.deviceToken)) {
      problemas.push('SERENA_TRANSPORTE_WHATSAPP=crm_despacha exige o gateway de comando do OpenClaw');
    }
    if (!configuracao.openclaw.sessao) {
      problemas.push('SERENA_TRANSPORTE_WHATSAPP=crm_despacha exige OPENCLAW_SESSION_ID');
    }
    if (!canal.url || (!canal.token && !canal.deviceToken)) {
      problemas.push('SERENA_TRANSPORTE_WHATSAPP=crm_despacha exige o gateway do WhatsApp da clínica');
    }
    if (configuracao.openclaw.segredoIngressoWhatsapp.length < 32) {
      problemas.push('SERENA_TRANSPORTE_WHATSAPP=crm_despacha exige WHATSAPP_WEBHOOK_SECRET com ao menos 32 caracteres');
    }
  }

  return problemas;
}

// Lista de problemas que impedem o sistema de operar com segurança em produção.
function validarConfiguracao(configuracao) {
  const problemas = validarTransporteWhatsapp(configuracao);

  if (configuracao.openclaw.baseUrl && configuracao.producao && !configuracao.openclaw.baseUrl.startsWith('https://')) {
    problemas.push('OPENCLAW_BASE_URL deve usar HTTPS em produção');
  }
  if (configuracao.serena.baseUrl && configuracao.producao && !configuracao.serena.baseUrl.startsWith('https://')) {
    problemas.push('SERENA_BASE_URL deve usar HTTPS em produção');
  }
  if (configuracao.serenaVoz.ativa) {
    if (!configuracao.serenaVoz.gatewayUrl) problemas.push('SERENA_VOZ_ATIVA=sim exige SERENA_VOZ_GATEWAY_URL');
    if (configuracao.producao && !configuracao.serenaVoz.gatewayUrl.startsWith('wss://')) {
      problemas.push('SERENA_VOZ_GATEWAY_URL deve usar WSS em produção');
    }
    if (configuracao.serenaVoz.segredoJwt.length < 32) {
      problemas.push('SERENA_VOZ_JWT_SECRET deve ter ao menos 32 caracteres');
    }
    if (configuracao.serenaVoz.segredoWebhook.length < 32) {
      problemas.push('SERENA_VOZ_WEBHOOK_SECRET deve ter ao menos 32 caracteres');
    }
  }
  if (configuracao.producao && !configuracao.openclaw.segredoWebhook) {
    problemas.push('OPENCLAW_WEBHOOK_SECRET é obrigatório em produção');
  }
  if (configuracao.producao && configuracao.openclaw.segredoWebhook.length < 32) {
    problemas.push('OPENCLAW_WEBHOOK_SECRET deve ter ao menos 32 caracteres');
  }

  // Pedir entrega real sem gateway não degrada para dry-run em silêncio: a
  // clínica acharia que está lembrando pacientes e não estaria.
  //
  // A checagem olha para o **gateway**, que é por onde a mensagem sai de fato.
  // Ela já apontou para `OPENCLAW_BASE_URL`/`OPENCLAW_TOKEN` — variáveis do
  // cliente HTTP de eventos — e acusava configuração faltando com o envio
  // funcionando perfeitamente.
  if (configuracao.lembretes.modoEntrega === 'real') {
    const gateway = configuracao.openclaw.gateway;
    if (!gateway.url) {
      problemas.push('LEMBRETES_MODO_ENTREGA=real exige OPENCLAW_GATEWAY_URL');
    } else if (!gateway.token && !gateway.deviceToken) {
      problemas.push('LEMBRETES_MODO_ENTREGA=real exige OPENCLAW_GATEWAY_TOKEN ou OPENCLAW_DEVICE_TOKEN');
    }
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

  return problemas;
}

/**
 * Problemas que degradam alguma função, mas não impedem o sistema de operar.
 *
 * A distinção existe porque tratá-los como bloqueio derrubava o produto inteiro
 * por causa de um recurso auxiliar: sem SMTP, a clínica ficava sem inbox, sem
 * agenda e sem lembretes — para proteger a recuperação de senha por e-mail, que
 * é o único fluxo realmente afetado.
 *
 * O aviso é persistente: aparece no log a cada subida e em `/api/resumo`. Falha
 * localizada e visível é melhor que indisponibilidade total.
 */
function avisosDeConfiguracao(configuracao) {
  const avisos = [];

  if (configuracao.producao && !configuracao.email.host) {
    avisos.push('SMTP_HOST ausente: a recuperação de senha por e-mail não sai — '
      + 'o pedido é registrado em log e a rota responde que está indisponível');
  }
  if (configuracao.producao && configuracao.lembretes.modoEntrega !== 'real') {
    avisos.push('LEMBRETES_MODO_ENTREGA não está em "real": a fila processa e nenhuma mensagem sai');
  }

  return avisos;
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
      transporteWhatsapp: configuracao.serena.transporteWhatsapp,
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

module.exports = {
  carregarConfiguracao,
  validarConfiguracao,
  validarTransporteWhatsapp,
  avisosDeConfiguracao,
  descreverConfiguracao,
};
