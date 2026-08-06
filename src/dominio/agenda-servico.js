'use strict';

const crypto = require('node:crypto');
const {
  validarPeriodo, dentroDaDisponibilidade, bloqueado, conflitante,
  horariosLivres, comHoraLocal, ehConflitoDoBanco, ErroDeConflito, ErroDeAgenda, TIPOS,
} = require('./agenda');

// Serviço da agenda.
//
// Duas coisas que este arquivo faz questão de garantir:
//
//  1. **Confirmação explícita antes de gravar.** Oferecer um horário e marcar na
//     mesma ação é como a clínica acaba com consulta que o paciente não pediu.
//     O fluxo é: propor → a pessoa confirma o que foi proposto → gravar.
//
//  2. **O conflito é do banco.** A checagem daqui existe para dar uma resposta
//     melhor; a garantia é a constraint. Quando ela dispara, traduzimos.

const VALIDADE_PROPOSTA_MS = 15 * 60 * 1000;

/**
 * @param {object} dependencias.lembretes  Serviço da fila de lembretes, opcional.
 *   Opcional porque a agenda existia antes dele e continua correta sem ele: sem
 *   o serviço, marcar e cancelar funcionam igual, apenas nenhum lembrete é
 *   enfileirado. E porque uma falha na fila nunca pode impedir a clínica de
 *   marcar uma consulta — por isso toda chamada aqui é embrulhada.
 */
function criarServicoDeAgenda({ repositorio, agora = () => new Date(), lembretes = null, google = null, clinica = null, carenciaEmDias = 3 }) {
  /** A fila é acessório do agendamento: se ela falhar, o agendamento continua de pé. */
  async function comFila(descricao, acao) {
    if (!lembretes) return null;
    try {
      return await acao();
    } catch (erro) {
      console.error(`[agenda] falha ao ${descricao} lembretes: ${erro.message}`);
      return null;
    }
  }

  // Propostas em memória: são efêmeras por natureza e morrem em 15 minutos.
  // Guardar no banco daria durabilidade a algo que não deve durar.
  const propostas = new Map();

  function limparPropostasVencidas() {
    const limite = agora().getTime();
    for (const [chave, proposta] of propostas) {
      if (proposta.validaAte < limite) propostas.delete(chave);
    }
  }

  /** Reúne o que a agenda precisa saber sobre um profissional num período. */
  async function contexto(profissionalId, inicio, fim) {
    const [profissional, disponibilidades, bloqueios, agendamentos] = await Promise.all([
      repositorio.obterProfissional(profissionalId),
      repositorio.listarDisponibilidades(profissionalId),
      repositorio.listarBloqueios({ profissionalId, inicio, fim }),
      repositorio.listarAgendamentos({ profissionalId, inicio, fim }),
    ]);

    if (!profissional) {
      const erro = new Error('profissional não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (!profissional.ativo) throw new ErroDeAgenda('profissional inativo', 'profissional_inativo');

    return { profissional, disponibilidades, bloqueios, agendamentos };
  }

  /** Horários livres de um dia, para oferecer o que existe de verdade. */
  async function oferecerHorarios({ profissionalId, dia, duracaoMin = null }) {
    const data = new Date(dia);
    if (Number.isNaN(data.getTime())) throw new ErroDeAgenda('dia inválido', 'data_invalida');

    // O dia é o da CLÍNICA, não o do processo. `setHours(0…23:59)` aqui usava o
    // fuso da máquina: em UTC, a "janela do dia" nascia deslocada três horas do
    // dia de São Paulo cujos horários seriam gerados — e os agendamentos da
    // manhã ficavam FORA da janela consultada. Nada os via, nada bloqueava, e a
    // oferta mostrava como livre um horário já marcado; o paciente escolhia, e
    // só a trava do banco o parava, com uma recusa que a conversa não explicava.
    // Em São Paulo os dois relógios coincidem — por isso os testes locais nunca
    // pegaram. É a mesma família do defeito de f4c23ac, uma camada acima.
    const inicioDoDia = comHoraLocal(data, 0);
    const fimDoDia = comHoraLocal(data, 24 * 60);

    const dados = await contexto(profissionalId, inicioDoDia.toISOString(), fimDoDia.toISOString());

    // O que está no Google e não veio do CRM é consulta marcada por fora — pelo
    // celular, por outra pessoa. Sem trazer para cá, o CRM ofereceria um horário
    // que o médico já tem ocupado, e dois pacientes chegariam na mesma hora.
    //
    // Os que vieram do CRM já estão em `dados.agendamentos`: contá-los de novo
    // não muda o resultado, mas duplicar sem necessidade é ruído.
    const doGoogle = await ocupadosNoGoogle(inicioDoDia, fimDoDia);

    const livres = horariosLivres({
      dia: inicioDoDia,
      duracaoMin: duracaoMin ?? dados.profissional.duracao_min,
      disponibilidades: dados.disponibilidades,
      bloqueios: dados.bloqueios,
      agendamentos: [...dados.agendamentos, ...doGoogle],
      agora: agora(),
    });

    return {
      profissional: dados.profissional,
      dia: inicioDoDia.toISOString(),
      // A carência existe porque a clínica não marca para amanhã: o paciente
      // precisa de tempo para preencher o questionário de pré-consulta, e o
      // médico para lê-lo antes de atender.
      horarios: livres.filter((h) => new Date(h.inicio) >= limiteDeCarencia()),
    };
  }

  /**
   * Nada antes disto: a marcação começa a valer alguns dias após o contato.
   *
   * Conta dias inteiros, não horas. Quem procura a clínica às 18h e quem procura
   * às 8h do mesmo dia têm direito ao mesmo primeiro horário — e sem zerar a
   * hora, o contato do fim da tarde perderia a manhã do terceiro dia, que já
   * está dentro do prazo.
   */
  function limiteDeCarencia() {
    // "Dia inteiro" no calendário da CLÍNICA: `setHours(0)` aqui era a meia-
    // noite do fuso do processo, e em UTC o limite nascia às 21h de São Paulo
    // do dia anterior — três horas de carência a menos, silenciosamente.
    const alvo = new Date(agora().getTime() + carenciaEmDias * 86_400_000);
    return comHoraLocal(alvo, 0);
  }

  /**
   * O que o Google já tem ocupado no período.
   *
   * Falha do Google não pode impedir a clínica de oferecer horário: sem esta
   * tolerância, o Google fora do ar deixaria a agenda inteira parecer cheia. O
   * risco assumido é o oposto — oferecer um horário que só existe lá — e ele é
   * menor que não oferecer nenhum.
   */
  async function ocupadosNoGoogle(de, ate) {
    if (!google?.configurada) return [];

    try {
      const eventos = await google.ocupados({ de, ate });
      return eventos
        .filter((evento) => !evento.doCrm)
        // `status: 'confirmado'` é exigência de `conflitante`, que ignora o que
        // não ocupa horário. Sem ele, o evento do Google entraria na lista e
        // seria descartado em silêncio — a agenda pareceria livre.
        .map((evento) => ({ inicio: evento.inicio, fim: evento.fim, status: 'confirmado' }));
    } catch (erro) {
      console.error(`[agenda] não foi possível ler o Google: ${erro.message}`);
      return [];
    }
  }

  /**
   * Propõe um horário e devolve um token.
   *
   * Nada é gravado aqui. O token amarra a confirmação **àquele** horário: sem
   * ele, a pessoa confirmaria "sim" e a aplicação teria de adivinhar sobre o quê.
   */
  async function propor({ profissionalId, contatoId, inicio, fim, tipo = 'consulta', conversaId = null, leadId = null }) {
    limparPropostasVencidas();

    const periodo = validarPeriodo(inicio, fim, { agora: agora() });
    if (!TIPOS.includes(tipo)) throw new ErroDeAgenda(`tipo deve ser um de: ${TIPOS.join(', ')}`, 'tipo_invalido');

    const dados = await contexto(profissionalId, periodo.inicio.toISOString(), periodo.fim.toISOString());

    if (!dentroDaDisponibilidade(periodo.inicio, periodo.fim, dados.disponibilidades)) {
      throw new ErroDeAgenda('o horário está fora da agenda de atendimento', 'fora_da_disponibilidade');
    }

    const impedimento = bloqueado(periodo.inicio, periodo.fim, dados.bloqueios);
    if (impedimento) {
      throw new ErroDeAgenda(
        `o horário está bloqueado${impedimento.motivo ? `: ${impedimento.motivo}` : ''}`,
        'bloqueado',
      );
    }

    const ocupado = conflitante(periodo.inicio, periodo.fim, dados.agendamentos);
    if (ocupado) throw new ErroDeConflito({ inicio: ocupado.inicio, fim: ocupado.fim });

    const token = crypto.randomBytes(16).toString('base64url');
    propostas.set(token, {
      profissionalId: Number(profissionalId),
      contatoId: Number(contatoId),
      leadId: leadId ? Number(leadId) : null,
      conversaId: conversaId ? Number(conversaId) : null,
      inicio: periodo.inicio.toISOString(),
      fim: periodo.fim.toISOString(),
      tipo,
      validaAte: agora().getTime() + VALIDADE_PROPOSTA_MS,
    });

    return {
      token,
      profissional: { id: dados.profissional.id, nome: dados.profissional.nome },
      inicio: periodo.inicio.toISOString(),
      fim: periodo.fim.toISOString(),
      tipo,
      expira_em_segundos: Math.round(VALIDADE_PROPOSTA_MS / 1000),
      // A frase que a automação lê para a pessoa antes de gravar. Sem segundos:
      // ninguém confirma consulta "às 09:00:00", e o ruído atrapalha quem lê em
      // voz alta no telefone.
      confirmar: `Confirmar ${tipo} com ${dados.profissional.nome} em `
        + `${periodo.inicio.toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })}?`,
    };
  }

  /**
   * Confirma a proposta e grava.
   * Só aqui algo entra na agenda — e só o que foi proposto.
   */
  async function confirmar(token, { usuarioId = null, observacoes = null } = {}) {
    limparPropostasVencidas();

    const proposta = propostas.get(token);
    if (!proposta) {
      throw new ErroDeAgenda('proposta não encontrada ou expirada; ofereça o horário de novo', 'proposta_invalida');
    }
    propostas.delete(token);

    return gravar({ ...proposta, observacoes, usuarioId });
  }

  /**
   * Grava o agendamento.
   *
   * A checagem em memória já rodou, mas entre ela e este insert existe uma
   * janela. Quem fecha essa janela é a constraint — por isso o `catch` traduz o
   * erro dela em vez de confiar que a checagem bastou.
   */
  async function gravar({
    profissionalId, contatoId, leadId = null, conversaId = null,
    inicio, fim, tipo = 'consulta', observacoes = null, usuarioId = null,
  }) {
    try {
      const agendamento = await repositorio.criarAgendamento({
        profissionalId, contatoId, leadId, conversaId, inicio, fim, tipo, observacoes, criadoPor: usuarioId,
      });

      await repositorio.registrarAuditoria({
        entidade: 'agendamento',
        entidadeId: agendamento.id,
        acao: 'agendamento_criado',
        detalhe: { profissional_id: profissionalId, inicio, fim, tipo },
        usuarioId,
      });

      // O lead avança na jornada junto: agendar é o marco que o kanban espera.
      if (leadId) {
        await repositorio.registrarEventoDeLead({
          lead_id: leadId,
          conversa_id: conversaId,
          tipo: 'agendamento',
          para: 'agendado',
          detalhe: { agendamento_id: agendamento.id, inicio },
          origem: usuarioId ? 'equipe' : 'automacao',
          usuario_id: usuarioId,
        });
      }

      // Os lembretes de 24h e 2h entram na fila junto com o agendamento. Se a
      // consulta é daqui a três horas, o de 24h nasce ignorado com o motivo
      // registrado — a clínica precisa poder ver que não houve 24h para avisar.
      await comFila('enfileirar', () => lembretes.enfileirarPara(agendamento, { usuarioId }));

      // O espelho no Google vem por último e nunca derruba o agendamento: a
      // consulta já está marcada e a trava de conflito já valeu. Se o Google
      // estiver fora do ar, a clínica atende do mesmo jeito — o que se perde é
      // a consulta aparecer no celular do médico, não a consulta.
      await espelharNoGoogle(agendamento);

      return agendamento;
    } catch (erro) {
      if (ehConflitoDoBanco(erro)) throw await descreverConflito(profissionalId, inicio, fim);
      throw erro;
    }
  }


  /**
   * Espelha o agendamento no Google Calendar do médico.
   *
   * Silencioso por escolha: o espelho é conveniência. Fazer o agendamento
   * falhar porque o Google não respondeu seria trocar a consulta — que é o
   * negócio — por uma linha no calendário.
   */
  async function espelharNoGoogle(agendamento) {
    if (!google?.configurada) return;

    try {
      const contato = await repositorio.obterContato(agendamento.contato_id);
      const { evento_id: eventoId } = await google.espelhar({ agendamento, contato, clinica });

      // Guardar o identificador é o que permite atualizar e cancelar depois.
      // Sem ele, cada remarcação criaria um evento novo e o calendário
      // acumularia consultas fantasmas do mesmo paciente.
      if (eventoId) {
        await repositorio.atualizarAgendamento?.(agendamento.id, { google_evento_id: eventoId });
      }
    } catch (erro) {
      console.error(`[agenda] espelho no Google falhou: ${erro.message}`);
    }
  }
  /**
   * Descobre qual agendamento ocupou o horário.
   *
   * A constraint diz que houve conflito, não com o quê. Sem isto a recepção
   * recebe "ocupado" e precisa procurar na tela o que atrapalhou. Se a consulta
   * falhar, o erro sai sem o detalhe — melhor sem detalhe que sem resposta.
   */
  async function descreverConflito(profissionalId, inicio, fim) {
    try {
      const ocupados = await repositorio.listarAgendamentos({ profissionalId, inicio, fim });
      const ocupado = conflitante(new Date(inicio), new Date(fim), ocupados);
      if (ocupado) return new ErroDeConflito({ inicio: ocupado.inicio, fim: ocupado.fim });
    } catch {
      // Segue sem o detalhe.
    }
    return new ErroDeConflito();
  }

  /** Remarca. A constraint continua valendo para o horário novo. */
  async function remarcar(agendamentoId, { inicio, fim, usuarioId = null, motivo = null }) {
    const atual = await repositorio.obterAgendamento(agendamentoId);
    if (!atual) {
      const erro = new Error('agendamento não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (atual.status === 'cancelado') {
      throw new ErroDeAgenda('agendamento cancelado não pode ser remarcado', 'ja_cancelado');
    }

    const periodo = validarPeriodo(inicio, fim, { agora: agora() });
    const dados = await contexto(atual.profissional_id, periodo.inicio.toISOString(), periodo.fim.toISOString());

    if (!dentroDaDisponibilidade(periodo.inicio, periodo.fim, dados.disponibilidades)) {
      throw new ErroDeAgenda('o horário está fora da agenda de atendimento', 'fora_da_disponibilidade');
    }
    const impedimento = bloqueado(periodo.inicio, periodo.fim, dados.bloqueios);
    if (impedimento) throw new ErroDeAgenda('o horário está bloqueado', 'bloqueado');

    // Ignora o próprio agendamento: remarcar para o mesmo horário não é conflito.
    const ocupado = conflitante(periodo.inicio, periodo.fim, dados.agendamentos, { ignorarId: agendamentoId });
    if (ocupado) throw new ErroDeConflito({ inicio: ocupado.inicio, fim: ocupado.fim });

    try {
      const atualizado = await repositorio.atualizarAgendamento(agendamentoId, {
        inicio: periodo.inicio.toISOString(),
        fim: periodo.fim.toISOString(),
        // Remarcar desfaz a confirmação: a pessoa confirmou o horário antigo.
        status: 'agendado',
        confirmadoEm: null,
      });

      await repositorio.registrarAuditoria({
        entidade: 'agendamento',
        entidadeId: agendamentoId,
        acao: 'agendamento_remarcado',
        detalhe: { de: { inicio: atual.inicio, fim: atual.fim }, para: { inicio, fim }, motivo },
        usuarioId,
      });

      // Horário novo, lembretes novos. Os da janela antiga saem da fila com o
      // motivo "remarcado": mandar "seu horário é amanhã às 14h" depois de
      // remarcar para as 16h é pior que não mandar nada.
      await comFila('sincronizar', () => lembretes.sincronizarAgendamento(agendamentoId, { usuarioId }));

      return atualizado;
    } catch (erro) {
      if (ehConflitoDoBanco(erro)) throw new ErroDeConflito();
      throw erro;
    }
  }

  /** Cancela e libera o horário. */
  async function cancelar(agendamentoId, { motivo = null, usuarioId = null } = {}) {
    const atual = await repositorio.obterAgendamento(agendamentoId);
    if (!atual) {
      const erro = new Error('agendamento não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (atual.status === 'cancelado') return atual;

    const cancelado = await repositorio.atualizarAgendamento(agendamentoId, {
      status: 'cancelado',
      canceladoEm: agora().toISOString(),
      canceladoMotivo: motivo ? String(motivo).slice(0, 200) : null,
    });

    await repositorio.registrarAuditoria({
      entidade: 'agendamento',
      entidadeId: agendamentoId,
      acao: 'agendamento_cancelado',
      detalhe: { motivo },
      usuarioId,
    });

    // Cancelou, acabou: nada mais é enviado sobre este agendamento.
    await comFila('cancelar', () => lembretes.cancelarDoAgendamento(agendamentoId, {
      motivo: 'agendamento_cancelado', usuarioId,
    }));

    return cancelado;
  }

  /** Muda o status: confirmado, compareceu, faltou. */
  async function definirStatus(agendamentoId, status, { usuarioId = null } = {}) {
    const atual = await repositorio.obterAgendamento(agendamentoId);
    if (!atual) {
      const erro = new Error('agendamento não encontrado');
      erro.status = 404;
      throw erro;
    }

    const atualizado = await repositorio.atualizarAgendamento(agendamentoId, {
      status,
      ...(status === 'confirmado' ? { confirmadoEm: agora().toISOString() } : {}),
    });

    await repositorio.registrarAuditoria({
      entidade: 'agendamento',
      entidadeId: agendamentoId,
      acao: `agendamento_${status}`,
      usuarioId,
    });

    // O que já aconteceu não se lembra: compareceu e faltou encerram a fila
    // deste agendamento tanto quanto o cancelamento.
    if (['compareceu', 'faltou'].includes(status)) {
      await comFila('cancelar', () => lembretes.cancelarDoAgendamento(agendamentoId, {
        motivo: `agendamento_${status}`, usuarioId,
      }));
    }

    // Comparecer converte o lead; faltar é o dado que alimenta a métrica de falta.
    if (atual.lead_id && ['compareceu', 'faltou'].includes(status)) {
      await repositorio.registrarEventoDeLead({
        lead_id: atual.lead_id,
        conversa_id: atual.conversa_id,
        tipo: status === 'compareceu' ? 'comparecimento' : 'nota',
        para: status,
        detalhe: { agendamento_id: agendamentoId },
        origem: usuarioId ? 'equipe' : 'sistema',
        usuario_id: usuarioId,
      });
    }

    return atualizado;
  }

  return {
    oferecerHorarios,
    propor,
    confirmar,
    gravar,
    remarcar,
    cancelar,
    definirStatus,
    _propostas: propostas,
  };
}

module.exports = { criarServicoDeAgenda, VALIDADE_PROPOSTA_MS };
