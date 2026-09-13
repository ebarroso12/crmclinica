'use strict';

const { ErroDeContrato } = require('../contratos/erros');

// Aviso no celular: o aparelho se inscreve aqui.
//
// O navegador gera a inscrição (um endereço único do serviço de push do próprio
// navegador, mais duas chaves) e manda para cá. O servidor guarda por usuário —
// um aparelho por linha, porque a mesma pessoa usa celular e computador.
//
// Não há permissão especial: quem está logado pode inscrever o PRÓPRIO
// aparelho. A inscrição é sempre do usuário da sessão; o corpo da requisição
// não escolhe de quem ela é. Isso é o que impede alguém inscrever o aparelho
// dele para receber os avisos de outra pessoa.

/**
 * Sessão obrigatória.
 *
 * Estas rotas não exigem permissão de papel — qualquer conta logada inscreve o
 * PRÓPRIO aparelho — e foi justamente por não passar por `exigirPermissao`
 * (que já trata sessão ausente) que a primeira versão explodiu com
 * "Cannot read properties of null" em quem chamasse sem token: 500 onde devia
 * ser 401. Achado em produção, minutos depois de publicar.
 */
function exigirSessao(usuario) {
  if (usuario?.id) return usuario;
  const erro = new Error('autenticação obrigatória');
  erro.status = 401;
  throw erro;
}

const LIMITE_ENDPOINT = 1000;
const LIMITE_CHAVE = 200;

function exigirTexto(valor, campo, limite) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

/**
 * O endpoint tem de ser HTTPS de verdade. Guardar qualquer string aqui é
 * guardar um destino para onde o servidor vai fazer POST depois — o cuidado é
 * o mesmo de qualquer URL que o sistema vá visitar sozinho.
 */
function exigirEndpoint(valor) {
  const bruto = exigirTexto(valor, 'endpoint', LIMITE_ENDPOINT);
  let url;
  try {
    url = new URL(bruto);
  } catch {
    throw new ErroDeContrato('campo "endpoint" precisa ser uma URL', 'endpoint');
  }
  if (url.protocol !== 'https:') {
    throw new ErroDeContrato('campo "endpoint" precisa ser https', 'endpoint');
  }
  return url.toString();
}

function criarRotasDeAvisosNoCelular({ repositorio, webpush }) {
  return {
    /**
     * GET /api/aparelhos — o que a tela precisa saber para decidir o que
     * oferecer: se o servidor sabe empurrar (tem VAPID configurado), a chave
     * pública para a inscrição, e quantos aparelhos esta pessoa já inscreveu.
     */
    async estado(usuario) {
      exigirSessao(usuario);
      const inscricoes = await repositorio.listarInscricoesDeNotificacao(usuario.id);
      return {
        // Inscrever precisa só da chave pública; quem empurra é o worker.
        disponivel: webpush.podeInscrever === true,
        chave_publica: webpush.chavePublica ?? null,
        aparelhos: inscricoes.length,
      };
    },

    /** POST /api/aparelhos — este aparelho quer receber avisos. */
    async inscrever(usuario, corpo) {
      exigirSessao(usuario);
      // Inscrever precisa só da chave pública; quem empurra é o worker no VPS.
      if (!webpush.podeInscrever) {
        const erro = new Error('aviso no celular não está configurado neste servidor');
        erro.status = 503;
        erro.codigo = 'vapid_nao_configurado';
        throw erro;
      }

      const endpoint = exigirEndpoint(corpo?.endpoint);
      const p256dh = exigirTexto(corpo?.chaves?.p256dh ?? corpo?.keys?.p256dh, 'chaves.p256dh', LIMITE_CHAVE);
      const auth = exigirTexto(corpo?.chaves?.auth ?? corpo?.keys?.auth, 'chaves.auth', LIMITE_CHAVE);

      // O mesmo aparelho reinscrevendo (o navegador troca o endpoint de tempos
      // em tempos) não pode virar linha nova a cada vez: a chave é o endpoint.
      const inscricao = await repositorio.salvarInscricaoDeNotificacao({
        usuarioId: usuario.id,
        endpoint,
        p256dh,
        auth,
        agente: typeof corpo?.agente === 'string' ? corpo.agente.slice(0, 200) : null,
      });

      await repositorio.registrarAuditoria({
        entidade: 'usuario',
        entidadeId: usuario.id,
        acao: 'notificacao_aparelho_inscrito',
        // O endpoint inteiro é um endereço de entrega: no rastro fica só a
        // origem, que basta para saber qual serviço de push é.
        detalhe: { servico: new URL(endpoint).host },
        usuarioId: usuario.id,
      });

      return { inscrito: true, id: inscricao.id };
    },

    /** DELETE /api/aparelhos — este aparelho não quer mais. */
    async desinscrever(usuario, corpo) {
      exigirSessao(usuario);
      const endpoint = exigirEndpoint(corpo?.endpoint);
      // Só apaga inscrição do próprio usuário: o endpoint de outra pessoa,
      // mesmo que alguém o descubra, não é apagável por aqui.
      const removidas = await repositorio.removerInscricaoDeNotificacao(usuario.id, endpoint);
      return { removidas };
    },
  };
}

module.exports = { criarRotasDeAvisosNoCelular };
