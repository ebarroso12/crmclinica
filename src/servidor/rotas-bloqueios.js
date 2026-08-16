'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { normalizarTelefone, telefoneValido } = require('../dominio/serena');

// CRUD da lista de bloqueio de contato (db/040_contatos_bloqueados.sql).
//
// Diferente de `contatos`: hard delete de verdade — não há histórico
// clínico para preservar aqui, só a lista de quem está bloqueado agora.
// Telefone é único (índice do banco); a checagem aqui só existe para dar
// uma resposta útil, a garantia real é o índice.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function exigirTexto(valor, campo, limite = 300) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  return bruto.slice(0, limite);
}

/** A forma pública do registro — telefone sempre inteiro aqui: é uma tela pequena de gestão, não a lista geral de contatos. */
function publicar(registro) {
  return {
    id: registro.id,
    telefone: registro.telefone,
    nome: registro.nome,
    motivo: registro.motivo,
    criado_em: registro.criado_em ?? null,
    atualizado_em: registro.atualizado_em ?? null,
  };
}

function criarRotasDeBloqueios({ repositorio }) {
  async function conflitoDeTelefone(telefone) {
    const existente = await repositorio.obterBloqueioPorTelefone(telefone);
    const erro = new Error('já existe um bloqueio para este telefone');
    erro.status = 409;
    erro.codigo = 'telefone_ja_bloqueado';
    erro.bloqueio_id = existente?.id ?? null;
    return erro;
  }

  return {
    /** GET /api/bloqueios */
    async listar(usuario) {
      exigirPermissao(usuario, 'bloqueios:gerenciar');
      const registros = await repositorio.listarContatosBloqueados();
      return { bloqueios: registros.map(publicar), total: registros.length };
    },

    /** POST /api/bloqueios */
    async criar(usuario, corpo) {
      exigirPermissao(usuario, 'bloqueios:gerenciar');

      const nome = exigirTexto(corpo?.nome, 'nome', 120);
      const motivo = exigirTexto(corpo?.motivo, 'motivo', 500);
      const telefone = normalizarTelefone(corpo?.telefone);

      if (!telefone) throw new ErroDeContrato('campo "telefone" é obrigatório', 'telefone');
      if (!telefoneValido(corpo?.telefone)) {
        throw new ErroDeContrato('telefone inválido: use DDD e número, com ou sem +55', 'telefone');
      }

      const existente = await repositorio.obterBloqueioPorTelefone(telefone);
      if (existente) throw await conflitoDeTelefone(telefone);

      let registro;
      try {
        registro = await repositorio.criarContatoBloqueado({ telefone, nome, motivo, criadoPor: usuario.id });
      } catch (erro) {
        if (erro.code === '23505') throw await conflitoDeTelefone(telefone);
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato_bloqueado', entidadeId: registro.id, acao: 'bloqueio_criado',
        // Nunca o motivo (pode carregar relato sensível do paciente) — só o fato técnico.
        detalhe: { telefone_mascarado: `${telefone.slice(0, 4)}***${telefone.slice(-2)}` },
        usuarioId: usuario.id,
      });

      return { bloqueio: publicar(registro) };
    },

    /** PUT /api/bloqueios/:id */
    async editar(usuario, bloqueioId, corpo) {
      exigirPermissao(usuario, 'bloqueios:gerenciar');
      const id = exigirIdentificador(bloqueioId, 'bloqueio_id');

      const atual = await repositorio.obterContatoBloqueado(id);
      if (!atual) {
        const erro = new Error('bloqueio não encontrado');
        erro.status = 404;
        throw erro;
      }

      const campos = {};
      if (corpo?.nome !== undefined) campos.nome = exigirTexto(corpo.nome, 'nome', 120);
      if (corpo?.motivo !== undefined) campos.motivo = exigirTexto(corpo.motivo, 'motivo', 500);

      if (corpo?.telefone !== undefined) {
        const telefone = normalizarTelefone(corpo.telefone);
        if (!telefoneValido(corpo.telefone)) {
          throw new ErroDeContrato('telefone inválido: use DDD e número, com ou sem +55', 'telefone');
        }
        if (telefone !== atual.telefone) {
          const dono = await repositorio.obterBloqueioPorTelefone(telefone);
          if (dono && dono.id !== id) throw await conflitoDeTelefone(telefone);
          campos.telefone = telefone;
        }
      }

      if (Object.keys(campos).length === 0) return { bloqueio: publicar(atual) };

      let registro;
      try {
        registro = await repositorio.atualizarContatoBloqueado(id, campos);
      } catch (erro) {
        if (erro.code === '23505') throw await conflitoDeTelefone(campos.telefone);
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato_bloqueado', entidadeId: id, acao: 'bloqueio_editado',
        detalhe: { campos: Object.keys(campos) }, usuarioId: usuario.id,
      });

      return { bloqueio: publicar(registro) };
    },

    /** DELETE /api/bloqueios/:id — hard delete real. */
    async remover(usuario, bloqueioId) {
      exigirPermissao(usuario, 'bloqueios:gerenciar');
      const id = exigirIdentificador(bloqueioId, 'bloqueio_id');

      const atual = await repositorio.obterContatoBloqueado(id);
      if (!atual) {
        const erro = new Error('bloqueio não encontrado');
        erro.status = 404;
        throw erro;
      }

      await repositorio.removerContatoBloqueado(id);

      await repositorio.registrarAuditoria({
        entidade: 'contato_bloqueado', entidadeId: id, acao: 'bloqueio_removido',
        detalhe: { telefone_mascarado: `${atual.telefone.slice(0, 4)}***${atual.telefone.slice(-2)}` },
        usuarioId: usuario.id,
      });

      return { removido: true };
    },
  };
}

module.exports = { criarRotasDeBloqueios, publicar };
