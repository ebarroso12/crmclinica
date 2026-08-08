'use strict';

// Sincronia Google -> CRM: leitura incremental, reconciliação e conflitos
// (P0-11 e P0-12).
//
// O CRM continua a fonte administrativa de verdade. O que chega do Google
// NUNCA reescreve a agenda em silêncio: divergência vira conflito registrado
// e a decisão (crm_vence, google_vence, manual) é da clínica. A leitura
// inbound existe para três coisas:
//
//   1. detectar edição/cancelamento feito direto no Google — o médico mexe
//      no celular e a clínica precisa saber, não descobrir na hora;
//   2. manter o mapa de eventos externos (a vida do médico fora da clínica)
//      que a oferta de horários já consulta para não prometer horário ocupado;
//   3. carimbar etag/last_synced_at do que está igual, para o painel de
//      saúde mostrar a sincronia respirando.
//
// O cursor (nextSyncToken) só é gravado na última página de cada varredura.
// Gravar no meio perderia eventos se o processo morresse entre páginas; não
// gravar nada só refaz trabalho. E 410 — cursor vencido — não é erro: é o
// Google pedindo um full sync, que este módulo refaz de forma controlada.

const { ErroDoGoogle, agendamentoDoEventoId, idDoEvento } = require('../integracoes/google-calendario');

function criarSincroniaGoogle({
  repositorio,
  repositorioGoogle,
  calendario,
  outbox = null,
  agora = () => new Date(),
}) {
  const nomeDoCalendario = () => calendario.calendario ?? 'primary';

  function instantesIguais(a, b) {
    if (!a || !b) return false;
    return new Date(a).getTime() === new Date(b).getTime();
  }

  /**
   * Um evento visto na varredura. Decide entre: carimbar igualdade, registrar
   * conflito, ou apenas mapear como externo (a vida do médico fora da clínica
   * não é conflito — é contexto para a oferta de horários).
   */
  async function processarEvento(item, { origemDaVarredura }) {
    const eventoId = item.id;
    if (!eventoId) return { resultado: 'ignorado' };

    // Dono do evento: o id determinístico ou a propriedade estendida que o
    // espelho sempre gravou. Fora isso, o evento não é da clínica.
    const idPeloNome = agendamentoDoEventoId(eventoId);
    const idPelaPropriedade = Number(item.extendedProperties?.private?.crmclinica_agendamento) || null;
    const agendamentoId = idPeloNome ?? idPelaPropriedade;
    const agendamento = agendamentoId ? await repositorio.obterAgendamento(agendamentoId) : null;

    if (!agendamento) {
      if (agendamentoId) {
        // Carrega a marca da clínica mas o agendamento não existe mais (ou
        // nunca existiu neste banco): alguém precisa olhar para isso.
        await repositorioGoogle.registrarConflito({
          agendamentoId: null,
          googleEventoId: eventoId,
          tipo: 'evento_sem_dono',
          detalheGoogle: {
            agendamento_id_indicado: agendamentoId,
            titulo: item.summary ?? null,
            inicio: item.start?.dateTime ?? null,
            status: item.status ?? null,
          },
        });
        return { resultado: 'conflito', tipo: 'evento_sem_dono' };
      }

      // Evento alheio: entra no mapa de externos (confirmado ou cancelado) e
      // a vida segue. É isto que impede oferecer o horário do dentista.
      await repositorioGoogle.upsertEventoExterno({
        calendario: nomeDoCalendario(),
        googleEventoId: eventoId,
        status: item.status === 'cancelled' ? 'cancelado' : 'confirmado',
        inicio: item.start?.dateTime ?? null,
        fim: item.end?.dateTime ?? null,
        etag: item.etag ?? null,
        titulo: item.summary ?? null,
        atualizadoNoGoogleEm: item.updated ?? null,
      });
      return { resultado: 'externo' };
    }

    // A partir daqui o evento é da clínica.
    if (item.status === 'cancelled') {
      if (agendamento.status === 'cancelado') {
        // O CRM cancelou e o Google confirmou: estado final coerente.
        await repositorio.atualizarAgendamento(agendamento.id, {
          syncStatus: 'ok', lastSyncedAt: agora().toISOString(), lastSyncError: null,
        });
        return { resultado: 'ok' };
      }
      // Apagaram a consulta pelo Google. O CRM não aceita isso em silêncio:
      // a consulta continua marcada e o conflito aparece no painel.
      await repositorio.atualizarAgendamento(agendamento.id, { syncStatus: 'conflito' });
      await repositorioGoogle.registrarConflito({
        agendamentoId: agendamento.id,
        googleEventoId: eventoId,
        tipo: 'cancelado_no_google',
        detalheCrm: { inicio: agendamento.inicio, fim: agendamento.fim, status: agendamento.status },
        detalheGoogle: { status: 'cancelled', atualizado: item.updated ?? null },
      });
      return { resultado: 'conflito', tipo: 'cancelado_no_google' };
    }

    const inicioGoogle = item.start?.dateTime ?? null;
    const fimGoogle = item.end?.dateTime ?? null;
    const mesmosHorarios = instantesIguais(inicioGoogle, agendamento.inicio)
      && instantesIguais(fimGoogle, agendamento.fim);

    if (mesmosHorarios) {
      // Igual: carimba o etag novo e a leitura. É o batimento cardíaco da
      // sincronia — a maioria absoluta dos eventos passa por aqui.
      await repositorio.atualizarAgendamento(agendamento.id, {
        googleEtag: item.etag ?? agendamento.google_etag,
        syncStatus: 'ok',
        lastSyncedAt: agora().toISOString(),
        lastSyncError: null,
      });
      return { resultado: 'ok' };
    }

    // Horário divergente. Se o CRM acabou de mudar (há item mais novo na
    // fila), o outbox já vai impor o estado certo — conflito aqui seria
    // alarme falso. Só registra quando a divergência não tem origem local.
    if (agendamento.sync_status === 'pendente' && agendamento.origem_alteracao === 'crm') {
      return { resultado: 'aguardando_outbox' };
    }

    await repositorio.atualizarAgendamento(agendamento.id, { syncStatus: 'conflito' });
    await repositorioGoogle.registrarConflito({
      agendamentoId: agendamento.id,
      googleEventoId: eventoId,
      tipo: origemDaVarredura === 'reconciliacao' ? 'divergencia_reconciliacao' : 'edicao_concorrente',
      detalheCrm: { inicio: agendamento.inicio, fim: agendamento.fim, etag: agendamento.google_etag },
      detalheGoogle: { inicio: inicioGoogle, fim: fimGoogle, etag: item.etag ?? null, atualizado: item.updated ?? null },
    });
    return { resultado: 'conflito', tipo: 'edicao_concorrente' };
  }

  /**
   * Varre o calendário página a página, do jeito que o cursor pedir.
   *
   * Devolve contagens; o cursor novo só é persistido depois da última
   * página. Um 410 no meio refaz tudo como full sync, uma única vez — o
   * parâmetro `tentativa` impede o laço infinito se o Google insistir.
   */
  async function sincronizar({ janelaDias = 90 } = {}) {
    if (!calendario?.configurada) return { sincronizado: false, motivo: 'google_nao_configurado' };

    const nome = nomeDoCalendario();
    const estado = await repositorioGoogle.garantirEstadoDaSincronia(nome);
    const contagem = { paginas: 0, eventos: 0, externos: 0, conflitos: 0, ok: 0, fullSync: false };

    async function varrer({ syncToken = null, fullSync = false }, tentativa = 1) {
      let pagina = null;
      let cursorFinal = null;
      const vistos = [];

      do {
        let resposta;
        try {
          resposta = await calendario.listarPagina({
            syncToken,
            pageToken: pagina,
            ...(fullSync ? {
              timeMin: new Date(agora().getTime() - 30 * 24 * 60 * 60 * 1000),
              timeMax: new Date(agora().getTime() + Math.max(janelaDias, 365) * 24 * 60 * 60 * 1000),
            } : {}),
          });
        } catch (erro) {
          if (erro instanceof ErroDoGoogle && erro.cursorInvalido && tentativa === 1) {
            // 410: o cursor venceu. Marca, registra e refaz como full sync —
            // controlado, uma vez, sem pânico.
            await repositorioGoogle.marcarFullSyncDevido(nome, 'syncToken vencido (410)');
            return varrer({ fullSync: true }, tentativa + 1);
          }
          await repositorioGoogle.registrarErroDaSincronia(nome, erro?.message ?? String(erro));
          throw erro;
        }

        contagem.paginas += 1;
        for (const item of resposta.itens) {
          contagem.eventos += 1;
          vistos.push(item.id);
          const desfecho = await processarEvento(item, { origemDaVarredura: 'varredura' });
          if (desfecho.resultado === 'externo') contagem.externos += 1;
          if (desfecho.resultado === 'conflito') contagem.conflitos += 1;
          if (desfecho.resultado === 'ok') contagem.ok += 1;
        }

        pagina = resposta.proximaPagina;
        // O token novo só vale quando NÃO há próxima página — guardá-lo
        // antes perderia o resto da varredura numa queda de processo.
        if (!pagina) cursorFinal = resposta.proximoSyncToken;
      } while (pagina);

      if (cursorFinal) {
        await repositorioGoogle.gravarCursorDaSincronia(nome, { nextSyncToken: cursorFinal, fullSync });
      }
      if (fullSync) {
        // Quem não apareceu na janela inteira não existe mais no Google:
        // sai do mapa de externos para não bloquear horário fantasma.
        await repositorioGoogle.podarEventosExternosAusentes(nome, vistos);
        contagem.fullSync = true;
      }
    }

    if (estado.precisa_full_sync || !estado.next_sync_token) {
      await varrer({ fullSync: true });
    } else {
      await varrer({ syncToken: estado.next_sync_token });
    }

    return { sincronizado: true, ...contagem };
  }

  /**
   * Reconciliação agendada (P0-12): relê no Google os agendamentos
   * vinculados, mais antigos primeiro, e confirma que os dois lados contam a
   * mesma história. É a rede de segurança do incremental — webhooks e
   * syncToken podem perder eventos; uma leitura direta, não.
   */
  async function reconciliar({ limite = 200 } = {}) {
    if (!calendario?.configurada) return { reconciliado: false, motivo: 'google_nao_configurado' };

    const vinculados = await repositorioGoogle.listarVinculadosParaReconciliar({ limite });
    const contagem = { verificados: 0, iguais: 0, conflitos: 0, ausentes_no_google: 0 };

    for (const agendamento of vinculados) {
      contagem.verificados += 1;
      const lido = await calendario.obterEvento(agendamento.google_evento_id);

      if (!lido || lido.evento?.status === 'cancelled') {
        contagem.ausentes_no_google += 1;
        if (agendamento.status !== 'cancelado' && agendamento.sync_status !== 'pendente') {
          await repositorio.atualizarAgendamento(agendamento.id, { syncStatus: 'conflito' });
          await repositorioGoogle.registrarConflito({
            agendamentoId: agendamento.id,
            googleEventoId: agendamento.google_evento_id,
            tipo: 'cancelado_no_google',
            detalheCrm: { inicio: agendamento.inicio, fim: agendamento.fim, status: agendamento.status },
            detalheGoogle: lido?.evento ?? { ausente: true },
          });
          contagem.conflitos += 1;
        }
        continue;
      }

      const desfecho = await processarEvento(lido.evento, { origemDaVarredura: 'reconciliacao' });
      if (desfecho.resultado === 'conflito') contagem.conflitos += 1;
      if (desfecho.resultado === 'ok') contagem.iguais += 1;
    }

    return { reconciliado: true, ...contagem };
  }

  /**
   * Aplica a decisão da clínica num conflito aberto.
   *
   * - crm_vence: o estado do CRM é reimposto no Google pelo outbox — recria
   *   o evento se ele sumiu, atualiza se diverge, cancela se cancelado;
   * - google_vence: o CRM aceita o que está no Google (remarca ou cancela),
   *   com origem 'google' para a auditoria contar de onde veio;
   * - manual: só encerra o registro — a pessoa resolveu olhando os dois.
   */
  async function resolverConflito(conflitoId, { resolucao, usuarioId = null }) {
    const conflito = await repositorioGoogle.obterConflito(conflitoId);
    if (!conflito || conflito.estado !== 'aberto') return null;

    const agendamento = conflito.agendamento_id
      ? await repositorio.obterAgendamento(conflito.agendamento_id)
      : null;

    if (resolucao === 'crm_vence' && agendamento) {
      if (!outbox) {
        const erro = new Error('outbox indisponível para reimpor o CRM');
        erro.codigo = 'outbox_indisponivel';
        throw erro;
      }
      const operacao = agendamento.status === 'cancelado'
        ? 'cancelar'
        : (conflito.tipo === 'cancelado_no_google' || conflito.tipo === 'evento_sem_dono' ? 'criar' : 'atualizar');
      if (operacao === 'atualizar' || operacao === 'cancelar') {
        // O etag guardado é anterior à edição que abriu o conflito: mandar o
        // PATCH/DELETE com ele daria 412 e o conflito voltaria na hora. Relê
        // o evento e carimba o etag atual — se o Google mudar outra vez até
        // o worker rodar, o 412 reabre o conflito, como deve ser.
        try {
          const lido = await calendario.obterEvento(
            agendamento.google_evento_id ?? idDoEvento(agendamento.id),
          );
          if (lido?.etag) {
            await repositorio.atualizarAgendamento(agendamento.id, { googleEtag: lido.etag });
          }
        } catch {
          // Se a leitura falhar, o worker tenta com o etag que tem: o 412
          // vira conflito de novo e nada é sobrescrito às cegas.
        }
      }
      await outbox.registrarMudanca(agendamento.id, operacao, { usuarioId });
    }

    if (resolucao === 'google_vence' && agendamento) {
      const google = conflito.detalhe_google ?? {};
      if (conflito.tipo === 'cancelado_no_google') {
        await repositorio.atualizarAgendamento(agendamento.id, {
          status: 'cancelado',
          canceladoEm: agora().toISOString(),
          canceladoMotivo: 'cancelado no Google (conflito resolvido)',
          origemAlteracao: 'google',
          syncStatus: 'ok',
          lastSyncedAt: agora().toISOString(),
        });
      } else if (google.inicio && google.fim) {
        await repositorio.atualizarAgendamento(agendamento.id, {
          inicio: google.inicio,
          fim: google.fim,
          origemAlteracao: 'google',
          googleEtag: google.etag ?? agendamento.google_etag,
          syncStatus: 'ok',
          lastSyncedAt: agora().toISOString(),
        });
      }
    }

    return repositorioGoogle.resolverConflito(conflitoId, { resolucao, usuarioId });
  }

  /** Painel de saúde da sincronia (P2-04), já com a fila do outbox agregada. */
  async function saude() {
    const nome = nomeDoCalendario();
    const estado = await repositorioGoogle.obterEstadoDaSincronia(nome);
    const conflitos = await repositorioGoogle.listarConflitos({ estado: 'aberto', limite: 100 });
    const painel = {
      disponivel: Boolean(calendario?.configurada),
      calendario: nome,
      cursor: estado
        ? {
          tem_cursor: Boolean(estado.next_sync_token),
          precisa_full_sync: estado.precisa_full_sync === true,
          ultimo_full_sync_em: estado.ultimo_full_sync_em ?? null,
          ultimo_incremental_em: estado.ultimo_incremental_em ?? null,
          ultimo_erro: estado.ultimo_erro ?? null,
        }
        : null,
      conflitos_abertos: conflitos.length,
      conflitos,
      agendamentos: await repositorioGoogle.contarPorStatusDeSincronia(),
      // A fila do outbox é metade da história: sem ela o painel mostraria
      // agendamentos 'pendente' sem dizer se o worker está andando.
      outbox: outbox ? (await outbox.saude()).fila ?? null : null,
    };
    return painel;
  }

  return { sincronizar, reconciliar, resolverConflito, saude };
}

module.exports = { criarSincroniaGoogle };
