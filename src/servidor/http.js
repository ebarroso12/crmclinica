'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { carregarConfiguracao } = require('../config');
const { validarEvento } = require('../contratos/evento');
const { ErroDeContrato } = require('../contratos/erros');
const { criarRegistroEmMemoria } = require('../armazenamento/idempotencia');
const { criarClienteOpenClaw, assinaturaValida } = require('../integracoes/openclaw');
const { criarRepositorioEmMemoria } = require('../dados/repositorio-memoria');
const { montarResumo } = require('../dominio/resumo');
const { criarAtendimento } = require('../dominio/atendimento');
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
const { exigirPermissao, ErroDeAutorizacao } = require('../seguranca/rbac');
const { lerCorpoBruto, interpretarJson, ErroCorpoExcedido } = require('./corpo');

const PASTA_PUBLICA = path.join(__dirname, '..', '..', 'public');

// Lista fechada de arquivos servidos. Evita qualquer travessia de caminho por construção.
const ARQUIVOS_PUBLICOS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/estilo.css', ['estilo.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
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
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
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
  const atendimento = dependencias.atendimento
    || criarAtendimento({ repositorio, orquestrador, leads: servicoDeLeads });

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
  const servicoDeAgenda = dependencias.servicoDeAgenda || criarServicoDeAgenda({ repositorio });
  const rotasDeAgenda = criarRotasDeAgenda({ repositorio, agenda: servicoDeAgenda });

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

    const evento = validarEvento(interpretarJson(corpoBruto));

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
      }[partes[3]];

      if (sobre) {
        responderJson(res, 200, await sobre(await lerJson(req)), semCache);
        return true;
      }
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

    if (await tratarRotasDeAgenda(req, res, rota, metodo, url, usuario)) return true;

    const partes = rota.split('/').filter(Boolean);

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

    try {
      if (rota === '/health') {
        if (metodo !== 'GET' && metodo !== 'HEAD') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        responderJson(res, 200, {
          produto: 'crmclinica',
          status: 'ok',
          versao: require('../../package.json').version,
          instante: new Date().toISOString(),
        });
        return;
      }

      // Identidade lida uma vez por requisição; `null` quando não há token válido.
      const usuario = autenticacao.identificar(req.headers.authorization);

      if (rota === '/api/resumo') {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        exigirPermissao(usuario, 'conversas:ler');
        const [saudeOrquestrador, saudeInbox, conversasDoResumo, leadsDoResumo] = await Promise.all([
          orquestrador.verificarSaude(),
          repositorio.verificarSaude(),
          repositorio.listarConversas({ limite: 200 }),
          repositorio.listarLeads(),
        ]);
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

      if (await tratarRotasDeAutenticacao(req, res, rota, metodo, url, usuario)) return;

      if (rota === '/api/eventos') {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return;
        }
        await receberEventoDoOrquestrador(req, res);
        return;
      }

      if (await tratarRotasDeConversas(req, res, rota, metodo, url, usuario)) return;

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
      if ([400, 403, 404, 409, 503].includes(erro.status)) {
        responderJson(res, erro.status, {
          erro: erro.message,
          ...(erro.codigo ? { codigo: erro.codigo } : {}),
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
