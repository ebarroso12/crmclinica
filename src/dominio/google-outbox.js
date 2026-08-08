'use strict';

// Outbox transacional do Google Calendar (P0-09 e P0-10).
//
// O problema que este módulo resolve: gravar a consulta no banco e criar o
// evento no Google são duas escritas em dois sistemas, e não existe transação
// que abranja as duas. Se o request marcasse a consulta E chamasse o Google
// na sequência, uma queda entre as duas chamadas deixaria a consulta marcada
// sem evento — e uma falha do Google derrubaria um agendamento que já estava
// certo no banco.
//
// A solução é a de sempre: a escrita local e a intenção de escrever fora
// vivem na MESMA transação. `registrarMudanca` é chamada pelo serviço de
// agenda ainda dentro da transação do request (o repositório-google usa a
// conexão ambiente); o worker (`bin/worker-google-outbox.js`) processa a fila
// depois, com retry idempotente, e cada item só sai da fila quando o Google
// confirmou.
//
// Garantias:
//   - idempotência: a chave (agendamento, operação, versão) é única; repetir
//     o processamento não duplica evento porque a criação usa id
//     determinístico (409 = já existe = sucesso);
//   - edição concorrente: PATCH/DELETE levam o ETag que conhecemos; 412 vira
//     conflito registrado para resolução humana, nunca sobrescrita cega;
//   - obsolescência: uma versão nova da mesma consulta aposenta os itens
//     antigos da fila — o Google recebe só o estado final, não a novela.

const { ErroDoGoogle, idDoEvento } = require('../integracoes/google-calendario');

const BACKOFF_BASE_MS = 30_000; // 30 s: falha transitória comum resolve rápido
const BACKOFF_MAX_MS = 30 * 60_000; // 30 min de teto: quota do Google pede calma

function criarOutboxGoogle({
  repositorio,
  repositorioGoogle,
  calendario,
  clinica = null,
  maxTentativas = 8,
  agora = () => new Date(),
}) {
  function proximoRetryEm(tentativas) {
    const exponencial = BACKOFF_BASE_MS * (2 ** Math.max(0, tentativas - 1));
    // Jitter de até 20%: sem ele, uma rajada de falhas simultâneas volta
    // inteira ao mesmo tempo e derruba o Google de novo — a tempestade de
    // retry clássica.
    const jitter = Math.floor(Math.random() * exponencial * 0.2);
    // ISO, não Date: os repositórios comparam com texto, e um Date solto
    // viraria comparação de strings sem sentido no repositório em memória.
    return new Date(agora().getTime() + Math.min(exponencial + jitter, BACKOFF_MAX_MS)).toISOString();
  }

  /**
   * Grava a intenção de sincronizar, na mesma transação da mudança.
   *
   * A versão local (`sync_version`) sobe a cada mudança: é ela que torna a
   * chave de idempotência única por mudança e que aposenta itens velhos da
   * fila. Chamar isto fora da transação do request quebraria a garantia
   * central do outbox — por isso o serviço de agenda chama antes do commit.
   */
  async function registrarMudanca(agendamentoId, operacao, { usuarioId = null } = {}) {
    const agendamento = await repositorio.obterAgendamento(agendamentoId);
    if (!agendamento) return null;

    const versao = (agendamento.sync_version ?? 0) + 1;
    await repositorio.atualizarAgendamento(agendamentoId, {
      syncVersion: versao,
      syncStatus: 'pendente',
      origemAlteracao: 'crm',
      lastSyncError: null,
    });

    // Itens de versões anteriores ainda na fila viram 'obsoleto': o Google
    // não precisa saber que a consulta foi das 10h às 11h se agora é às 14h.
    await repositorioGoogle.tornarObsoletosDoOutbox(agendamentoId, versao);

    return repositorioGoogle.enfileirarNoOutbox({ agendamentoId, operacao, versao });
  }

  async function carregarContexto(agendamento) {
    const contato = agendamento?.contato_id
      ? await repositorio.obterContato(agendamento.contato_id)
      : null;
    return { agendamento, contato, clinica };
  }

  /**
   * Cria com id determinístico; 409 significa "já existe" — e então o PATCH
   * garante que o conteúdo bate com o CRM. Repetir mil vezes dá o mesmo
   * resultado, que é a definição de idempotente.
   */
  async function executarCriacao(agendamento, contexto) {
    try {
      return await calendario.criarEvento(contexto);
    } catch (erro) {
      if (!(erro instanceof ErroDoGoogle && erro.conflito)) throw erro;
      const atualizacao = await calendario.atualizarEvento(idDoEvento(agendamento.id), contexto);
      return { ...atualizacao, recriado: true };
    }
  }

  async function executarAtualizacao(agendamento, contexto) {
    const eventoId = agendamento.google_evento_id ?? idDoEvento(agendamento.id);
    try {
      return await calendario.atualizarEvento(eventoId, {
        ...contexto,
        etag: agendamento.google_etag ?? null,
      });
    } catch (erro) {
      // O evento sumiu do Google (apagado à mão): recriar é o comportamento
      // certo — a consulta existe e precisa aparecer no calendário.
      if (erro instanceof ErroDoGoogle && erro.naoEncontrado) {
        const criacao = await executarCriacao(agendamento, contexto);
        return { ...criacao, recriado: true };
      }
      throw erro;
    }
  }

  async function processarItem(item) {
    const agendamento = await repositorio.obterAgendamento(item.agendamento_id);

    // A consulta mudou de novo depois que este item entrou na fila: ele não
    // tem mais o que fazer — a versão nova já está enfileirada.
    if (!agendamento || (agendamento.sync_version ?? 0) > item.versao) {
      await repositorioGoogle.concluirDoOutbox(item.id);
      return { item: item.id, resultado: 'obsoleto' };
    }

    const contexto = await carregarContexto(agendamento);

    let resultado;
    if (item.operacao === 'cancelar') {
      const eventoId = agendamento.google_evento_id ?? idDoEvento(agendamento.id);
      await calendario.removerEvento(eventoId, { etag: agendamento.google_etag ?? null });
      resultado = { eventoId, etag: null };
    } else if (item.operacao === 'criar' || !agendamento.google_evento_id) {
      resultado = await executarCriacao(agendamento, contexto);
    } else {
      resultado = await executarAtualizacao(agendamento, contexto);
    }

    await repositorio.atualizarAgendamento(agendamento.id, {
      google_evento_id: resultado.eventoId ?? agendamento.google_evento_id,
      googleCalendarId: calendario.calendario ?? null,
      googleEtag: resultado.etag ?? null,
      syncStatus: 'ok',
      lastSyncedAt: agora().toISOString(),
      lastSyncError: null,
    });
    await repositorioGoogle.concluirDoOutbox(item.id);
    return { item: item.id, resultado: 'ok', eventoId: resultado.eventoId };
  }

  /**
   * Processa até `lote` itens devidos da fila.
   *
   * Cada item é independente: a falha de um não contamina os outros, e o
   * SKIP LOCKED no repositório permite rodar mais de um worker sem que dois
   * processem o mesmo item.
   */
  async function processarLote({ lote = 20 } = {}) {
    if (!calendario?.configurada) return { processados: 0, motivo: 'google_nao_configurado' };

    const itens = await repositorioGoogle.reivindicarDoOutbox({ lote, agora: agora() });
    const resultados = [];

    for (const item of itens) {
      try {
        resultados.push(await processarItem(item));
      } catch (erro) {
        // 412 = alguém editou o evento direto no Google depois da nossa
        // última leitura. Não é falha transitória: insistir repetiria o 412
        // até esgotar as tentativas. O certo é marcar o agendamento como
        // conflito e deixar a decisão com a clínica (P0-12).
        if (erro instanceof ErroDoGoogle && erro.precondicao) {
          await repositorio.atualizarAgendamento(item.agendamento_id, {
            syncStatus: 'conflito',
            lastSyncError: 'edição concorrente no Google (ETag divergente)',
          });
          const agendamento = await repositorio.obterAgendamento(item.agendamento_id);
          await repositorioGoogle.registrarConflito({
            agendamentoId: item.agendamento_id,
            googleEventoId: agendamento?.google_evento_id ?? idDoEvento(item.agendamento_id),
            tipo: 'edicao_concorrente',
            detalheCrm: agendamento
              ? { inicio: agendamento.inicio, fim: agendamento.fim, etag: agendamento.google_etag }
              : null,
            detalheGoogle: null,
          });
          await repositorioGoogle.concluirDoOutbox(item.id);
          resultados.push({ item: item.id, resultado: 'conflito' });
          continue;
        }

        const mensagem = erro?.message ?? String(erro);
        if (item.tentativas >= maxTentativas) {
          await repositorioGoogle.falharDoOutbox(item.id, mensagem);
          await repositorio.atualizarAgendamento(item.agendamento_id, {
            syncStatus: 'falhou',
            lastSyncError: mensagem,
          });
          resultados.push({ item: item.id, resultado: 'falhou', erro: mensagem });
        } else {
          await repositorioGoogle.reagendarDoOutbox(item.id, {
            erro: mensagem,
            proximoRetryEm: proximoRetryEm(item.tentativas),
          });
          resultados.push({ item: item.id, resultado: 'reagendado', erro: mensagem });
        }
      }
    }

    return { processados: itens.length, resultados };
  }

  /** Painel de saúde (P2-04): fila + estado dos agendamentos. */
  async function saude() {
    return {
      disponivel: Boolean(calendario?.configurada),
      fila: await repositorioGoogle.resumirOutbox(),
      agendamentos: await repositorioGoogle.contarPorStatusDeSincronia(),
    };
  }

  return { registrarMudanca, processarLote, saude };
}

module.exports = { criarOutboxGoogle, BACKOFF_BASE_MS, BACKOFF_MAX_MS };
