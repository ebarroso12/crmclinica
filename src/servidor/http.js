'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { carregarConfiguracao } = require('../config');
const { validarEvento, exigirEstrategiaDoAdaptador } = require('../contratos/evento');
const { ErroDeContrato, ErroDeEstrategia } = require('../contratos/erros');
const { criarRegistroEmMemoria } = require('../armazenamento/idempotencia');
const { criarClienteOpenClaw, assinaturaValida } = require('../integracoes/openclaw');
const { criarRepositorioEmMemoria } = require('../dados/repositorio-memoria');
const { montarResumo } = require('../dominio/resumo');
const { criarAtendimento } = require('../dominio/atendimento');
const { criarServicoDeFluxo } = require('../dominio/crm-fluxo');
const { criarServicoDeMetricas } = require('../dominio/metricas');
const { criarGatewayDeIA } = require('../ia/gateway');
const { criarServicoDeAvaliacao } = require('../dominio/avaliacao-ia');
const { criarRotasDeIA } = require('./rotas-ia');
const { criarAutenticacao } = require('../seguranca/sessoes');
const { criarContas } = require('../seguranca/contas');
const { criarLimitador } = require('../seguranca/limite');
const { descobrirIp } = require('./ip');
const { criarClienteGoogle } = require('../seguranca/google');
const { criarRemetente } = require('../seguranca/email');
const { criarRotasDeConversas } = require('./rotas-conversas');
const { criarRotasDeAutenticacao } = require('./rotas-autenticacao');
const { criarRotasDeLeads } = require('./rotas-leads');
const { criarServicoDeLeads } = require('../dominio/leads-servico');
const { criarRotasDeAgenda } = require('./rotas-agenda');
const { criarServicoDeAgenda } = require('../dominio/agenda-servico');
const { criarRotasDeLembretes } = require('./rotas-lembretes');
const { criarServicoDeLembretes } = require('../dominio/lembretes-servico');
const { criarAdaptadorDeLembretes } = require('../integracoes/openclaw-lembretes');
const { criarRotasDaSerena } = require('./rotas-serena');
const { criarVinculoDeCanal } = require('../integracoes/openclaw-vinculo');
const { criarConversaDeTeste } = require('../integracoes/openclaw-conversa');
const { criarServicoDaSerena } = require('../dominio/serena-servico');
const { criarServicoDeVoz } = require('../dominio/serena-voz-servico');
const { criarRotasDeContatos } = require('./rotas-contatos');
const { criarRotasDeDiagnostico } = require('./rotas-diagnostico');
const { criarRotasDeAuditoria } = require('./rotas-auditoria');
const { criarRotasDoAgente } = require('./rotas-agente');
const { criarPoliticaDoCanal } = require('../integracoes/openclaw-politica');
const { criarCanalDeConversas } = require('../integracoes/canal-conversas');
const { criarAgendaDoGoogle } = require('../integracoes/google-agenda');
const { exigirPermissao, ErroDeAutorizacao } = require('../seguranca/rbac');
const { lerCorpoBruto, interpretarJson, ErroCorpoExcedido } = require('./corpo');

const PASTA_PUBLICA = path.join(__dirname, '..', '..', 'public');

// Lista fechada de arquivos servidos. Evita qualquer travessia de caminho por construção.
const ARQUIVOS_PUBLICOS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/estilo.css', ['estilo.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/serena-voz.js', ['serena-voz.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const CABECALHOS_SEGURANCA = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  // A interface só carrega recursos do próprio domínio: sem CDN, sem script inline, sem iframe.
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
});

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8', extras = {}) {
  res.writeHead(status, { ...CABECALHOS_SEGURANCA, ...extras, 'content-type': tipo });
  res.end(corpo);
}

function responderJson(res, status, dados, extras = {}) {
  responder(res, status, JSON.stringify(dados), 'application/json; charset=utf-8', extras);
}

function servirArquivo(res, arquivo, tipo) {
  try {
    // `no-cache` obriga a revalidação: nunca se serve interface velha depois de um deploy.
    responder(res, 200, fs.readFileSync(path.join(PASTA_PUBLICA, arquivo)), tipo, {
      'cache-control': 'no-cache',
    });
  } catch {
    responderJson(res, 404, { erro: 'arquivo não encontrado' });
  }
}

/**
 * Cria o manipulador de requisições.
 * Recebe as dependências por parâmetro para que os testes rodem sem rede e sem segredo real.
 */
function criarAplicacao(dependencias = {}) {
  const configuracao = dependencias.configuracao || carregarConfiguracao();
  const orquestrador = dependencias.orquestrador || criarClienteOpenClaw(configuracao.openclaw, dependencias);
  // Sem banco configurado o inbox roda em memória: dá para desenvolver e testar,
  // mas nada sobrevive ao reinício — e `/api/resumo` diz isso na cara.
  const repositorio = dependencias.repositorio || criarRepositorioEmMemoria();
  const servicoDeLeads = dependencias.servicoDeLeads || criarServicoDeLeads({ repositorio });

  // A fila de lembretes vem cedo porque três camadas a usam: a agenda (marcar,
  // remarcar, cancelar), o atendimento (o paciente que responde "PARAR") e as
  // rotas de consulta. O adaptador é o único que fala com o OpenClaw — e fica em
  // dry-run enquanto o protocolo não estiver confirmado.
  const entregaDeLembretes = dependencias.entregaDeLembretes
    || criarAdaptadorDeLembretes({ ...configuracao.openclaw, modoEntrega: configuracao.lembretes.modoEntrega });
  const servicoDeLembretes = dependencias.servicoDeLembretes || criarServicoDeLembretes({
    repositorio,
    entrega: entregaDeLembretes,
    clinica: configuracao.lembretes.clinica,
    maxTentativas: configuracao.lembretes.maxTentativas,
  });
  const lembretesLigados = configuracao.lembretes.ativos ? servicoDeLembretes : null;

  // A Serena vem antes do atendimento porque o atendimento a consulta antes de
  // responder: o interruptor global tem precedência sobre a regra por conversa.
  const servicoDaSerena = dependencias.servicoDaSerena || criarServicoDaSerena({ repositorio });
  const servicoDeVoz = dependencias.servicoDeVoz || criarServicoDeVoz({
    repositorio, serena: servicoDaSerena, configuracao,
  });

  const canalDeConversas = dependencias.canalDeConversas
    || (configuracao.openclaw.canalClinica.url
      ? criarCanalDeConversas(configuracao.openclaw.canalClinica) : null);

  const atendimento = dependencias.atendimento
    || criarAtendimento({
      repositorio,
      orquestrador,
      leads: servicoDeLeads,
      lembretes: lembretesLigados,
      serena: servicoDaSerena,
      canal: canalDeConversas,
    });

  // Fluxo comercial: sino de acompanhamento, encerramento com resumo interno e
  // formulário de pré-consulta condicionado ao agendamento confirmado.
  const servicoDeFluxo = dependencias.servicoDeFluxo
    || criarServicoDeFluxo({ repositorio, canal: canalDeConversas });

  const servicoDeMetricas = dependencias.servicoDeMetricas
    || criarServicoDeMetricas({ repositorio });

  // Gateway multi-IA: chaves só no servidor, catálogo no banco, fallback
  // técnico e telemetria com chave de idempotência.
  const gatewayDeIA = dependencias.gatewayDeIA
    || criarGatewayDeIA({ configuracao, repositorio });
  const servicoDeAvaliacao = dependencias.servicoDeAvaliacao
    || criarServicoDeAvaliacao({ repositorio });
  const rotasDeIA = criarRotasDeIA({
    repositorio, gateway: gatewayDeIA, metricas: servicoDeMetricas, avaliacao: servicoDeAvaliacao,
  });

  const google = dependencias.google || criarClienteGoogle(configuracao.google, dependencias);
  const remetente = dependencias.remetente || criarRemetente(configuracao.email, dependencias);
  const limitador = dependencias.limitador === null
    ? null
    : dependencias.limitador || criarLimitador({ repositorio });
  const contas = dependencias.contas
    || criarContas({ repositorio, configuracao, remetente, google, limitador });
  const autenticacao = dependencias.autenticacao
    || criarAutenticacao({ repositorio, configuracao, contas, limitador });

  const conversas = criarRotasDeConversas({ repositorio, atendimento });
  const auth = criarRotasDeAutenticacao({ repositorio, autenticacao, contas, google, configuracao });
  const rotasDeLeads = criarRotasDeLeads({ repositorio, leads: servicoDeLeads });

  const agendaDoGoogle = dependencias.agendaDoGoogle || criarAgendaDoGoogle(configuracao.googleAgenda);
  const servicoDeAgenda = dependencias.servicoDeAgenda
    || criarServicoDeAgenda({
      repositorio,
      lembretes: lembretesLigados,
      google: agendaDoGoogle,
      clinica: configuracao.lembretes.clinica,
    });
  const rotasDeAgenda = criarRotasDeAgenda({ repositorio, agenda: servicoDeAgenda });
  // A Serena opera o CRM por aqui: registra contato, consulta agenda e marca.
  const rotasDoAgente = criarRotasDoAgente({
    repositorio, leads: servicoDeLeads, agenda: servicoDeAgenda, configuracao,
  });

  const rotasDeLembretes = criarRotasDeLembretes({ lembretes: servicoDeLembretes, repositorio });
  // A vinculação fala com a instância da clínica — outro gateway, outro token,
  // outro WhatsApp. Sem ela configurada, o painel mostra o botão desabilitado
  // em vez de falhar quando alguém clica.
  const vinculoDoCanal = dependencias.vinculoDoCanal
    || (configuracao.openclaw.canalClinica.url ? criarVinculoDeCanal(configuracao.openclaw.canalClinica) : null);

  // Conversa de teste: fala com a Serena pela sessão do painel, sem tocar no
  // WhatsApp. É o que permite validar o prompt antes de expor ao paciente.
  const conversaDeTeste = dependencias.conversaDeTeste
    || (configuracao.openclaw.canalClinica.url ? criarConversaDeTeste(configuracao.openclaw.canalClinica) : null);

  // Centro operacional: a varredura que pergunta a todas as peças de uma vez se
  // ainda estão inteiras. Usa a mesma política do canal que o worker usa para
  // sincronizar — é assim que ela detecta painel e WhatsApp discordando.
  const politicaDoCanal = dependencias.politicaDoCanal
    || (configuracao.openclaw.canalClinica.url ? criarPoliticaDoCanal(configuracao.openclaw.canalClinica) : null);

  const rotasDeDiagnostico = criarRotasDeDiagnostico({
    repositorio,
    serena: servicoDaSerena,
    pool: dependencias.pool ?? null,
    vinculo: vinculoDoCanal,
    politica: politicaDoCanal,
    googleAgenda: agendaDoGoogle,
  });

  const rotasDaSerena = criarRotasDaSerena({
    serena: servicoDaSerena,
    // O adaptador é quem sabe falar com o gateway: reaproveitá-lo para o status
    // evita uma segunda conexão e garante que a tela mostre o mesmo canal por
    // onde as mensagens realmente saem.
    entregaDeLembretes,
    configuracao,
    vinculo: vinculoDoCanal,
    conversa: conversaDeTeste,
  });
  const rotasDeContatos = criarRotasDeContatos({ repositorio });
  const rotasDeAuditoria = criarRotasDeAuditoria({ repositorio });

  // Cada permissão do RBAC amarrada à rota que a exige. A ausência de entrada
  // aqui não libera nada: quem chega a `tratarRotasDeConversas` já passou por
  // `exigirPermissao`, e rota sem permissão declarada não é roteada.
  const PERMISSAO_POR_ACAO = Object.freeze({
    mensagens: 'conversas:responder',
    assumir: 'conversas:assumir',
    etiquetas: 'conversas:etiquetar',
    estado: 'conversas:resolver',
    temperatura: 'conversas:etiquetar',
    prioridade: 'conversas:priorizar',
    notas: 'conversas:responder',
    ficha: 'contatos:editar',
    // Encerrar é resolver com resumo interno: mesma permissão de resolver.
    encerrar: 'conversas:resolver',
  });

  async function receberEventoDoOrquestrador(req, res) {
    const corpoBruto = await lerCorpoBruto(req, configuracao.limiteCorpoBytes);

    // A assinatura é conferida antes de interpretar o corpo: nada não autenticado é processado.
    const segredo = configuracao.openclaw.segredoWebhook;
    if (segredo) {
      const recebida = req.headers['x-openclaw-assinatura'] || req.headers['x-openclaw-signature'];
      if (!assinaturaValida({ corpoBruto, assinaturaRecebida: recebida, segredo })) {
        responderJson(res, 401, { erro: 'assinatura inválida' });
        return;
      }
    } else if (configuracao.producao) {
      responderJson(res, 503, { erro: 'recepção de eventos indisponível sem segredo configurado' });
      return;
    }

    const validado = validarEvento(interpretarJson(corpoBruto));

    // Quem responde por este evento é decisão desta porta, não do payload.
    // Um evento de WhatsApp sem dono declarado é recusado aqui, fechado: se ele
    // caísse no fluxo de despacho, o CRM reenviaria ao agente uma mensagem que
    // o agente talvez já tenha respondido — e o paciente receberia duas vezes.
    let evento;
    try {
      evento = exigirEstrategiaDoAdaptador(validado, 'openclaw_webhook');
    } catch (erro) {
      if (erro instanceof ErroDeEstrategia) {
        // A recusa fica no livro: sem isso, um integrador com o payload errado
        // veria 422 e ninguém da clínica saberia que eventos estão sendo barrados.
        await repositorio.registrarAuditoria({
          entidade: 'evento',
          entidadeId: null,
          acao: 'evento_recusado_estrategia',
          detalhe: {
            canal: validado.canal,
            estrategia_declarada: validado.estrategia_ia,
            codigo: erro.codigo,
          },
        }).catch(() => {});
      }
      throw erro;
    }

    // Idempotência: o mesmo evento reenviado devolve o mesmo resultado, sem reprocessar.
    const jaProcessado = await repositorio.consultarEvento(evento.chave_idempotencia);
    if (jaProcessado) {
      responderJson(res, 200, { ...jaProcessado, duplicado: true });
      return;
    }

    // A mensagem entra no inbox: vira contato, conversa e linha no histórico.
    const resultado = await conversas.receberMensagemDeCanal(evento);

    const recibo = {
      aceito: true,
      duplicado: false,
      chave_idempotencia: evento.chave_idempotencia,
      tipo: evento.tipo,
      canal: evento.canal,
      // Quem é o dono da resposta, e o que o transporte fez de fato: junto com
      // `decisao`, é o que permite auditar "importou sem reenviar" de fora.
      estrategia_ia: evento.estrategia_ia,
      decisao_transporte: resultado.ia_despachada === false
        ? 'importada_sem_despacho'
        : 'despacho_pelo_crm',
      conversa_id: resultado.conversa_id ?? null,
      decisao: resultado.acao,
      recebido_em: new Date().toISOString(),
    };

    await repositorio.registrarEvento(evento.chave_idempotencia, recibo);
    responderJson(res, 202, recibo);
  }

  async function lerJson(req) {
    return interpretarJson(await lerCorpoBruto(req, configuracao.limiteCorpoBytes));
  }

  // Rotas de conta e sessão. Ficam fora do RBAC por definição: é aqui que a
  // identidade nasce. Cada uma protege a si mesma.
  async function tratarRotasDeAutenticacao(req, res, rota, metodo, url, usuario) {
    const deConta = rota.startsWith('/api/auth')
      || rota.startsWith('/api/usuarios')
      || rota === '/api/perfil';
    if (!deConta) return false;

    const contexto = {
      agente: (req.headers['user-agent'] || '').slice(0, 300) || null,
      // Atrás de proxy, o IP da conexão é o do proxy — e o limite valeria para
      // todo mundo junto. `descobrirIp` só lê `X-Forwarded-For` de proxy declarado.
      ip: descobrirIp(req, configuracao.proxiesConfiaveis),
    };
    const semCache = { 'cache-control': 'no-store' };

    // Rotas simples, mapeadas por método e caminho.
    const mapa = {
      'GET /api/auth/opcoes': () => auth.opcoesDeEntrada(),
      'POST /api/auth/login': async () => auth.entrar(await lerJson(req), contexto),
      'POST /api/auth/refresh': async () => auth.renovar(await lerJson(req), contexto),
      'POST /api/auth/logout': async () => auth.sair(await lerJson(req)),
      'GET /api/auth/sessao': () => auth.sessaoAtual(usuario),
      'POST /api/auth/cadastro': async () => auth.cadastrar(await lerJson(req)),
      'GET /api/auth/google': () => auth.iniciarGoogle(),
      'GET /api/auth/google/retorno': () => auth.retornoGoogle(url.searchParams, contexto),
      'POST /api/auth/senha': async () => auth.trocarSenha(usuario, await lerJson(req)),
      'POST /api/auth/recuperar': async () => auth.pedirRecuperacao(await lerJson(req), contexto),
      'POST /api/auth/redefinir': async () => auth.redefinirSenha(await lerJson(req), contexto),
      'POST /api/auth/segundo-fator': () => auth.prepararSegundoFator(usuario),
      'POST /api/auth/segundo-fator/confirmar': async () => auth.confirmarSegundoFator(usuario, await lerJson(req)),
      'POST /api/auth/segundo-fator/desativar': async () => auth.desativarSegundoFator(usuario, await lerJson(req)),
      'PUT /api/perfil': async () => auth.atualizarPerfil(usuario, await lerJson(req)),
      'GET /api/usuarios': () => auth.listarUsuarios(usuario, url.searchParams),
      'POST /api/usuarios': async () => auth.criarUsuario(usuario, await lerJson(req)),
    };

    const acao = mapa[`${metodo} ${rota}`];
    if (acao) {
      const resultado = await acao();
      responderJson(res, metodo === 'POST' && rota === '/api/usuarios' ? 201 : 200, resultado, semCache);
      return true;
    }

    // /api/usuarios/:id/situacao e /papel — exclusivas do master.
    const partes = rota.split('/').filter(Boolean);
    if (partes[0] === 'api' && partes[1] === 'usuarios' && partes.length === 4) {
      if (metodo !== 'POST') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
        return true;
      }

      const sobre = {
        situacao: (corpo) => auth.definirSituacao(usuario, partes[2], corpo),
        papel: (corpo) => auth.definirPapel(usuario, partes[2], corpo),
        // Recuperação sem e-mail: o master gera uma senha temporária e entrega
        // pessoalmente. Não lê corpo — não há nada a informar.
        senha: () => auth.definirSenhaTemporaria(usuario, partes[2]),
      }[partes[3]];

      if (sobre) {
        // A redefinição de senha não recebe nada: exigir um corpo JSON vazio
        // ali faria a rota responder 400 para uma requisição correta.
        const corpo = partes[3] === 'senha' ? null : await lerJson(req);
        responderJson(res, 200, await sobre(corpo), semCache);
        return true;
      }
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
    return true;
  }

  // Rotas da Serena: estado, interruptor, prompt e regras.
  async function tratarRotasDaSerena(req, res, rota, metodo, url, usuario) {
    // `/api/diagnostico` vive no mapa desta função; o prefixo sozinho o
    // deixaria de fora e a rota responderia 404 com o botão da tela quebrado.
    if (!rota.startsWith('/api/serena') && rota !== '/api/diagnostico') return false;
    const semCache = { 'cache-control': 'no-store' };

    if (rota === '/api/serena/voz/status' && metodo === 'GET') {
      responderJson(res, 200, await servicoDeVoz.status(usuario), semCache);
      return true;
    }
    if (rota === '/api/serena/voz/sessoes' && metodo === 'POST') {
      responderJson(res, 201, await servicoDeVoz.criarSessao(usuario, await lerJson(req)), semCache);
      return true;
    }
    const partesDaVoz = rota.split('/').filter(Boolean);
    if (partesDaVoz.length === 6 && partesDaVoz[2] === 'voz'
        && partesDaVoz[3] === 'sessoes' && partesDaVoz[5] === 'encerrar') {
      if (metodo !== 'POST') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
        return true;
      }
      responderJson(res, 200, await servicoDeVoz.encerrarSessao(usuario, partesDaVoz[4]), semCache);
      return true;
    }

    const simples = {
      'GET /api/serena': () => rotasDaSerena.painel(usuario),
      'GET /api/serena/status': () => rotasDaSerena.status(usuario),
      'POST /api/serena/estado': async () => rotasDaSerena.definirEstado(usuario, await lerJson(req)),
      'GET /api/serena/prompts': () => rotasDaSerena.listarPrompts(usuario),
      'POST /api/serena/prompts': async () => rotasDaSerena.criarPrompt(usuario, await lerJson(req)),
      'GET /api/serena/regras': () => rotasDaSerena.listarRegras(usuario, url.searchParams),
      'GET /api/serena/canal': () => rotasDaSerena.estadoDoCanal(usuario),
      'GET /api/serena/canal/risco': () => rotasDaSerena.riscoDoCanal(usuario),
      'GET /api/diagnostico': () => rotasDeDiagnostico.varrer(usuario),
      'GET /api/serena/teste': () => rotasDaSerena.lerTeste(usuario, url),
      // Abrir não exige corpo: o modelo é opcional, e recusar com "corpo vazio"
      // faria a rota rejeitar exatamente o uso mais simples que ela suporta.
      'POST /api/serena/teste': async () => rotasDaSerena.abrirTeste(usuario, await lerJson(req).catch(() => ({}))),
      'POST /api/serena/teste/mensagem': async () => rotasDaSerena.enviarNoTeste(usuario, await lerJson(req)),
      'POST /api/serena/canal/qr': () => rotasDaSerena.obterQrDoCanal(usuario),
      // Horário programado, pausa de intervenção e plantão esporádico.
      'PUT /api/serena/horario': async () => rotasDaSerena.definirHorario(usuario, await lerJson(req)),
      // Ativação gradual: religar por fração determinística ou por lista.
      'PUT /api/serena/ativacao': async () => rotasDaSerena.definirAtivacao(usuario, await lerJson(req)),
      'POST /api/serena/ativacao/contatos': async () => rotasDaSerena.definirContatoDeAtivacao(usuario, await lerJson(req)),
      'POST /api/serena/pausa': async () => rotasDaSerena.pausar(usuario, await lerJson(req)),
      'DELETE /api/serena/pausa': () => rotasDaSerena.despausar(usuario),
      'POST /api/serena/plantao': async () => rotasDaSerena.ligarPorTempo(usuario, await lerJson(req)),
      'POST /api/serena/regras': async () => rotasDaSerena.criarRegra(usuario, await lerJson(req)),
    };

    const acao = simples[`${metodo} ${rota}`];
    if (acao) {
      const criou = metodo === 'POST' && (rota === '/api/serena/prompts' || rota === '/api/serena/regras');
      responderJson(res, criou ? 201 : 200, await acao(), semCache);
      return true;
    }

    const partes = rota.split('/').filter(Boolean);

    // /api/serena/prompts/:id  e  /api/serena/prompts/:id/publicar
    if (partes[2] === 'prompts' && partes.length >= 4) {
      if (partes.length === 4) {
        if (metodo !== 'PUT') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'PUT' });
          return true;
        }
        responderJson(res, 200, await rotasDaSerena.editarPrompt(usuario, partes[3], await lerJson(req)), semCache);
        return true;
      }
      if (partes.length === 5 && partes[4] === 'publicar' && metodo === 'POST') {
        responderJson(res, 200, await rotasDaSerena.publicarPrompt(usuario, partes[3]), semCache);
        return true;
      }
    }

    // /api/serena/regras/:id  e  /api/serena/regras/:id/ativa
    if (partes[2] === 'regras' && partes.length >= 4) {
      if (partes.length === 4) {
        if (metodo === 'PUT') {
          responderJson(res, 200, await rotasDaSerena.editarRegra(usuario, partes[3], await lerJson(req)), semCache);
          return true;
        }
        if (metodo === 'DELETE') {
          responderJson(res, 200, await rotasDaSerena.removerRegra(usuario, partes[3]), semCache);
          return true;
        }
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'PUT, DELETE' });
        return true;
      }
      if (partes.length === 5 && partes[4] === 'ativa' && metodo === 'POST') {
        responderJson(res, 200, await rotasDaSerena.definirRegraAtiva(usuario, partes[3], await lerJson(req)), semCache);
        return true;
      }
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
    return true;
  }

  // Rotas da fila de lembretes. Devolve `true` quando tratou a requisição.
  async function tratarRotasDeLembretes(req, res, rota, metodo, url, usuario) {
    if (!rota.startsWith('/api/lembretes')) return false;
    const semCache = { 'cache-control': 'no-store' };

    const simples = {
      'GET /api/lembretes': () => rotasDeLembretes.listar(usuario, url.searchParams),
      'GET /api/lembretes/vocabulario': () => rotasDeLembretes.vocabulario(usuario),
      'GET /api/lembretes/resumo': () => rotasDeLembretes.resumo(usuario),
      'GET /api/lembretes/falhas': () => rotasDeLembretes.falhas(usuario),
      'POST /api/lembretes/sincronizar': () => rotasDeLembretes.sincronizar(usuario),
    };

    const acao = simples[`${metodo} ${rota}`];
    if (acao) {
      responderJson(res, 200, await acao(), semCache);
      return true;
    }

    // /api/lembretes/:id/reenfileirar
    const partes = rota.split('/').filter(Boolean);
    if (partes.length === 4 && partes[3] === 'reenfileirar') {
      if (metodo !== 'POST') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
        return true;
      }
      responderJson(res, 200, await rotasDeLembretes.reenfileirar(usuario, partes[2]), semCache);
      return true;
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
    return true;
  }

  // Rotas da agenda. Devolve `true` quando tratou a requisição.
  async function tratarRotasDeAgenda(req, res, rota, metodo, url, usuario) {
    if (!rota.startsWith('/api/agenda')) return false;
    const semCache = { 'cache-control': 'no-store' };

    const simples = {
      'GET /api/agenda': () => rotasDeAgenda.listar(usuario, url.searchParams),
      'GET /api/agenda/vocabulario': () => rotasDeAgenda.vocabulario(usuario),
      'GET /api/agenda/horarios': () => rotasDeAgenda.horariosLivres(usuario, url.searchParams),
      'GET /api/agenda/profissionais': () => rotasDeAgenda.listarProfissionais(usuario),
      'POST /api/agenda/profissionais': async () => rotasDeAgenda.criarProfissional(usuario, await lerJson(req)),
      'POST /api/agenda/bloqueios': async () => rotasDeAgenda.criarBloqueio(usuario, await lerJson(req)),
      // Propor não grava; confirmar grava. Os dois passos são a proteção contra
      // marcar consulta que a pessoa não pediu.
      'POST /api/agenda/propor': async () => rotasDeAgenda.propor(usuario, await lerJson(req)),
      'POST /api/agenda/confirmar': async () => rotasDeAgenda.confirmar(usuario, await lerJson(req)),
    };

    const acao = simples[`${metodo} ${rota}`];
    if (acao) {
      responderJson(res, 200, await acao(), semCache);
      return true;
    }

    const partes = rota.split('/').filter(Boolean);

    // /api/agenda/profissionais/:id/disponibilidade
    if (partes[2] === 'profissionais' && partes[4] === 'disponibilidade' && partes.length === 5) {
      if (metodo !== 'PUT') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'PUT' });
        return true;
      }
      responderJson(res, 200, await rotasDeAgenda.definirDisponibilidade(usuario, partes[3], await lerJson(req)));
      return true;
    }

    // /api/agenda/bloqueios/:id
    if (partes[2] === 'bloqueios' && partes.length === 4) {
      if (metodo !== 'DELETE') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'DELETE' });
        return true;
      }
      responderJson(res, 200, await rotasDeAgenda.removerBloqueio(usuario, partes[3]));
      return true;
    }

    // GET /api/agenda/:id/lembretes — o que a fila tem sobre este agendamento.
    if (partes.length === 4 && partes[3] === 'lembretes' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeLembretes.doAgendamento(usuario, partes[2]), semCache);
      return true;
    }

    // /api/agenda/:id/remarcar | /cancelar | /status
    if (partes.length === 4) {
      const acoes = {
        remarcar: (corpo) => rotasDeAgenda.remarcar(usuario, partes[2], corpo),
        cancelar: (corpo) => rotasDeAgenda.cancelar(usuario, partes[2], corpo),
        status: (corpo) => rotasDeAgenda.definirStatus(usuario, partes[2], corpo),
      };
      const sobre = acoes[partes[3]];

      if (sobre) {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return true;
        }
        responderJson(res, 200, await sobre(await lerJson(req)), semCache);
        return true;
      }
    }

    responderJson(res, 404, { erro: 'rota não encontrada' });
    return true;
  }

  // Rotas da camada de conversas. Devolve `true` quando tratou a requisição.
  // Toda rota daqui exige autenticação e a permissão declarada.
  async function tratarRotasDeConversas(req, res, rota, metodo, url, usuario) {
    if (rota === '/api/conversas/filas' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      responderJson(res, 200, await conversas.listarFilas());
      return true;
    }

    if (rota === '/api/conversas' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      responderJson(res, 200, await conversas.listarConversas(url.searchParams), { 'cache-control': 'no-store' });
      return true;
    }

    if (rota === '/api/leads' && metodo === 'GET') {
      exigirPermissao(usuario, 'leads:ler');
      const kanban = await conversas.listarLeads(await rotasDeLeads.listarParaKanban());
      responderJson(res, 200, kanban, { 'cache-control': 'no-store' });
      return true;
    }

    if (rota === '/api/leads/vocabulario' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeLeads.vocabulario(usuario));
      return true;
    }

    // --- IA: menus, relatório, assistente, telemetria e avaliações ---
    if (rota === '/api/ia/modelos' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeIA.catalogo(usuario), { 'cache-control': 'no-store' });
      return true;
    }
    if (rota === '/api/ia/relatorio' && metodo === 'POST') {
      responderJson(res, 200, await rotasDeIA.relatorio(usuario, await lerJson(req).catch(() => ({}))));
      return true;
    }
    if (rota === '/api/ia/assistente' && metodo === 'POST') {
      responderJson(res, 200, await rotasDeIA.assistente(usuario, await lerJson(req)));
      return true;
    }
    if (rota === '/api/ia/chamadas' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeIA.telemetria(usuario), { 'cache-control': 'no-store' });
      return true;
    }
    if (rota === '/api/ia/avaliacoes' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeIA.listarAvaliacoes(usuario, url.searchParams), { 'cache-control': 'no-store' });
      return true;
    }
    if (rota === '/api/ia/avaliacoes/varrer' && metodo === 'POST') {
      responderJson(res, 200, await rotasDeIA.varrerAvaliacoes(usuario));
      return true;
    }

    // --- Central de notificações (o sino do topo) ---
    if (rota === '/api/notificacoes' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      const notificacoes = await repositorio.listarNotificacoes({
        usuarioId: usuario.id,
        apenasNaoLidas: url.searchParams.get('todas') !== 'sim',
      });
      responderJson(res, 200, { total: notificacoes.length, notificacoes }, { 'cache-control': 'no-store' });
      return true;
    }
    {
      const partesDeNotificacao = rota.split('/').filter(Boolean);
      if (partesDeNotificacao[0] === 'api' && partesDeNotificacao[1] === 'notificacoes'
          && partesDeNotificacao.length === 4 && partesDeNotificacao[3] === 'lida'
          && /^\d+$/.test(partesDeNotificacao[2])) {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return true;
        }
        exigirPermissao(usuario, 'conversas:ler');
        const notificacao = await repositorio.marcarNotificacaoLida(partesDeNotificacao[2]);
        if (!notificacao) {
          responderJson(res, 404, { erro: 'notificação não encontrada ou já lida' });
          return true;
        }
        responderJson(res, 200, { notificacao });
        return true;
      }
    }

    // GET /api/metricas/resumo — o resumo dos dashboards, com período, fuso,
    // filtros e denominadores explícitos (docs/METRICAS.md).
    if (rota === '/api/metricas/resumo' && metodo === 'GET') {
      exigirPermissao(usuario, 'leads:ler');
      responderJson(res, 200, await servicoDeMetricas.resumo({
        de: url.searchParams.get('de'),
        ate: url.searchParams.get('ate'),
      }), { 'cache-control': 'no-store' });
      return true;
    }

    // GET /api/conversas/aguardando — a fila de SLA: quem o paciente espera.
    // Antes do bloco genérico de /api/conversas/:id, que trataria "aguardando"
    // como identificador.
    if (rota === '/api/conversas/aguardando' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      const fila = await repositorio.listarConversasAguardando({ limite: 100 });
      const agora = Date.now();
      responderJson(res, 200, {
        total: fila.length,
        conversas: fila.map((conversa) => ({
          ...conversa,
          minutos_aguardando: Math.floor(
            (agora - new Date(conversa.aguardando_resposta_desde).getTime()) / 60_000,
          ),
        })),
      }, { 'cache-control': 'no-store' });
      return true;
    }

    // Tarefas — o sino da equipe.
    if (rota === '/api/tarefas' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      const abertas = url.searchParams.get('todas') !== 'sim';
      const tarefas = await repositorio.listarTarefas({ abertas });
      responderJson(res, 200, { total: tarefas.length, tarefas }, { 'cache-control': 'no-store' });
      return true;
    }
    if (rota === '/api/tarefas/varrer' && metodo === 'POST') {
      exigirPermissao(usuario, 'conversas:priorizar');
      responderJson(res, 200, await servicoDeFluxo.gerarTarefasDeAcompanhamento());
      return true;
    }
    {
      const partesDeTarefa = rota.split('/').filter(Boolean);
      if (partesDeTarefa[0] === 'api' && partesDeTarefa[1] === 'tarefas'
          && partesDeTarefa.length === 4 && partesDeTarefa[3] === 'concluir'
          && /^\d+$/.test(partesDeTarefa[2])) {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return true;
        }
        exigirPermissao(usuario, 'conversas:responder');
        const tarefa = await repositorio.concluirTarefa(partesDeTarefa[2], { usuarioId: usuario.id });
        if (!tarefa) {
          responderJson(res, 404, { erro: 'tarefa não encontrada ou já concluída' });
          return true;
        }
        responderJson(res, 200, { tarefa });
        return true;
      }
    }

    // POST /api/agenda/:id/formulario — pré-consulta, SÓ com agendamento
    // confirmado. Antes do roteador da agenda, que não conhece esta sub-rota.
    {
      const partesDeAgenda = rota.split('/').filter(Boolean);
      if (partesDeAgenda[0] === 'api' && partesDeAgenda[1] === 'agenda'
          && partesDeAgenda.length === 4 && partesDeAgenda[3] === 'formulario'
          && /^\d+$/.test(partesDeAgenda[2])) {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return true;
        }
        exigirPermissao(usuario, 'conversas:responder');
        responderJson(res, 200, await servicoDeFluxo.enviarFormularioPreConsulta(
          Number(partesDeAgenda[2]), { usuarioId: usuario.id },
        ));
        return true;
      }
    }

    if (await tratarRotasDeAgenda(req, res, rota, metodo, url, usuario)) return true;
    if (await tratarRotasDeLembretes(req, res, rota, metodo, url, usuario)) return true;
    if (await tratarRotasDaSerena(req, res, rota, metodo, url, usuario)) return true;

    const partes = rota.split('/').filter(Boolean);

    // /api/contatos/gestao — a tela de gestão. Fica antes da busca simples
    // porque "gestao" seria interpretado como identificador de contato.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes[2] === 'gestao' && partes.length === 3) {
      if (metodo !== 'GET') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
        return true;
      }
      responderJson(res, 200, await rotasDeContatos.listar(usuario, url.searchParams), { 'cache-control': 'no-store' });
      return true;
    }

    // POST /api/contatos — cadastro manual.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes.length === 2 && metodo === 'POST') {
      responderJson(res, 201, await rotasDeContatos.criar(usuario, await lerJson(req)));
      return true;
    }

    // /api/contatos/:id — ficha, edição e exclusão lógica.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes.length === 3 && /^\d+$/.test(partes[2])) {
      const acoes = {
        GET: async () => rotasDeContatos.obter(usuario, partes[2]),
        PUT: async () => rotasDeContatos.editar(usuario, partes[2], await lerJson(req)),
        DELETE: async () => rotasDeContatos.excluir(usuario, partes[2], await lerJson(req).catch(() => ({}))),
      };
      const acao = acoes[metodo];
      if (!acao) {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET, PUT, DELETE' });
        return true;
      }
      responderJson(res, 200, await acao(), { 'cache-control': 'no-store' });
      return true;
    }

    // POST /api/contatos/:id/restaurar — desfaz a exclusão lógica.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes[3] === 'restaurar' && partes.length === 4) {
      if (metodo !== 'POST') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
        return true;
      }
      responderJson(res, 200, await rotasDeContatos.restaurar(usuario, partes[2]));
      return true;
    }

    // /api/leads/:id e suas ações.
    if (partes[0] === 'api' && partes[1] === 'leads' && partes.length >= 3 && partes[2] !== 'vocabulario') {
      const leadId = partes[2];

      if (partes.length === 3) {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return true;
        }
        responderJson(res, 200, await rotasDeLeads.obter(usuario, leadId), { 'cache-control': 'no-store' });
        return true;
      }

      if (partes.length === 4 && partes[3] === 'jornada' && metodo === 'GET') {
        responderJson(res, 200, await rotasDeLeads.jornada(usuario, leadId), { 'cache-control': 'no-store' });
        return true;
      }

      const acoesDeLead = {
        qualificacao: (corpo) => rotasDeLeads.qualificar(usuario, leadId, corpo),
        estagio: (corpo) => rotasDeLeads.moverEstagio(usuario, leadId, corpo),
        temperatura: (corpo) => rotasDeLeads.definirTemperatura(usuario, leadId, corpo),
        gestao: (corpo) => rotasDeLeads.definirGestao(usuario, leadId, corpo),
      };

      const acaoDeLead = partes.length === 4 ? acoesDeLead[partes[3]] : null;
      if (acaoDeLead) {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return true;
        }
        responderJson(res, 200, await acaoDeLead(await lerJson(req)));
        return true;
      }
    }

    // GET /api/contatos?busca= — escolher o paciente ao marcar na agenda.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes.length === 2) {
      if (metodo !== 'GET') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
        return true;
      }
      exigirPermissao(usuario, 'contatos:ler');

      // Sem termo devolve lista vazia em vez de despejar a base inteira: a rota
      // serve para achar alguém, não para exportar contatos.
      const contatos = await repositorio.buscarContatos({
        termo: url.searchParams.get('busca') ?? '',
        limite: 10,
      });
      responderJson(res, 200, { contatos }, { 'cache-control': 'no-store' });
      return true;
    }

    // POST /api/contatos/:id/lembretes — o opt-out do paciente, com auditoria.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes[3] === 'lembretes' && partes.length === 4) {
      if (metodo !== 'POST') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
        return true;
      }
      responderJson(res, 200, await rotasDeLembretes.definirOptOut(usuario, partes[2], await lerJson(req)));
      return true;
    }

    // GET /api/contatos/:id/conversas — histórico ao clicar no nome do contato.
    if (partes[0] === 'api' && partes[1] === 'contatos' && partes[3] === 'conversas' && partes.length === 4) {
      if (metodo !== 'GET') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
        return true;
      }
      exigirPermissao(usuario, 'contatos:ler');
      responderJson(res, 200, await conversas.historicoDoContato(partes[2]), { 'cache-control': 'no-store' });
      return true;
    }

    // /api/conversas/:id e suas ações.
    if (partes[0] !== 'api' || partes[1] !== 'conversas' || partes.length < 3) return false;

    const conversaId = partes[2];

    if (partes.length === 3) {
      if (metodo !== 'GET') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
        return true;
      }
      exigirPermissao(usuario, 'conversas:ler');
      responderJson(res, 200, await conversas.obterConversa(conversaId), { 'cache-control': 'no-store' });
      return true;
    }
    if (partes.length !== 4) return false;

    // A agenda vista de dentro da conversa: é como a recepção marca sem sair da thread.
    if (partes[3] === 'agenda' && metodo === 'GET') {
      responderJson(res, 200, await rotasDeAgenda.daConversa(usuario, conversaId), { 'cache-control': 'no-store' });
      return true;
    }

    // A thread é a única sub-rota que também responde a GET.
    if (partes[3] === 'mensagens' && metodo === 'GET') {
      exigirPermissao(usuario, 'conversas:ler');
      responderJson(res, 200, await conversas.listarMensagens(conversaId), { 'cache-control': 'no-store' });
      return true;
    }

    // A ficha é substituição de dado do contato, por isso PUT.
    if (partes[3] === 'ficha') {
      if (metodo !== 'PUT') {
        responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'PUT' });
        return true;
      }
      exigirPermissao(usuario, PERMISSAO_POR_ACAO.ficha);
      responderJson(res, 200, await conversas.atualizarFicha(conversaId, await lerJson(req)));
      return true;
    }

    const acoes = {
      mensagens: (corpo) => conversas.responder(conversaId, corpo),
      assumir: (corpo) => conversas.assumir(conversaId, corpo),
      etiquetas: (corpo) => conversas.definirEtiquetas(conversaId, corpo),
      prioridade: (corpo) => conversas.definirPrioridade(conversaId, corpo),
      estado: (corpo) => conversas.definirEstado(conversaId, corpo),
      temperatura: (corpo) => conversas.definirTemperatura(conversaId, corpo),
      notas: (corpo) => conversas.criarNota(conversaId, corpo),
      encerrar: (corpo) => servicoDeFluxo.encerrarConversa(conversaId, { usuarioId: corpo.usuario_id ?? null }),
    };

    const acao = acoes[partes[3]];
    if (!acao) return false;

    if (metodo !== 'POST') {
      responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
      return true;
    }

    exigirPermissao(usuario, PERMISSAO_POR_ACAO[partes[3]]);

    // Quem agiu fica registrado na própria ação, não só na auditoria.
    const corpo = await lerJson(req);
    responderJson(res, 200, await acao({ ...corpo, usuario_id: usuario.id, autor: usuario.nome }));
    return true;
  }

  return async function tratarRequisicao(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rota = url.pathname;
    const metodo = req.method;
    const requestId = String(req.headers['x-vercel-id'] || req.headers['x-request-id'] || require('node:crypto').randomUUID());
    const inicio = Date.now();
    res.setHeader('x-request-id', requestId);
    // Observabilidade sem dado clínico: rota, método, status e duração bastam
    // para ligar erro de produção ao pedido, sem registrar corpo, telefone ou usuário.
    res.once('finish', () => console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : 'info',
      evento: 'http_request', request_id: requestId, rota, metodo,
      status: res.statusCode, duracao_ms: Date.now() - inicio,
    })));

    /**
     * Roda a ação com o usuário declarado ao banco, numa transação.
     *
     * Sem usuário identificado não há transação: a rota vai responder 401 em
     * `exigirPermissao` de qualquer jeito, e abrir transação para isso só
     * ocuparia conexão do pool à toa.
     */
    // O usuário inteiro, não só o id: o papel vai junto para o banco, e é dele
    // que as políticas dependem para decidir o que a requisição pode escrever.
    const comIdentidade = (quem, acao) => (
      quem ? repositorio.comUsuario({ id: quem.id, papel: quem.papel }, acao) : acao()
    );

    try {
      if (rota === '/health') {
        if (metodo !== 'GET' && metodo !== 'HEAD') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        // O health responde sem autenticação, então carrega só o que não é
        // segredo. O estado do banco entra porque a falha mais cara que este
        // sistema já teve foi silenciosa: a conexão respondia na hora, sem
        // erro, e devolvia zero linhas porque o papel não fora declarado — o
        // login dizia "credenciais inválidas" e ninguém suspeitava do banco.
        //
        // Sai o usuário e o papel; não sai host, porta, senha nem URL.
        let banco = { configurado: false };
        if (configuracao.banco.configurado) {
          try {
            const { rows: [linha] } = await repositorio.consultarSaudeDaConexao();
            banco = {
              configurado: true,
              alcancavel: true,
              usuario: linha.usuario,
              // `deny` aqui significa que o RLS vai filtrar tudo em silêncio.
              papel: linha.papel,
              rls_efetivo: linha.papel !== 'deny',
            };
          } catch (erro) {
            banco = { configurado: true, alcancavel: false, falha: erro.code ?? erro.message };
          }
        }

        responderJson(res, 200, {
          produto: 'crmclinica',
          status: 'ok',
          versao: require('../../package.json').version,
          instante: new Date().toISOString(),
          banco,
        });
        return;
      }

      // Identidade lida uma vez por requisição; `null` quando não há token válido.
      const usuario = autenticacao.identificar(req.headers.authorization);

      // O gateway de voz não usa a sessão da interface. O contexto exige o JWT
      // curto da própria sessão; eventos exigem HMAC sobre o corpo bruto.
      if (rota === '/api/serena/voz/contexto') {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        const portador = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
        responderJson(res, 200, await servicoDeVoz.obterContexto(portador), { 'cache-control': 'no-store' });
        return;
      }
      if (rota === '/api/serena/voz/eventos') {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return;
        }
        const corpoBruto = await lerCorpoBruto(req, configuracao.limiteCorpoBytes);
        responderJson(res, 202, await servicoDeVoz.receberEvento(corpoBruto, req.headers), { 'cache-control': 'no-store' });
        return;
      }

      if (rota === '/api/resumo') {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        exigirPermissao(usuario, 'conversas:ler');
        // A saúde do orquestrador é rede, e fica fora da transação: seria uma
        // conexão do pool parada esperando um serviço externo responder.
        const saudeOrquestrador = await orquestrador.verificarSaude();
        const [saudeInbox, conversasDoResumo, leadsDoResumo] = await comIdentidade(usuario, () => (
          Promise.all([
            repositorio.verificarSaude(),
            repositorio.listarConversas({ limite: 200 }),
            repositorio.listarLeads(),
          ])
        ));
        responderJson(
          res,
          200,
          montarResumo(configuracao, saudeOrquestrador, saudeInbox, {
            conversas: conversasDoResumo,
            leads: leadsDoResumo,
          }),
          { 'cache-control': 'no-store' },
        );
        return;
      }

      if (rota === '/api/auditoria') {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        responderJson(res, 200, await comIdentidade(usuario, () => rotasDeAuditoria.listar(usuario, url.searchParams)), { 'cache-control': 'no-store' });
        return;
      }

      // Autenticação fica FORA da transação de identidade, por dois motivos.
      //
      // O primeiro é aritmético: em `/api/auth/login` ainda não existe usuário
      // para declarar ao banco.
      //
      // O segundo é a razão de isto ser um comentário e não uma linha a menos:
      // login errado responde 401 lançando, e um ROLLBACK levaria junto o
      // registro da tentativa. O rate limit pararia de contar exatamente as
      // tentativas que ele existe para contar — e ninguém notaria, porque a
      // rota continuaria devolvendo 401 certinho.
      if (await tratarRotasDeAutenticacao(req, res, rota, metodo, url, usuario)) return;

      if (rota === '/api/eventos') {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return;
        }
        // Webhook também fica fora: é aqui que o orquestrador é acionado, e uma
        // chamada de rede lenta seguraria a conexão do pool durante a espera.
        await receberEventoDoOrquestrador(req, res);
        return;
      }

      // O ensaio da Serena fala com o gateway, que pode levar até um minuto para
      // responder. Dentro da transação, isso seria uma conexão do pool parada
      // esperando serviço externo — dez ensaios simultâneos esgotariam o pool e
      // travariam inbox, agenda e contatos, que não têm nada a ver com o teste.
      //
      // Estas rotas não tocam tabela nenhuma, então saem antes do `comIdentidade`.
      if (rota === '/api/agente/acao' && metodo === 'POST') {
        responderJson(res, 200, await rotasDoAgente.executar(req.headers, await lerJson(req)));
        return;
      }

      if (rota.startsWith('/api/serena/teste')) {
        const tratouTeste = await tratarRotasDaSerena(req, res, rota, metodo, url, usuario);
        if (tratouTeste) return;
      }

      // Daqui para baixo, tudo que toca o banco corre numa transação com o
      // usuário declarado — inbox, contatos, leads e agenda.
      const tratou = await comIdentidade(usuario, () => (
        tratarRotasDeConversas(req, res, rota, metodo, url, usuario)
      ));
      if (tratou) return;

      const arquivo = ARQUIVOS_PUBLICOS.get(rota);
      if (arquivo) {
        if (metodo !== 'GET' && metodo !== 'HEAD') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        servirArquivo(res, arquivo[0], arquivo[1]);
        return;
      }

      responderJson(res, 404, { erro: 'rota não encontrada' });
    } catch (erro) {
      if (erro instanceof ErroCorpoExcedido) {
        // Responde primeiro; só então encerra a conexão do excedente.
        responderJson(res, 413, { erro: erro.message });
        req.destroy();
        return;
      }
      if (erro instanceof ErroDeContrato) {
        responderJson(res, 400, { erro: erro.message, campo: erro.campo });
        return;
      }
      // Integração ausente é estado previsto, não falha: 503 diz "ainda não ligado".
      if (erro.codigo === 'openclaw_nao_configurado') {
        responderJson(res, 503, { erro: erro.message, codigo: erro.codigo });
        return;
      }
      // 401 é "não sei quem você é"; 403 é "sei, e você não pode".
      if (erro instanceof ErroDeAutorizacao) {
        responderJson(res, 403, { erro: erro.message, permissao: erro.permissao });
        return;
      }
      // Excesso de tentativas. `Retry-After` diz em quantos segundos vale tentar
      // de novo — sem isso, a interface e os clientes ficam adivinhando.
      if (erro.status === 429) {
        responderJson(
          res,
          429,
          { erro: erro.message, tentar_em_segundos: erro.retryAfter },
          { 'retry-after': String(erro.retryAfter) },
        );
        return;
      }
      if (erro.status === 401) {
        // `segundoFator` diz à interface que falta o código, não a senha.
        const detalhe = { erro: erro.message };
        if (erro.segundoFator) detalhe.segundo_fator = erro.segundoFator;
        responderJson(res, 401, detalhe, { 'www-authenticate': 'Bearer' });
        return;
      }
      if (erro.status === 403 && erro.situacao) {
        // Conta na fila ou recusada: a interface precisa da situação para explicar.
        responderJson(res, 403, { erro: erro.message, situacao: erro.situacao });
        return;
      }
      // Conflito de agenda leva o horário que atrapalhou: a recepção precisa
      // saber com o quê bateu, não só que "deu erro".
      if (erro.status === 409 && erro.codigo === 'conflito_de_agenda') {
        responderJson(res, 409, { erro: erro.message, codigo: erro.codigo, conflito: erro.conflito ?? null });
        return;
      }
      // 422: o corpo é bem formado, mas a semântica foi recusada — hoje, a
      // estratégia de IA ambígua ou incompatível com a porta de entrada.
      if (erro instanceof ErroDeEstrategia) {
        responderJson(res, 422, { erro: erro.message, codigo: erro.codigo });
        return;
      }
      if ([400, 403, 404, 409, 422, 503].includes(erro.status)) {
        responderJson(res, erro.status, {
          erro: erro.message,
          ...(erro.codigo ? { codigo: erro.codigo } : {}),
          // Telefone duplicado leva o contato que já tem o número: sem isso, a
          // equipe descobre que existe e não descobre onde.
          ...(erro.contato_id ? { contato_id: erro.contato_id } : {}),
        });
        return;
      }
      // Falha inesperada nunca vaza detalhe interno para o cliente.
      console.error('[crmclinica] falha ao tratar requisição:', erro.message);
      if (!res.headersSent) responderJson(res, 500, { erro: 'falha interna' });
    }
  };
}

function criarServidor(dependencias = {}) {
  return http.createServer(criarAplicacao(dependencias));
}

module.exports = { criarAplicacao, criarServidor, CABECALHOS_SEGURANCA };
