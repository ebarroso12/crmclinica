'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { normalizarTelefone, telefoneValido } = require('../dominio/serena');
const { mascararTelefone } = require('../dominio/lembretes');

// CRUD de contatos.
//
// Duas decisões governam este arquivo, e as duas existem porque o contrário dá
// errado de um jeito que não tem volta:
//
// 1. **Excluir é soft delete.** As tabelas que apontam para `contatos` usam
//    `ON DELETE CASCADE`: um DELETE de verdade levaria junto conversas,
//    mensagens, leads e agendamentos daquela pessoa — o histórico inteiro, sem
//    aviso. Aqui o contato sai das listas e o histórico fica de pé.
//
// 2. **Telefone não duplica.** O telefone é o que identifica a pessoa entre
//    canais. Duas fichas para o mesmo número significam metade das mensagens
//    numa e metade na outra, e a equipe atendendo sem ver o que já foi dito.
//    A checagem é do banco (índice único), não daqui — mas a resposta é
//    traduzida para que quem cadastra saiba que já existe, e onde.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function exigirTexto(valor, campo, limite = 200) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  return bruto.slice(0, limite);
}

/** A forma pública do contato na tela de gestão. */
function publicar(contato, { telefoneCompleto = false } = {}) {
  return {
    id: contato.id,
    nome: contato.nome,
    // Na lista o telefone sai mascarado; na ficha aberta, inteiro — é onde a
    // equipe precisa dele para ligar.
    telefone: telefoneCompleto ? contato.telefone : mascararTelefone(contato.telefone),
    email: contato.email ?? null,
    origem: contato.origem ?? null,
    observacoes: contato.observacoes ?? null,
    recebe_lembretes: contato.lembretes_optout !== true,
    excluido: Boolean(contato.excluido_em),
    excluido_em: contato.excluido_em ?? null,
    excluido_motivo: contato.excluido_motivo ?? null,
    criado_em: contato.criado_em ?? null,
    ...(contato.conversas !== undefined ? { conversas: contato.conversas } : {}),
    ...(contato.agendamentos !== undefined ? { agendamentos: contato.agendamentos } : {}),
  };
}

function criarRotasDeContatos({ repositorio }) {
  /** Traduz a colisão do índice único em uma resposta que ajuda quem cadastra. */
  async function conflitoDeTelefone(telefone) {
    const existente = await repositorio.obterContatoPorTelefone(telefone);
    const erro = new Error(existente?.excluido_em
      ? 'já existe um contato excluído com este telefone; restaure-o em vez de criar outro'
      : 'já existe um contato com este telefone');
    erro.status = 409;
    erro.codigo = 'telefone_duplicado';
    erro.contato_id = existente?.id ?? null;
    return erro;
  }

  return {
    /** GET /api/contatos/gestao?busca=&excluidos=sim */
    async listar(usuario, parametros) {
      exigirPermissao(usuario, 'contatos:ler');

      const limiteBruto = Number(parametros.get('limite') ?? 100);
      const contatos = await repositorio.listarContatos({
        termo: parametros.get('busca') || null,
        incluirExcluidos: parametros.get('excluidos') === 'sim',
        limite: Number.isInteger(limiteBruto) && limiteBruto > 0 ? Math.min(limiteBruto, 500) : 100,
      });

      return { contatos: contatos.map((contato) => publicar(contato)), total: contatos.length };
    },

    /** GET /api/contatos/:id — a ficha, com o histórico de conversas e agenda. */
    async obter(usuario, contatoId) {
      exigirPermissao(usuario, 'contatos:ler');
      const id = exigirIdentificador(contatoId, 'contato_id');

      const contato = await repositorio.obterContato(id);
      if (!contato) {
        const erro = new Error('contato não encontrado');
        erro.status = 404;
        throw erro;
      }

      const [conversas, agendamentos, notas] = await Promise.all([
        repositorio.listarConversas({ contatoId: id, limite: 50 }),
        repositorio.listarAgendamentos({ contatoId: id, incluirCancelados: true }),
        repositorio.listarNotas(id),
      ]);

      return {
        contato: publicar(contato, { telefoneCompleto: true }),
        historico: {
          conversas: conversas.map((conversa) => ({
            id: conversa.id,
            status: conversa.status,
            canal: conversa.canal,
            previa: conversa.previa,
            ultima_msg_em: conversa.ultima_msg_em,
          })),
          agendamentos: agendamentos.map((agendamento) => ({
            id: agendamento.id,
            inicio: agendamento.inicio,
            status: agendamento.status,
            profissional: agendamento.profissional_nome ?? null,
          })),
          notas: notas.map((nota) => ({ id: nota.id, texto: nota.texto, criado_em: nota.criado_em })),
        },
      };
    },

    /** POST /api/contatos */
    async criar(usuario, corpo) {
      exigirPermissao(usuario, 'contatos:editar');

      const nome = exigirTexto(corpo?.nome, 'nome', 120);
      const telefone = normalizarTelefone(corpo?.telefone);

      if (!telefone) throw new ErroDeContrato('campo "telefone" é obrigatório', 'telefone');
      if (!telefoneValido(corpo?.telefone)) {
        throw new ErroDeContrato('telefone inválido: use DDD e número, com ou sem +55', 'telefone');
      }

      // Checagem antes do insert para dar uma resposta útil; a garantia contra a
      // corrida entre duas telas continua sendo o índice único do banco, tratado
      // no catch.
      const existente = await repositorio.obterContatoPorTelefone(telefone);
      if (existente) throw await conflitoDeTelefone(telefone);

      let contato;
      try {
        contato = await repositorio.criarContato({
          nome,
          telefone,
          email: corpo?.email ? String(corpo.email).trim().slice(0, 200) : null,
          origem: corpo?.origem ? String(corpo.origem).trim().slice(0, 40) : 'manual',
          observacoes: corpo?.observacoes ? String(corpo.observacoes).trim().slice(0, 2000) : null,
        });
      } catch (erro) {
        if (erro.code === '23505') throw await conflitoDeTelefone(telefone);
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato', entidadeId: contato.id, acao: 'contato_criado',
        detalhe: { nome, telefone: mascararTelefone(telefone) }, usuarioId: usuario.id,
      });

      return { contato: publicar(contato, { telefoneCompleto: true }) };
    },

    /** PUT /api/contatos/:id */
    async editar(usuario, contatoId, corpo) {
      exigirPermissao(usuario, 'contatos:editar');
      const id = exigirIdentificador(contatoId, 'contato_id');

      const atual = await repositorio.obterContato(id);
      if (!atual) {
        const erro = new Error('contato não encontrado');
        erro.status = 404;
        throw erro;
      }

      const campos = {};
      if (corpo?.nome !== undefined) campos.nome = exigirTexto(corpo.nome, 'nome', 120);
      if (corpo?.email !== undefined) campos.email = corpo.email ? String(corpo.email).trim().slice(0, 200) : null;
      if (corpo?.observacoes !== undefined) {
        campos.observacoes = corpo.observacoes ? String(corpo.observacoes).trim().slice(0, 2000) : null;
      }

      if (corpo?.telefone !== undefined) {
        const telefone = normalizarTelefone(corpo.telefone);
        if (!telefoneValido(corpo.telefone)) {
          throw new ErroDeContrato('telefone inválido: use DDD e número, com ou sem +55', 'telefone');
        }
        if (telefone !== atual.telefone) {
          const dono = await repositorio.obterContatoPorTelefone(telefone);
          if (dono && dono.id !== id) throw await conflitoDeTelefone(telefone);
          campos.telefone = telefone;
        }
      }

      if (Object.keys(campos).length === 0) {
        return { contato: publicar(atual, { telefoneCompleto: true }) };
      }

      let contato;
      try {
        contato = await repositorio.atualizarContato(id, campos);
      } catch (erro) {
        if (erro.code === '23505') throw await conflitoDeTelefone(campos.telefone);
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato', entidadeId: id, acao: 'contato_editado',
        detalhe: { campos: Object.keys(campos) }, usuarioId: usuario.id,
      });

      return { contato: publicar(contato, { telefoneCompleto: true }) };
    },

    /**
     * DELETE /api/contatos/:id — soft delete, sempre.
     * Nenhuma rota deste sistema apaga contato de verdade.
     */
    async excluir(usuario, contatoId, corpo) {
      exigirPermissao(usuario, 'contatos:excluir');
      const id = exigirIdentificador(contatoId, 'contato_id');

      const contato = await repositorio.excluirContato(id, {
        motivo: corpo?.motivo ? String(corpo.motivo).trim().slice(0, 300) : null,
        usuarioId: usuario.id,
      });

      if (!contato) {
        const erro = new Error('contato não encontrado ou já excluído');
        erro.status = 404;
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato', entidadeId: id, acao: 'contato_excluido',
        detalhe: { motivo: corpo?.motivo ?? null, tipo: 'soft_delete' }, usuarioId: usuario.id,
      });

      return {
        contato: publicar(contato),
        // Dito na resposta porque é a diferença que importa: o histórico não foi
        // apagado, e a exclusão é reversível.
        observacao: 'exclusão lógica: o histórico foi preservado e o contato pode ser restaurado',
      };
    },

    /** POST /api/contatos/:id/restaurar */
    async restaurar(usuario, contatoId) {
      exigirPermissao(usuario, 'contatos:excluir');
      const id = exigirIdentificador(contatoId, 'contato_id');

      const contato = await repositorio.restaurarContato(id);
      if (!contato) {
        const erro = new Error('contato não encontrado ou não está excluído');
        erro.status = 404;
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'contato', entidadeId: id, acao: 'contato_restaurado', usuarioId: usuario.id,
      });

      return { contato: publicar(contato, { telefoneCompleto: true }) };
    },
  };
}

module.exports = { criarRotasDeContatos, publicar };
