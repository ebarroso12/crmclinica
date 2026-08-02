'use strict';

const {
  TIPOS, MAX_TENTATIVAS_PADRAO, LEASE_MS,
  planejarLembretes, decidirEnvio, proximaTentativa, esgotou,
  montarEnvelope, mascararTelefone, ErroDeLembrete,
} = require('./lembretes');

// Serviço da fila de lembretes.
//
// Amarra três coisas que sozinhas não bastam: a fila persistente (repositório),
// a decisão (domínio) e a saída (adaptador do OpenClaw).
//
// Duas garantias atravessam este arquivo inteiro:
//
//   1. **Nada é enviado sem reler o mundo.** Entre enfileirar e enviar passa um
//      dia. A decisão de mandar usa o agendamento e o contato relidos agora, não
//      a foto de ontem. Cancelou, remarcou, pediu para parar: o lembrete morre.
//
//   2. **Duplicidade é impossível por construção, não por cuidado.** Enfileirar
//      é idempotente pela constraint `lembretes_unicos`; reivindicar é exclusivo
//      pelo `FOR UPDATE SKIP LOCKED`. Nenhum dos dois depende de o código lembrar
//      de checar antes.

const NOME_CLINICA_PADRAO = 'Clínica Dr. Edson Barroso';

function criarServicoDeLembretes({
  repositorio,
  entrega,
  clinica = NOME_CLINICA_PADRAO,
  agora = () => new Date(),
  maxTentativas = MAX_TENTATIVAS_PADRAO,
  leaseMs = LEASE_MS,
} = {}) {
  if (!repositorio) throw new Error('serviço de lembretes exige um repositório');

  /** Auditoria nunca derruba o fluxo: registrar é importante, mas não é o produto. */
  async function auditar(acao, lembreteId, detalhe = null, usuarioId = null) {
    try {
      await repositorio.registrarAuditoria({
        entidade: 'lembrete',
        entidadeId: lembreteId,
        acao,
        detalhe,
        usuarioId,
      });
    } catch (erro) {
      console.error(`[lembretes] falha ao auditar "${acao}": ${erro.message}`);
    }
  }

  /**
   * Coloca na fila os lembretes de um agendamento.
   *
   * Chamar duas vezes não cria duas linhas: a constraint resolve, e o
   * repositório devolve `criado: false` para a repetição. É o que permite
   * rodar `sincronizar` sem medo sobre uma agenda inteira.
   */
  async function enfileirarPara(agendamento, { usuarioId = null } = {}) {
    if (!agendamento?.id) throw new ErroDeLembrete('agendamento inválido', 'agendamento_invalido');

    // Agendamento que já nasceu cancelado, ou que registra algo que aconteceu,
    // não gera lembrete nenhum.
    if (['cancelado', 'compareceu', 'faltou'].includes(agendamento.status)) {
      return { criados: [], repetidos: [], ignorados: [] };
    }

    const planejados = planejarLembretes(agendamento, { agora: agora() });
    const criados = [];
    const repetidos = [];
    const ignorados = [];

    for (const plano of planejados) {
      const { lembrete, criado } = await repositorio.enfileirarLembrete({
        agendamentoId: agendamento.id,
        contatoId: agendamento.contato_id,
        tipo: plano.tipo,
        janela: plano.janela,
        agendarPara: plano.agendarPara,
        estado: plano.estado,
        ignoradoMotivo: plano.ignoradoMotivo,
        maxTentativas,
      });

      if (!criado) {
        repetidos.push(lembrete);
        continue;
      }

      if (plano.estado === 'ignorado') {
        ignorados.push(lembrete);
        await auditar('lembrete_ignorado', lembrete.id, {
          tipo: plano.tipo, motivo: plano.ignoradoMotivo, agendamento_id: agendamento.id,
        }, usuarioId);
        continue;
      }

      criados.push(lembrete);
      await auditar('lembrete_criado', lembrete.id, {
        tipo: plano.tipo, agendamento_id: agendamento.id, agendar_para: plano.agendarPara,
      }, usuarioId);
    }

    return { criados, repetidos, ignorados };
  }

  /**
   * Tira da fila o que ainda não saiu de um agendamento.
   *
   * Usado no cancelamento e na remarcação. `exceto` preserva os lembretes da
   * janela nova, para que remarcar não apague o que acabou de ser enfileirado.
   */
  async function cancelarDoAgendamento(agendamentoId, { motivo = 'cancelado', usuarioId = null, exceto = null } = {}) {
    const cancelados = await repositorio.cancelarLembretesDoAgendamento(agendamentoId, {
      motivo,
      exceto,
    });

    for (const lembrete of cancelados) {
      await auditar('lembrete_cancelado', lembrete.id, {
        tipo: lembrete.tipo, motivo, agendamento_id: Number(agendamentoId),
      }, usuarioId);
    }

    return cancelados;
  }

  /**
   * Reconcilia a fila com o agendamento como ele está agora.
   *
   * Remarcar é isto: enfileira a janela nova e descarta a antiga. A ordem
   * importa — enfileirar primeiro garante que, se algo falhar no meio, sobra
   * lembrete a mais (que a decisão de envio descarta) e não lembrete a menos.
   */
  async function sincronizarAgendamento(agendamentoId, { usuarioId = null, motivo = 'remarcado' } = {}) {
    const agendamento = await repositorio.obterAgendamento(agendamentoId);
    if (!agendamento) throw new ErroDeLembrete('agendamento não encontrado', 'agendamento_ausente', 404);

    if (['cancelado', 'compareceu', 'faltou'].includes(agendamento.status)) {
      const cancelados = await cancelarDoAgendamento(agendamento.id, {
        motivo: `agendamento_${agendamento.status}`,
        usuarioId,
      });
      return { enfileirados: { criados: [], repetidos: [], ignorados: [] }, cancelados };
    }

    const enfileirados = await enfileirarPara(agendamento, { usuarioId });
    const cancelados = await cancelarDoAgendamento(agendamento.id, {
      motivo,
      usuarioId,
      exceto: agendamento.inicio,
    });

    return { enfileirados, cancelados };
  }

  /**
   * Devolve à fila as linhas que um worker morto deixou em 'processando'.
   *
   * Conta como tentativa: um lembrete que trava o worker toda vez precisa
   * chegar em 'falhou' algum dia, em vez de circular para sempre.
   */
  async function recuperarPresos() {
    const momento = agora();
    const limite = new Date(momento.getTime() - leaseMs);

    const liberados = await repositorio.liberarLembretesPresos({
      antesDe: limite.toISOString(),
      agora: momento.toISOString(),
    });

    for (const lembrete of liberados) {
      await auditar(lembrete.estado === 'falhou' ? 'lembrete_falhou' : 'lembrete_retry', lembrete.id, {
        motivo: 'processamento_abandonado',
        tentativas: lembrete.tentativas,
      });
    }

    return liberados;
  }

  /** Marca o resultado de um lembrete e audita o que aconteceu. */
  async function concluir(lembrete, resultado) {
    const atualizado = await repositorio.concluirLembrete(lembrete.id, resultado);
    return atualizado;
  }

  async function processarUm(lembrete) {
    const momento = agora();

    const decisao = decidirEnvio({
      lembrete,
      agendamento: lembrete.agendamento,
      contato: lembrete.contato,
      agora: momento,
    });

    if (!decisao.enviar) {
      // "Ainda não é hora" não é motivo para ignorar: a linha volta à fila
      // intacta. Acontece quando o relógio do worker corre à frente do banco.
      if (decisao.motivo === 'ainda_nao_e_hora') {
        await concluir(lembrete, {
          estado: 'pendente',
          tentarEm: lembrete.agendar_para,
          // Não gastou tentativa: não houve falha.
          tentativas: lembrete.tentativas,
        });
        return { id: lembrete.id, estado: 'pendente', motivo: decisao.motivo };
      }

      const ignorado = await concluir(lembrete, {
        estado: 'ignorado',
        ignoradoMotivo: decisao.motivo,
      });
      await auditar('lembrete_ignorado', lembrete.id, {
        tipo: lembrete.tipo,
        motivo: decisao.motivo,
        agendamento_id: lembrete.agendamento_id,
      });
      return { id: lembrete.id, estado: 'ignorado', motivo: decisao.motivo, lembrete: ignorado };
    }

    const envelope = montarEnvelope({
      lembrete,
      agendamento: lembrete.agendamento,
      contato: lembrete.contato,
      clinica,
      agora: momento,
    });

    try {
      const saida = await entrega.enviar(envelope);

      const enviado = await concluir(lembrete, {
        estado: 'enviado',
        modoEntrega: saida.modo,
        entregaReferencia: saida.referencia ?? null,
        enviadoEm: momento.toISOString(),
        ultimoErro: null,
      });

      // Ação distinta de propósito: `lembrete_simulado` nunca vira
      // `lembrete_enviado` num relatório. Em dry-run, nada saiu.
      await auditar(saida.entregue ? 'lembrete_enviado' : 'lembrete_simulado', lembrete.id, {
        tipo: lembrete.tipo,
        modo: saida.modo,
        agendamento_id: lembrete.agendamento_id,
        destinatario: mascararTelefone(envelope.destinatario),
      });

      return { id: lembrete.id, estado: 'enviado', modo: saida.modo, entregue: saida.entregue, lembrete: enviado };
    } catch (erro) {
      const tentativas = Number(lembrete.tentativas) + 1;
      // Erro permanente não melhora com repetição: vai direto para 'falhou'.
      const definitivo = erro.permanente === true || esgotou(tentativas, lembrete.max_tentativas ?? maxTentativas);

      const marcado = await concluir(lembrete, {
        estado: definitivo ? 'falhou' : 'pendente',
        tentativas,
        tentarEm: definitivo ? null : proximaTentativa(tentativas, { agora: momento }).toISOString(),
        ultimoErro: `${erro.codigo ? `${erro.codigo}: ` : ''}${erro.message}`.slice(0, 500),
      });

      await auditar(definitivo ? 'lembrete_falhou' : 'lembrete_retry', lembrete.id, {
        tipo: lembrete.tipo,
        tentativas,
        codigo: erro.codigo ?? null,
        permanente: erro.permanente === true,
      });

      return {
        id: lembrete.id,
        estado: definitivo ? 'falhou' : 'pendente',
        erro: erro.codigo ?? erro.message,
        lembrete: marcado,
      };
    }
  }

  /**
   * Uma passada da fila.
   *
   * `reivindicarLembretes` é a operação que impede duplicidade entre workers:
   * ela seleciona com `FOR UPDATE SKIP LOCKED` e já marca 'processando' na mesma
   * transação. Quem chega depois não enxerga o que o primeiro pegou.
   */
  async function processarLote({ limite = 20, worker = 'worker' } = {}) {
    const momento = agora();

    const presos = await recuperarPresos();

    const reivindicados = await repositorio.reivindicarLembretes({
      agora: momento.toISOString(),
      limite,
      worker,
    });

    const resultados = [];
    for (const lembrete of reivindicados) {
      resultados.push(await processarUm(lembrete));
    }

    return {
      instante: momento.toISOString(),
      recuperados: presos.length,
      reivindicados: reivindicados.length,
      enviados: resultados.filter((item) => item.estado === 'enviado').length,
      ignorados: resultados.filter((item) => item.estado === 'ignorado').length,
      falhados: resultados.filter((item) => item.estado === 'falhou').length,
      reagendados: resultados.filter((item) => item.estado === 'pendente').length,
      modo: entrega.modo,
      resultados,
    };
  }

  // ---------------------------------------------------------------- opt-out

  /**
   * Liga ou desliga os lembretes para um contato.
   *
   * Desligar cancela na hora o que está na fila: esperar o worker perceber
   * deixaria uma janela em que a pessoa que acabou de pedir "PARAR" ainda
   * receberia a próxima mensagem.
   */
  async function definirOptOut(contatoId, { optout = true, motivo = null, usuarioId = null, origem = 'equipe' } = {}) {
    const contato = await repositorio.definirOptOutDeLembretes(contatoId, {
      optout,
      motivo,
      agora: agora().toISOString(),
    });

    if (!contato) throw new ErroDeLembrete('contato não encontrado', 'contato_ausente', 404);

    let cancelados = [];
    if (optout) {
      cancelados = await repositorio.cancelarLembretesDoContato(contatoId, { motivo: 'optout' });
      for (const lembrete of cancelados) {
        await auditar('lembrete_cancelado', lembrete.id, { motivo: 'optout', contato_id: Number(contatoId) }, usuarioId);
      }
    }

    await repositorio.registrarAuditoria({
      entidade: 'contato',
      entidadeId: Number(contatoId),
      acao: optout ? 'lembretes_optout' : 'lembretes_optin',
      detalhe: { motivo, origem, cancelados: cancelados.length },
      usuarioId,
    });

    return { contato, cancelados };
  }

  // ---------------------------------------------------------------- consulta

  async function listar({ estado = null, tipo = null, agendamentoId = null, contatoId = null, limite = 50 } = {}) {
    if (estado && !['pendente', 'processando', 'enviado', 'ignorado', 'falhou'].includes(estado)) {
      throw new ErroDeLembrete(`estado desconhecido: ${estado}`, 'estado_invalido');
    }
    if (tipo && !TIPOS.includes(tipo)) throw new ErroDeLembrete(`tipo desconhecido: ${tipo}`, 'tipo_invalido');

    return repositorio.listarLembretes({ estado, tipo, agendamentoId, contatoId, limite });
  }

  async function resumo() {
    const contagem = await repositorio.contarLembretesPorEstado();
    return {
      entrega: entrega.descrever(),
      fila: contagem,
      // Quem lê o resumo precisa saber o que "enviado" significa hoje.
      observacao: entrega.modo === 'dry_run'
        ? 'modo dry-run: lembretes marcados como "enviado" foram simulados e nenhuma mensagem saiu'
        : null,
    };
  }

  /** Devolve um lembrete falhado para a fila. É a correção manual depois do conserto. */
  async function reenfileirar(id, { usuarioId = null } = {}) {
    const lembrete = await repositorio.obterLembrete(id);
    if (!lembrete) throw new ErroDeLembrete('lembrete não encontrado', 'lembrete_ausente', 404);
    if (!['falhou', 'ignorado'].includes(lembrete.estado)) {
      throw new ErroDeLembrete(
        `só lembrete em "falhou" ou "ignorado" pode voltar à fila; este está em "${lembrete.estado}"`,
        'estado_invalido',
      );
    }

    const voltou = await repositorio.concluirLembrete(id, {
      estado: 'pendente',
      tentativas: 0,
      tentarEm: agora().toISOString(),
      ultimoErro: null,
      ignoradoMotivo: null,
    });

    await auditar('lembrete_retry', id, { motivo: 'reenfileirado_manualmente', de: lembrete.estado }, usuarioId);
    return voltou;
  }

  /**
   * Varre a agenda futura e enfileira o que ainda não tem lembrete.
   *
   * Existe por dois motivos: agendamentos criados antes desta funcionalidade, e
   * qualquer buraco deixado por uma falha no meio do caminho. É idempotente —
   * rodar de novo não cria nada a mais.
   */
  async function sincronizarAgenda({ ate = null, usuarioId = null } = {}) {
    const inicio = agora();
    const fim = ate ? new Date(ate) : new Date(inicio.getTime() + 60 * 24 * 60 * 60 * 1000);

    const agendamentos = await repositorio.listarAgendamentos({
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
    });

    let criados = 0;
    let repetidos = 0;
    let ignorados = 0;

    for (const agendamento of agendamentos) {
      const resultado = await enfileirarPara(agendamento, { usuarioId });
      criados += resultado.criados.length;
      repetidos += resultado.repetidos.length;
      ignorados += resultado.ignorados.length;
    }

    return { agendamentos: agendamentos.length, criados, repetidos, ignorados };
  }

  return {
    enfileirarPara,
    cancelarDoAgendamento,
    sincronizarAgendamento,
    sincronizarAgenda,
    recuperarPresos,
    processarLote,
    processarUm,
    definirOptOut,
    listar,
    resumo,
    reenfileirar,
    modo: () => entrega.modo,
  };
}

module.exports = { criarServicoDeLembretes, NOME_CLINICA_PADRAO };
