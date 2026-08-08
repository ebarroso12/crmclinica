'use strict';

// Rotas do painel de sincronia com o Google (P2-04) e da operação da fila
// (P0-09 a P0-12).
//
// Ler a saúde é do gestor: é ele quem percebe a agenda parada antes do
// médico. Operar — forçar sync, reenfileirar falha, resolver conflito — mexe
// no vínculo com o calendário, então ficou com o admin (ver rbac.js).

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

const RESOLUCOES = Object.freeze(['crm_vence', 'google_vence', 'manual', 'ignorado']);

function criarRotasDeSincronia({ repositorioGoogle, outbox, sincronia }) {
  function exigirSincronia() {
    if (!sincronia) {
      const erro = new Error('sincronia com o Google não configurada');
      erro.status = 503;
      erro.codigo = 'google_nao_configurado';
      throw erro;
    }
  }

  return {
    /** GET /api/sincronia/saude — o painel inteiro numa resposta. */
    async saude(usuario) {
      exigirPermissao(usuario, 'sincronia:ler');
      exigirSincronia();
      return sincronia.saude();
    },

    /** GET /api/sincronia/outbox/falhas — o que o worker não conseguiu entregar. */
    async falhasDoOutbox(usuario) {
      exigirPermissao(usuario, 'sincronia:ler');
      return { falhas: await repositorioGoogle.listarFalhasDoOutbox({}) };
    },

    /** POST /api/sincronia/outbox/:id/reenfileirar — dá outra chance a uma falha. */
    async reenfileirar(usuario, itemId) {
      exigirPermissao(usuario, 'sincronia:operar');
      const item = await repositorioGoogle.reenfileirarDoOutbox(exigirIdentificador(itemId, 'id'));
      if (!item) {
        const erro = new Error('item não encontrado ou não está falhado');
        erro.status = 404;
        throw erro;
      }
      return { item };
    },

    /** POST /api/sincronia/sincronizar — roda o incremental agora, sem esperar o worker. */
    async sincronizarAgora(usuario) {
      exigirPermissao(usuario, 'sincronia:operar');
      exigirSincronia();
      return sincronia.sincronizar({});
    },

    /** POST /api/sincronia/reconciliar — confere os vinculados um a um. */
    async reconciliarAgora(usuario) {
      exigirPermissao(usuario, 'sincronia:operar');
      exigirSincronia();
      return sincronia.reconciliar({});
    },

    /** GET /api/sincronia/conflitos — fila de decisões da clínica. */
    async listarConflitos(usuario, parametros) {
      exigirPermissao(usuario, 'sincronia:ler');
      const estado = parametros.get('estado') || 'aberto';
      return { conflitos: await repositorioGoogle.listarConflitos({ estado, limite: 100 }) };
    },

    /** POST /api/sincronia/conflitos/:id/resolver — crm_vence | google_vence | manual. */
    async resolverConflito(usuario, conflitoId, corpo) {
      exigirPermissao(usuario, 'sincronia:operar');
      exigirSincronia();

      const resolucao = corpo?.resolucao;
      if (!RESOLUCOES.includes(resolucao)) {
        throw new ErroDeContrato(`resolucao deve ser uma de: ${RESOLUCOES.join(', ')}`, 'resolucao');
      }

      const resolvido = await sincronia.resolverConflito(exigirIdentificador(conflitoId, 'id'), {
        resolucao,
        usuarioId: usuario.id,
      });
      if (!resolvido) {
        const erro = new Error('conflito não encontrado ou já resolvido');
        erro.status = 404;
        throw erro;
      }
      return { conflito: resolvido };
    },
  };
}

module.exports = { criarRotasDeSincronia };
