'use strict';

// Repositório das tabelas da sincronia com o Google (migrações 021 e 022).
//
// Módulo irmão de `repositorio.js`, não parte dele: a missão pede mudanças
// mínimas no repositório principal. O que faz as consultas daqui entrarem na
// transação da requisição é o contexto compartilhado (`contexto.atual()`) —
// a MESMA conexão ambiente que `repositorio.js` usa. É assim que a intenção
// do outbox nasce na mesma transação do agendamento, sem costura no HTTP.
//
// O driver `pg` recusa consultas concorrentes na mesma conexão: por isso a
// serialização por cliente (`filasPorCliente`), espelhando a do repositório
// principal.

const { contexto } = require('./contexto');

const filasPorCliente = new WeakMap();

function criarRepositorioGoogle(pool) {
  function consultar(texto, parametros = []) {
    const cliente = contexto.atual()?.client ?? pool;
    if (!cliente) return Promise.reject(new Error('pool indisponível'));
    const filaAnterior = filasPorCliente.get(cliente) ?? Promise.resolve();
    const execucao = filaAnterior.then(() => cliente.query(texto, parametros));
    filasPorCliente.set(cliente, execucao.catch(() => {}));
    return execucao;
  }

  return {
    // ------------------------------------------------------------ outbox

    /**
     * Enfileira a intenção. A chave de idempotência torna o gesto repetível:
     * a mesma (agendamento, operação, versão) não empilha entrada nova — uma
     * entrada morta (falhou/obsoleta/ok) é rearmada, uma viva é devolvida.
     */
    async enfileirarNoOutbox({ agendamentoId, operacao, versao }) {
      const chave = `${agendamentoId}:${operacao}:${versao}`;
      const { rows } = await consultar(
        `INSERT INTO google_outbox (agendamento_id, operacao, versao, chave_idempotencia, proximo_retry_em)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (chave_idempotencia) DO UPDATE SET
           estado = 'pendente', tentativas = 0, proximo_retry_em = now(),
           ultimo_erro = NULL, processando_desde = NULL
           WHERE google_outbox.estado IN ('falhou', 'obsoleto', 'ok')
         RETURNING *`,
        [agendamentoId, operacao, versao, chave],
      );
      return rows[0] ?? null;
    },

    /**
     * Reivindica um lote para processar. `FOR UPDATE SKIP LOCKED`: duas
     * cópias do worker dividem o lote em vez de disputar a mesma linha.
     * Entrada presa em 'processando' há mais de 10 minutos denuncia worker
     * morto no meio do lote — ela volta para a fila.
     */
    async reivindicarDoOutbox({ lote = 20, agora }) {
      const { rows } = await consultar(
        `WITH proximas AS (
           SELECT id FROM google_outbox
           WHERE estado = 'pendente' AND (proximo_retry_em IS NULL OR proximo_retry_em <= $2)
           ORDER BY criado_em
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE google_outbox o
         SET estado = 'processando', processando_desde = $2, tentativas = o.tentativas + 1
         FROM proximas
         WHERE o.id = proximas.id
         RETURNING o.*`,
        [lote, agora],
      );
      return rows;
    },

    /** Entrada cumprida: sai da fila com carimbo. */
    async concluirDoOutbox(id) {
      await consultar(
        `UPDATE google_outbox
         SET estado = 'ok', processado_em = now(), processando_desde = NULL, ultimo_erro = NULL
         WHERE id = $1`,
        [id],
      );
    },

    /** Falha transitória: volta para a fila com o próximo horário de retry. */
    async reagendarDoOutbox(id, { proximoRetryEm, erro }) {
      await consultar(
        `UPDATE google_outbox
         SET estado = 'pendente', proximo_retry_em = $2, ultimo_erro = $3, processando_desde = NULL
         WHERE id = $1`,
        [id, proximoRetryEm, String(erro ?? '').slice(0, 500)],
      );
    },

    /** Esgotou as tentativas (ou é 412): sai da fila e fica visível no painel. */
    async falharDoOutbox(id, erro) {
      await consultar(
        `UPDATE google_outbox
         SET estado = 'falhou', ultimo_erro = $2, processando_desde = NULL
         WHERE id = $1`,
        [id, String(erro ?? '').slice(0, 500)],
      );
    },

    /** Mudança mais nova enfileirada: as antigas viram passado. */
    async tornarObsoletosDoOutbox(agendamentoId, versao) {
      await consultar(
        `UPDATE google_outbox
         SET estado = 'obsoleto', processando_desde = NULL
         WHERE agendamento_id = $1 AND versao < $2 AND estado IN ('pendente', 'processando', 'falhou')`,
        [agendamentoId, versao],
      );
    },

    /** O resumo que o painel de saúde mostra. */
    async resumirOutbox() {
      const { rows } = await consultar(
        `SELECT
           count(*) FILTER (WHERE estado = 'pendente') AS pendentes,
           count(*) FILTER (WHERE estado = 'processando' AND processando_desde < now() - interval '10 minutes') AS presas,
           count(*) FILTER (WHERE estado = 'falhou') AS falhadas,
           count(*) FILTER (WHERE estado = 'ok' AND processado_em > now() - interval '24 hours') AS ok_24h
         FROM google_outbox`,
      );
      const linha = rows[0] ?? {};
      return {
        pendentes: Number(linha.pendentes ?? 0),
        presas: Number(linha.presas ?? 0),
        falhadas: Number(linha.falhadas ?? 0),
        ok_24h: Number(linha.ok_24h ?? 0),
      };
    },

    async listarFalhasDoOutbox({ limite = 50 } = {}) {
      const { rows } = await consultar(
        `SELECT * FROM google_outbox WHERE estado = 'falhou' ORDER BY criado_em DESC LIMIT $1`,
        [limite],
      );
      return rows;
    },

    /** Reenfileiramento manual pelo painel: a falha ganha mais uma chance. */
    async reenfileirarDoOutbox(id) {
      const { rows } = await consultar(
        `UPDATE google_outbox
         SET estado = 'pendente', tentativas = 0, proximo_retry_em = now(), processando_desde = NULL
         WHERE id = $1 AND estado = 'falhou'
         RETURNING id`,
        [id],
      );
      return Boolean(rows[0]);
    },

    // ------------------------------------------------------------ cursor da sincronia

    async obterEstadoDaSincronia(calendario) {
      const { rows } = await consultar(
        'SELECT * FROM google_sincronia_estado WHERE calendario = $1',
        [calendario],
      );
      return rows[0] ?? null;
    },

    /** A linha do calendário existe antes da primeira leitura. */
    async garantirEstadoDaSincronia(calendario) {
      await consultar(
        `INSERT INTO google_sincronia_estado (calendario) VALUES ($1)
         ON CONFLICT (calendario) DO NOTHING`,
        [calendario],
      );
      return this.obterEstadoDaSincronia(calendario);
    },

    /**
     * O cursor só anda aqui, depois da última página. Gravar no meio da
     * paginação perderia as páginas restantes num crash — e o Google não
     * devolve duas vezes o que o cursor já passou.
     */
    async gravarCursorDaSincronia(calendario, { nextSyncToken, fullSync = false }) {
      await consultar(
        `UPDATE google_sincronia_estado
         SET next_sync_token = $2,
             precisa_full_sync = false,
             ultimo_erro = NULL,
             ultimo_full_sync_em = CASE WHEN $3 THEN now() ELSE ultimo_full_sync_em END,
             ultimo_incremental_em = CASE WHEN $3 THEN ultimo_incremental_em ELSE now() END,
             atualizado_em = now()
         WHERE calendario = $1`,
        [calendario, nextSyncToken, fullSync],
      );
    },

    /** 410 do Google: o cursor morreu, a próxima leitura é full sync. */
    async marcarFullSyncDevido(calendario, erro = null) {
      await consultar(
        `UPDATE google_sincronia_estado
         SET precisa_full_sync = true, next_sync_token = NULL, ultimo_erro = $2, atualizado_em = now()
         WHERE calendario = $1`,
        [calendario, erro ? String(erro).slice(0, 500) : null],
      );
    },

    async registrarErroDaSincronia(calendario, erro) {
      await consultar(
        `UPDATE google_sincronia_estado
         SET ultimo_erro = $2, atualizado_em = now()
         WHERE calendario = $1`,
        [calendario, String(erro ?? '').slice(0, 500)],
      );
    },

    // ------------------------------------------------------------ sombra de eventos externos

    async upsertEventoExterno({ calendario, googleEventoId, status, inicio, fim, etag, titulo, atualizadoNoGoogleEm }) {
      await consultar(
        `INSERT INTO google_eventos_externos
           (calendario, google_evento_id, status, inicio, fim, etag, titulo, atualizado_no_google_em, visto_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (calendario, google_evento_id) DO UPDATE SET
           status = EXCLUDED.status,
           inicio = EXCLUDED.inicio,
           fim = EXCLUDED.fim,
           etag = EXCLUDED.etag,
           titulo = EXCLUDED.titulo,
           atualizado_no_google_em = EXCLUDED.atualizado_no_google_em,
           visto_em = now()`,
        [calendario, googleEventoId, status, inicio, fim, etag, titulo, atualizadoNoGoogleEm],
      );
    },

    async listarEventosExternos({ calendario, de = null, ate = null } = {}) {
      const { rows } = await consultar(
        `SELECT * FROM google_eventos_externos
         WHERE calendario = $1 AND status = 'confirmado'
           AND ($2::timestamptz IS NULL OR fim >= $2)
           AND ($3::timestamptz IS NULL OR inicio <= $3)
         ORDER BY inicio`,
        [calendario, de, ate],
      );
      return rows;
    },

    /**
     * Full sync: sombra que não apareceu na janela some. O Google é a fonte
     * do lado de lá; a sombra que ele não devolveu não existe mais.
     */
    async podarEventosExternosAusentes(calendario, idsVistos) {
      await consultar(
        `DELETE FROM google_eventos_externos
         WHERE calendario = $1 AND NOT (google_evento_id = ANY($2::text[]))`,
        [calendario, idsVistos.length > 0 ? idsVistos : ['']],
      );
    },

    // ------------------------------------------------------------ conflitos

    /**
     * Registra (ou refresca) um conflito aberto. O índice único parcial faz a
     * reconciliação poder rodar toda hora sem empilhar cópia do mesmo problema.
     */
    async registrarConflito({ agendamentoId = null, googleEventoId = null, tipo, detalheCrm = null, detalheGoogle = null }) {
      const { rows } = await consultar(
        `INSERT INTO google_sincronia_conflitos
           (agendamento_id, google_evento_id, tipo, detalhe_crm, detalhe_google)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agendamento_id, google_evento_id, tipo) WHERE estado = 'aberto'
         DO UPDATE SET detalhe_crm = EXCLUDED.detalhe_crm, detalhe_google = EXCLUDED.detalhe_google
         RETURNING *`,
        [agendamentoId, googleEventoId, tipo,
          detalheCrm ? JSON.stringify(detalheCrm) : null,
          detalheGoogle ? JSON.stringify(detalheGoogle) : null],
      );
      return rows[0] ?? null;
    },

    async listarConflitos({ estado = 'aberto', limite = 50 } = {}) {
      const { rows } = await consultar(
        `SELECT * FROM google_sincronia_conflitos WHERE estado = $1 ORDER BY criado_em DESC LIMIT $2`,
        [estado, limite],
      );
      return rows;
    },

    async obterConflito(id) {
      const { rows } = await consultar(
        'SELECT * FROM google_sincronia_conflitos WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },

    async resolverConflito(id, { resolucao, usuarioId = null }) {
      const { rows } = await consultar(
        `UPDATE google_sincronia_conflitos
         SET estado = 'resolvido', resolucao = $2, resolvido_por = $3, resolvido_em = now()
         WHERE id = $1 AND estado = 'aberto'
         RETURNING *`,
        [id, resolucao, usuarioId],
      );
      return rows[0] ?? null;
    },

    // ------------------------------------------------------------ contagens para o painel

    async contarPorStatusDeSincronia() {
      const { rows } = await consultar(
        `SELECT sync_status, count(*) AS total FROM agendamentos GROUP BY sync_status`,
      );
      const porStatus = { ok: 0, pendente: 0, falhou: 0, conflito: 0 };
      for (const linha of rows) porStatus[linha.sync_status] = Number(linha.total);
      return porStatus;
    },

    /** Os vínculos que a reconciliação confere, do mais tempo sem sincronizar. */
    async listarVinculadosParaReconciliar({ limite = 200 } = {}) {
      const { rows } = await consultar(
        `SELECT id, google_evento_id, google_calendar_id, google_etag, sync_status, sync_version,
                inicio, fim, status, last_synced_at, origem_alteracao
         FROM agendamentos
         WHERE google_evento_id IS NOT NULL
         ORDER BY last_synced_at NULLS FIRST
         LIMIT $1`,
        [limite],
      );
      return rows;
    },
  };
}

module.exports = { criarRepositorioGoogle };
