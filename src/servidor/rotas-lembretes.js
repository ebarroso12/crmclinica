'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { TIPOS, ESTADOS, mascararTelefone } = require('../dominio/lembretes');

// API da fila de lembretes.
//
// Existe para responder três perguntas que a operação faz de verdade quando um
// paciente diz que não recebeu nada:
//
//   • o lembrete estava na fila?
//   • o que aconteceu com ele — saiu, foi ignorado, falhou?
//   • se falhou, por quê, e dá para mandar de novo?
//
// A quarta pergunta é a que o sistema responde antes de ser perguntado: em que
// modo a entrega está. Toda resposta daqui carrega isso, porque "enviado" em
// dry-run não significa que alguém recebeu.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

/**
 * A forma pública de um lembrete.
 *
 * O telefone sai mascarado: a fila é uma tela de operação, não a ficha do
 * paciente, e não há motivo para o número inteiro trafegar aqui.
 */
function publicar(lembrete) {
  return {
    id: lembrete.id,
    agendamento_id: lembrete.agendamento_id,
    contato_id: lembrete.contato_id,
    tipo: lembrete.tipo,
    estado: lembrete.estado,
    janela: lembrete.janela,
    agendar_para: lembrete.agendar_para,
    tentativas: lembrete.tentativas,
    max_tentativas: lembrete.max_tentativas,
    tentar_em: lembrete.tentar_em,
    modo_entrega: lembrete.modo_entrega,
    enviado_em: lembrete.enviado_em,
    ignorado_motivo: lembrete.ignorado_motivo,
    ultimo_erro: lembrete.ultimo_erro,
    contato: lembrete.contato
      ? { nome: lembrete.contato.nome, telefone: mascararTelefone(lembrete.contato.telefone) }
      : null,
    agendamento: lembrete.agendamento
      ? { status: lembrete.agendamento.status, inicio: lembrete.agendamento.inicio }
      : null,
  };
}

function criarRotasDeLembretes({ lembretes, repositorio }) {
  return {
    /** GET /api/lembretes/vocabulario */
    async vocabulario(usuario) {
      exigirPermissao(usuario, 'conversas:ler');
      return { tipos: TIPOS, estados: ESTADOS };
    },

    /** GET /api/lembretes?estado=&tipo=&agendamento=&contato=&limite= */
    async listar(usuario, parametros) {
      exigirPermissao(usuario, 'conversas:ler');

      const limiteBruto = Number(parametros.get('limite') ?? 50);
      const limite = Number.isInteger(limiteBruto) && limiteBruto > 0 ? Math.min(limiteBruto, 200) : 50;

      const fila = await lembretes.listar({
        estado: parametros.get('estado') || null,
        tipo: parametros.get('tipo') || null,
        agendamentoId: parametros.get('agendamento') || null,
        contatoId: parametros.get('contato') || null,
        limite,
      });

      return { lembretes: fila.map(publicar), modo_entrega: lembretes.modo() };
    },

    /** GET /api/lembretes/resumo — contagem por estado e o modo de entrega. */
    async resumo(usuario) {
      exigirPermissao(usuario, 'conversas:ler');
      return lembretes.resumo();
    },

    /** GET /api/lembretes/falhas — atalho para o que precisa de atenção. */
    async falhas(usuario) {
      exigirPermissao(usuario, 'conversas:ler');
      const fila = await lembretes.listar({ estado: 'falhou', limite: 100 });
      return { lembretes: fila.map(publicar), total: fila.length, modo_entrega: lembretes.modo() };
    },

    /** POST /api/lembretes/:id/reenfileirar — devolve à fila o que falhou. */
    async reenfileirar(usuario, lembreteId) {
      // Mexer na fila é operação, não atendimento: mesma permissão que organiza
      // a agenda.
      exigirPermissao(usuario, 'conversas:priorizar');
      const id = exigirIdentificador(lembreteId, 'lembrete_id');

      const lembrete = await lembretes.reenfileirar(id, { usuarioId: usuario.id });
      return { lembrete: publicar(lembrete) };
    },

    /**
     * POST /api/lembretes/sincronizar — enfileira o que falta na agenda futura.
     * Idempotente: rodar de novo não cria nada a mais.
     */
    async sincronizar(usuario) {
      exigirPermissao(usuario, 'conversas:priorizar');
      return lembretes.sincronizarAgenda({ usuarioId: usuario.id });
    },

    /**
     * POST /api/contatos/:id/lembretes — liga ou desliga para um contato.
     * `{ "receber": false }` é o opt-out.
     */
    async definirOptOut(usuario, contatoId, corpo) {
      exigirPermissao(usuario, 'contatos:editar');
      const id = exigirIdentificador(contatoId, 'contato_id');

      if (typeof corpo?.receber !== 'boolean') {
        throw new ErroDeContrato('campo "receber" deve ser true ou false', 'receber');
      }

      const { contato, cancelados } = await lembretes.definirOptOut(id, {
        optout: corpo.receber === false,
        motivo: corpo?.motivo ? String(corpo.motivo).slice(0, 200) : null,
        usuarioId: usuario.id,
        origem: 'equipe',
      });

      return {
        contato: {
          id: contato.id,
          nome: contato.nome,
          telefone: mascararTelefone(contato.telefone),
          recebe_lembretes: contato.lembretes_optout !== true,
          optout_em: contato.lembretes_optout_em ?? null,
          optout_motivo: contato.lembretes_optout_motivo ?? null,
        },
        cancelados: cancelados.length,
      };
    },

    /** GET /api/agenda/:id/lembretes — a fila de um agendamento específico. */
    async doAgendamento(usuario, agendamentoId) {
      exigirPermissao(usuario, 'conversas:ler');
      const id = exigirIdentificador(agendamentoId, 'agendamento_id');

      const agendamento = await repositorio.obterAgendamento(id);
      if (!agendamento) {
        const erro = new Error('agendamento não encontrado');
        erro.status = 404;
        throw erro;
      }

      const fila = await lembretes.listar({ agendamentoId: id, limite: 50 });
      return { agendamento_id: id, lembretes: fila.map(publicar), modo_entrega: lembretes.modo() };
    },
  };
}

module.exports = { criarRotasDeLembretes, publicar };
