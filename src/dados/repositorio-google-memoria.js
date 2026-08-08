'use strict';

// Versão em memória do repositório da sincronia Google — mesma interface,
// mesmas regras de estado, zero banco. É o que permite testar outbox,
// sincronia e reconciliação sem subir PostgreSQL.
//
// Os armazenamentos ficam expostos (`_outbox` e cia.) para os testes
// conferirem o que o PostgreSQL mostraria com um SELECT.

function criarRepositorioGoogleEmMemoria({ agora = () => new Date(), repositorio = null } = {}) {
  const outbox = new Map();
  const estadoDaSincronia = new Map();
  const externos = new Map(); // chave: `${calendario}:${googleEventoId}`
  const conflitos = new Map();
  let proximoId = 1;
  let proximoConflitoId = 1;

  return {
    // ------------------------------------------------------------ outbox

    async enfileirarNoOutbox({ agendamentoId, operacao, versao }) {
      const chave = `${agendamentoId}:${operacao}:${versao}`;
      const existente = [...outbox.values()].find((e) => e.chave_idempotencia === chave);
      if (existente) {
        // Só rearma entrada morta; uma viva (pendente/processando) é devolvida como está.
        if (['falhou', 'obsoleto', 'ok'].includes(existente.estado)) {
          Object.assign(existente, {
            estado: 'pendente', tentativas: 0, proximo_retry_em: agora().toISOString(),
            ultimo_erro: null, processando_desde: null,
          });
        }
        return existente;
      }
      const entrada = {
        id: proximoId++,
        agendamento_id: Number(agendamentoId),
        operacao,
        versao,
        chave_idempotencia: chave,
        estado: 'pendente',
        tentativas: 0,
        proximo_retry_em: agora().toISOString(),
        ultimo_erro: null,
        processando_desde: null,
        criado_em: agora().toISOString(),
        processado_em: null,
      };
      outbox.set(entrada.id, entrada);
      return entrada;
    },

    async reivindicarDoOutbox({ lote = 20, agora: instante }) {
      const limite = new Date(instante ?? agora()).toISOString();
      const elegiveis = [...outbox.values()]
        .filter((e) => e.estado === 'pendente' && (!e.proximo_retry_em || e.proximo_retry_em <= limite))
        .sort((a, b) => a.criado_em.localeCompare(b.criado_em))
        .slice(0, lote);
      for (const entrada of elegiveis) {
        entrada.estado = 'processando';
        entrada.processando_desde = limite;
        entrada.tentativas += 1;
      }
      return elegiveis;
    },

    async concluirDoOutbox(id) {
      const entrada = outbox.get(Number(id));
      if (!entrada) return;
      Object.assign(entrada, {
        estado: 'ok', processado_em: agora().toISOString(), processando_desde: null, ultimo_erro: null,
      });
    },

    async reagendarDoOutbox(id, { proximoRetryEm, erro }) {
      const entrada = outbox.get(Number(id));
      if (!entrada) return;
      Object.assign(entrada, {
        estado: 'pendente', proximo_retry_em: proximoRetryEm,
        ultimo_erro: String(erro ?? '').slice(0, 500), processando_desde: null,
      });
    },

    async falharDoOutbox(id, erro) {
      const entrada = outbox.get(Number(id));
      if (!entrada) return;
      Object.assign(entrada, {
        estado: 'falhou', ultimo_erro: String(erro ?? '').slice(0, 500), processando_desde: null,
      });
    },

    async tornarObsoletosDoOutbox(agendamentoId, versao) {
      for (const entrada of outbox.values()) {
        if (entrada.agendamento_id === Number(agendamentoId) && entrada.versao < versao
            && ['pendente', 'processando', 'falhou'].includes(entrada.estado)) {
          entrada.estado = 'obsoleto';
          entrada.processando_desde = null;
        }
      }
    },

    async resumirOutbox() {
      const dezMinutosAtras = agora().getTime() - 10 * 60 * 1000;
      const umDiaAtras = agora().getTime() - 24 * 60 * 60 * 1000;
      const todas = [...outbox.values()];
      return {
        pendentes: todas.filter((e) => e.estado === 'pendente').length,
        presas: todas.filter((e) => e.estado === 'processando'
          && e.processando_desde && new Date(e.processando_desde).getTime() < dezMinutosAtras).length,
        falhadas: todas.filter((e) => e.estado === 'falhou').length,
        ok_24h: todas.filter((e) => e.estado === 'ok'
          && e.processado_em && new Date(e.processado_em).getTime() > umDiaAtras).length,
      };
    },

    async listarFalhasDoOutbox({ limite = 50 } = {}) {
      return [...outbox.values()]
        .filter((e) => e.estado === 'falhou')
        .sort((a, b) => b.criado_em.localeCompare(a.criado_em))
        .slice(0, limite);
    },

    async reenfileirarDoOutbox(id) {
      const entrada = outbox.get(Number(id));
      if (!entrada || entrada.estado !== 'falhou') return false;
      Object.assign(entrada, {
        estado: 'pendente', tentativas: 0, proximo_retry_em: agora().toISOString(), processando_desde: null,
      });
      return true;
    },

    // ------------------------------------------------------------ cursor da sincronia

    async obterEstadoDaSincronia(calendario) {
      return estadoDaSincronia.get(calendario) ?? null;
    },

    async garantirEstadoDaSincronia(calendario) {
      if (!estadoDaSincronia.has(calendario)) {
        estadoDaSincronia.set(calendario, {
          id: 1,
          calendario,
          next_sync_token: null,
          precisa_full_sync: true,
          ultimo_full_sync_em: null,
          ultimo_incremental_em: null,
          ultimo_erro: null,
          criado_em: agora().toISOString(),
          atualizado_em: agora().toISOString(),
        });
      }
      return estadoDaSincronia.get(calendario);
    },

    async gravarCursorDaSincronia(calendario, { nextSyncToken, fullSync = false }) {
      const estado = await this.garantirEstadoDaSincronia(calendario);
      estado.next_sync_token = nextSyncToken;
      estado.precisa_full_sync = false;
      estado.ultimo_erro = null;
      const instante = agora().toISOString();
      if (fullSync) estado.ultimo_full_sync_em = instante;
      else estado.ultimo_incremental_em = instante;
      estado.atualizado_em = instante;
    },

    async marcarFullSyncDevido(calendario, erro = null) {
      const estado = await this.garantirEstadoDaSincronia(calendario);
      estado.precisa_full_sync = true;
      estado.next_sync_token = null;
      estado.ultimo_erro = erro ? String(erro).slice(0, 500) : null;
      estado.atualizado_em = agora().toISOString();
    },

    async registrarErroDaSincronia(calendario, erro) {
      const estado = await this.garantirEstadoDaSincronia(calendario);
      estado.ultimo_erro = String(erro ?? '').slice(0, 500);
      estado.atualizado_em = agora().toISOString();
    },

    // ------------------------------------------------------------ sombra de eventos externos

    async upsertEventoExterno({ calendario, googleEventoId, status, inicio, fim, etag, titulo, atualizadoNoGoogleEm }) {
      externos.set(`${calendario}:${googleEventoId}`, {
        id: externos.size + 1,
        calendario,
        google_evento_id: googleEventoId,
        status,
        inicio,
        fim,
        etag,
        titulo,
        atualizado_no_google_em: atualizadoNoGoogleEm,
        visto_em: agora().toISOString(),
      });
    },

    async listarEventosExternos({ calendario, de = null, ate = null } = {}) {
      return [...externos.values()]
        .filter((e) => e.calendario === calendario && e.status === 'confirmado')
        .filter((e) => !de || (e.fim ?? '') >= de)
        .filter((e) => !ate || (e.inicio ?? '') <= ate)
        .sort((a, b) => (a.inicio ?? '').localeCompare(b.inicio ?? ''));
    },

    async podarEventosExternosAusentes(calendario, idsVistos) {
      for (const [chave, evento] of externos) {
        if (evento.calendario === calendario && !idsVistos.includes(evento.google_evento_id)) {
          externos.delete(chave);
        }
      }
    },

    // ------------------------------------------------------------ conflitos

    async registrarConflito({ agendamentoId = null, googleEventoId = null, tipo, detalheCrm = null, detalheGoogle = null }) {
      // O índice único parcial do PostgreSQL vira esta busca: mesmo aberto é refresh.
      const existente = [...conflitos.values()].find((c) => c.estado === 'aberto'
        && c.agendamento_id === agendamentoId && c.google_evento_id === googleEventoId && c.tipo === tipo);
      if (existente) {
        existente.detalhe_crm = detalheCrm;
        existente.detalhe_google = detalheGoogle;
        return existente;
      }
      const conflito = {
        id: proximoConflitoId++,
        agendamento_id: agendamentoId,
        google_evento_id: googleEventoId,
        tipo,
        detalhe_crm: detalheCrm,
        detalhe_google: detalheGoogle,
        estado: 'aberto',
        resolucao: null,
        resolvido_por: null,
        resolvido_em: null,
        criado_em: agora().toISOString(),
      };
      conflitos.set(conflito.id, conflito);
      return conflito;
    },

    async listarConflitos({ estado = 'aberto', limite = 50 } = {}) {
      return [...conflitos.values()]
        .filter((c) => c.estado === estado)
        .sort((a, b) => b.criado_em.localeCompare(a.criado_em))
        .slice(0, limite);
    },

    async obterConflito(id) {
      return conflitos.get(Number(id)) ?? null;
    },

    async resolverConflito(id, { resolucao, usuarioId = null }) {
      const conflito = conflitos.get(Number(id));
      if (!conflito || conflito.estado !== 'aberto') return null;
      conflito.estado = 'resolvido';
      conflito.resolucao = resolucao;
      conflito.resolvido_por = usuarioId;
      conflito.resolvido_em = agora().toISOString();
      return conflito;
    },

    // ------------------------------------------------------------ contagens para o painel

    async contarPorStatusDeSincronia() {
      // O agendamento mora no repositório principal: a contagem lê o
      // armazenamento dele, como o SELECT leria a tabela.
      const porStatus = { ok: 0, pendente: 0, falhou: 0, conflito: 0 };
      for (const agendamento of repositorio?._interno?.agendamentos ?? []) {
        const status = agendamento.sync_status ?? 'ok';
        porStatus[status] = (porStatus[status] ?? 0) + 1;
      }
      return porStatus;
    },

    async listarVinculadosParaReconciliar({ limite = 200 } = {}) {
      return (repositorio?._interno?.agendamentos ?? [])
        .filter((a) => a.google_evento_id)
        .sort((a, b) => (a.last_synced_at ?? '').localeCompare(b.last_synced_at ?? ''))
        .slice(0, limite);
    },

    // Espelhos de teste: o que um SELECT mostraria.
    _outbox: outbox,
    _externos: externos,
    _conflitos: conflitos,
    _estado: estadoDaSincronia,
  };
}

module.exports = { criarRepositorioGoogleEmMemoria };
