'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { carregarConfiguracao } = require('../config');
const { validarEvento } = require('../contratos/evento');
const { ErroDeContrato } = require('../contratos/erros');
const { criarRegistroEmMemoria } = require('../armazenamento/idempotencia');
const { criarClienteOpenClaw, assinaturaValida } = require('../integracoes/openclaw');
const { montarResumo } = require('../dominio/resumo');
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
  const idempotencia = dependencias.idempotencia || criarRegistroEmMemoria();

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
    const jaProcessado = idempotencia.consultar(evento.chave_idempotencia);
    if (jaProcessado) {
      responderJson(res, 200, { ...jaProcessado, duplicado: true });
      return;
    }

    const recibo = {
      aceito: true,
      duplicado: false,
      chave_idempotencia: evento.chave_idempotencia,
      tipo: evento.tipo,
      canal: evento.canal,
      recebido_em: new Date().toISOString(),
      // Sem banco ligado, o evento é aceito e registrado, mas ainda não vira conversa no CRM.
      encaminhamento: orquestrador.disponivel ? 'orquestrador' : 'apenas_registrado',
    };

    idempotencia.registrar(evento.chave_idempotencia, recibo);
    responderJson(res, 202, recibo);
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

      if (rota === '/api/resumo') {
        if (metodo !== 'GET') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'GET' });
          return;
        }
        const saude = await orquestrador.verificarSaude();
        responderJson(res, 200, montarResumo(configuracao, saude), { 'cache-control': 'no-store' });
        return;
      }

      if (rota === '/api/eventos') {
        if (metodo !== 'POST') {
          responderJson(res, 405, { erro: 'método não permitido' }, { allow: 'POST' });
          return;
        }
        await receberEventoDoOrquestrador(req, res);
        return;
      }

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
