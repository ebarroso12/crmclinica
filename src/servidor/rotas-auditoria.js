'use strict';

const { exigirPermissao } = require('../seguranca/rbac');
const { redigirAuditoria } = require('../seguranca/redator-auditoria');

function inteiroPositivo(valor, padrao, maximo) {
  const numero = Number.parseInt(valor, 10);
  if (!Number.isInteger(numero) || numero < 1) return padrao;
  return Math.min(numero, maximo);
}

function criarRotasDeAuditoria({ repositorio }) {
  return {
    async listar(usuario, parametros) {
      exigirPermissao(usuario, 'auditoria:ler');
      const limite = inteiroPositivo(parametros.get('limite'), 50, 100);
      const cursor = parametros.get('cursor');
      const dados = await repositorio.listarAuditoria({
        limite,
        antesDeId: cursor ? inteiroPositivo(cursor, null, Number.MAX_SAFE_INTEGER) : null,
        entidade: parametros.get('entidade') || null,
        acao: parametros.get('acao') || null,
      });
      return {
        itens: dados.itens.map((item) => ({ ...item, detalhe: redigirAuditoria(item.detalhe) })),
        proximo_cursor: dados.proximoCursor,
      };
    },
  };
}

module.exports = { criarRotasDeAuditoria };
