'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { STATUS, TIPOS, DIAS } = require('../dominio/agenda');

// API da agenda.
//
// O fluxo de criação tem dois passos de propósito: **propor** devolve um token,
// **confirmar** grava. Oferecer e marcar na mesma ação é como a clínica acaba
// com consulta que o paciente não pediu.

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

function exigirData(valor, campo) {
  const bruto = exigirTexto(valor, campo, 40);
  if (Number.isNaN(new Date(bruto).getTime())) {
    throw new ErroDeContrato(`campo "${campo}" não é uma data válida`, campo);
  }
  return bruto;
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function criarRotasDeAgenda({ repositorio, agenda }) {
  return {
    /** GET /api/agenda/vocabulario */
    async vocabulario(usuario) {
      exigirPermissao(usuario, 'conversas:ler');
      return { status: STATUS, tipos: TIPOS, dias: DIAS };
    },

    // ---------------------------------------------------------------- profissionais

    async listarProfissionais(usuario) {
      exigirPermissao(usuario, 'conversas:ler');

      const lista = await repositorio.listarProfissionais({ apenasAtivos: false });
      const comJanelas = await Promise.all(lista.map(async (profissional) => ({
        ...profissional,
        disponibilidades: await repositorio.listarDisponibilidades(profissional.id),
      })));

      return { profissionais: comJanelas };
    },

    /** POST /api/agenda/profissionais — quem organiza a agenda é gestor ou admin. */
    async criarProfissional(usuario, corpo) {
      exigirPermissao(usuario, 'conversas:priorizar');

      const nome = exigirTexto(corpo?.nome, 'nome', 120);
      const duracaoMin = Number(corpo?.duracao_min ?? 30);
      if (!Number.isInteger(duracaoMin) || duracaoMin < 5 || duracaoMin > 480) {
        throw new ErroDeContrato('duracao_min deve estar entre 5 e 480 minutos', 'duracao_min');
      }

      const profissional = await repositorio.criarProfissional({
        nome,
        especialidade: corpo?.especialidade ?? null,
        registro: corpo?.registro ?? null,
        cor: corpo?.cor ?? null,
        duracaoMin,
        usuarioId: corpo?.usuario_id ?? null,
      });

      await repositorio.registrarAuditoria({
        entidade: 'profissional', entidadeId: profissional.id,
        acao: 'profissional_criado', usuarioId: usuario.id,
      });

      return { profissional };
    },

    /** PUT /api/agenda/profissionais/:id/disponibilidade — substitui as janelas. */
    async definirDisponibilidade(usuario, profissionalId, corpo) {
      exigirPermissao(usuario, 'conversas:priorizar');
      const id = exigirIdentificador(profissionalId, 'profissional_id');

      if (!Array.isArray(corpo?.janelas)) {
        throw new ErroDeContrato('campo "janelas" deve ser uma lista', 'janelas');
      }

      for (const janela of corpo.janelas) {
        if (!Number.isInteger(janela?.dia_semana) || janela.dia_semana < 0 || janela.dia_semana > 6) {
          throw new ErroDeContrato('dia_semana deve ser um número de 0 (domingo) a 6', 'dia_semana');
        }
        if (!HORA.test(janela?.hora_inicio) || !HORA.test(janela?.hora_fim)) {
          throw new ErroDeContrato('hora_inicio e hora_fim devem estar no formato HH:MM', 'hora_inicio');
        }
        if (janela.hora_fim <= janela.hora_inicio) {
          throw new ErroDeContrato('hora_fim precisa ser depois de hora_inicio', 'hora_fim');
        }
      }

      const janelas = await repositorio.definirDisponibilidades(id, corpo.janelas);
      await repositorio.registrarAuditoria({
        entidade: 'profissional', entidadeId: id,
        acao: 'disponibilidade_definida',
        detalhe: { janelas: janelas.length }, usuarioId: usuario.id,
      });

      return { disponibilidades: janelas };
    },

    // ---------------------------------------------------------------- bloqueios

    async criarBloqueio(usuario, corpo) {
      exigirPermissao(usuario, 'conversas:priorizar');

      const bloqueio = await repositorio.criarBloqueio({
        profissionalId: corpo?.profissional_id ? exigirIdentificador(corpo.profissional_id, 'profissional_id') : null,
        inicio: exigirData(corpo?.inicio, 'inicio'),
        fim: exigirData(corpo?.fim, 'fim'),
        motivo: corpo?.motivo ?? null,
        criadoPor: usuario.id,
      });

      await repositorio.registrarAuditoria({
        entidade: 'bloqueio', entidadeId: bloqueio.id,
        acao: 'bloqueio_criado', detalhe: { motivo: corpo?.motivo }, usuarioId: usuario.id,
      });

      return { bloqueio };
    },

    async removerBloqueio(usuario, bloqueioId) {
      exigirPermissao(usuario, 'conversas:priorizar');
      const id = exigirIdentificador(bloqueioId, 'bloqueio_id');

      const removidos = await repositorio.removerBloqueio(id);
      if (removidos === 0) {
        const erro = new Error('bloqueio não encontrado');
        erro.status = 404;
        throw erro;
      }

      await repositorio.registrarAuditoria({
        entidade: 'bloqueio', entidadeId: id, acao: 'bloqueio_removido', usuarioId: usuario.id,
      });
      return { removido: true };
    },

    // ---------------------------------------------------------------- agendamentos

    /** GET /api/agenda?inicio=&fim=&profissional= — o que o calendário desenha. */
    async listar(usuario, parametros) {
      exigirPermissao(usuario, 'conversas:ler');

      const inicio = parametros.get('inicio');
      const fim = parametros.get('fim');
      if (!inicio || !fim) throw new ErroDeContrato('informe "inicio" e "fim"', 'inicio');

      const agendamentos = await repositorio.listarAgendamentos({
        profissionalId: parametros.get('profissional') || null,
        conversaId: parametros.get('conversa') || null,
        contatoId: parametros.get('contato') || null,
        inicio: exigirData(inicio, 'inicio'),
        fim: exigirData(fim, 'fim'),
        incluirCancelados: parametros.get('cancelados') === 'sim',
      });

      const bloqueios = await repositorio.listarBloqueios({
        profissionalId: parametros.get('profissional') || null,
        inicio, fim,
      });

      return { agendamentos, bloqueios };
    },

    /** GET /api/agenda/horarios?profissional=&dia= — o que existe de verdade. */
    async horariosLivres(usuario, parametros) {
      exigirPermissao(usuario, 'conversas:ler');

      const profissionalId = exigirIdentificador(parametros.get('profissional'), 'profissional');
      const dia = exigirData(parametros.get('dia'), 'dia');
      const duracao = parametros.get('duracao') ? Number(parametros.get('duracao')) : null;

      return agenda.oferecerHorarios({ profissionalId, dia, duracaoMin: duracao });
    },

    /** POST /api/agenda/propor — devolve token; **não grava**. */
    async propor(usuario, corpo) {
      exigirPermissao(usuario, 'conversas:responder');

      return agenda.propor({
        profissionalId: exigirIdentificador(corpo?.profissional_id, 'profissional_id'),
        contatoId: exigirIdentificador(corpo?.contato_id, 'contato_id'),
        leadId: corpo?.lead_id ?? null,
        conversaId: corpo?.conversa_id ?? null,
        inicio: exigirData(corpo?.inicio, 'inicio'),
        fim: exigirData(corpo?.fim, 'fim'),
        tipo: corpo?.tipo ?? 'consulta',
      });
    },

    /** POST /api/agenda/confirmar — só aqui algo entra na agenda. */
    async confirmar(usuario, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const token = exigirTexto(corpo?.token, 'token', 100);

      const agendamento = await agenda.confirmar(token, {
        usuarioId: usuario.id,
        observacoes: corpo?.observacoes ?? null,
      });
      return { agendamento };
    },

    /** POST /api/agenda/:id/remarcar */
    async remarcar(usuario, agendamentoId, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const id = exigirIdentificador(agendamentoId, 'agendamento_id');

      const agendamento = await agenda.remarcar(id, {
        inicio: exigirData(corpo?.inicio, 'inicio'),
        fim: exigirData(corpo?.fim, 'fim'),
        motivo: corpo?.motivo ?? null,
        usuarioId: usuario.id,
      });
      return { agendamento };
    },

    /** POST /api/agenda/:id/cancelar */
    async cancelar(usuario, agendamentoId, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const id = exigirIdentificador(agendamentoId, 'agendamento_id');

      const agendamento = await agenda.cancelar(id, {
        motivo: corpo?.motivo ?? null,
        usuarioId: usuario.id,
      });
      return { agendamento };
    },

    /** POST /api/agenda/:id/status — confirmado, compareceu, faltou. */
    async definirStatus(usuario, agendamentoId, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const id = exigirIdentificador(agendamentoId, 'agendamento_id');

      const status = exigirTexto(corpo?.status, 'status', 20);
      // Cancelar tem rota própria, com motivo: não entra por aqui.
      const permitidos = ['confirmado', 'compareceu', 'faltou', 'agendado'];
      if (!permitidos.includes(status)) {
        throw new ErroDeContrato(`status deve ser um de: ${permitidos.join(', ')}`, 'status');
      }

      const agendamento = await agenda.definirStatus(id, status, { usuarioId: usuario.id });
      return { agendamento };
    },

    /** GET /api/conversas/:id/agenda — a agenda vista de dentro da conversa. */
    async daConversa(usuario, conversaId) {
      exigirPermissao(usuario, 'conversas:ler');
      const id = exigirIdentificador(conversaId, 'conversa_id');

      const conversa = await repositorio.obterConversa(id);
      if (!conversa) {
        const erro = new Error('conversa não encontrada');
        erro.status = 404;
        throw erro;
      }

      // Todos os agendamentos do contato, não só os desta conversa: quem atende
      // precisa ver se a pessoa já tem horário marcado por outro caminho.
      const agendamentos = await repositorio.listarAgendamentos({ contatoId: conversa.contato_id });
      const profissionais = await repositorio.listarProfissionais();

      return {
        conversa_id: id,
        contato_id: conversa.contato_id,
        // Nome e telefone junto: quem marca a partir da conversa precisa ver
        // para quem está marcando, e a tela não deve ter de adivinhar isso.
        contato: {
          id: conversa.contato_id,
          nome: conversa.contato?.nome ?? null,
          telefone: conversa.contato?.telefone ?? null,
        },
        lead_id: conversa.lead_id ?? null,
        agendamentos,
        profissionais,
      };
    },
  };
}

module.exports = { criarRotasDeAgenda };
