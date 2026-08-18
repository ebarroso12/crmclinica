'use strict';

const {
  MAX_TENTATIVAS_PADRAO, LEASE_MS, proximaTentativa, esgotou, decidirDesfecho,
} = require('./automacao-outbox');

// Serviço da outbox durável do atendimento automático.
//
// Amarra três coisas que sozinhas não bastam: a fila persistente
// (repositório), a decisão de backoff/dead-letter (domínio, em
// `automacao-outbox.js`) e o que de fato processa um trabalho — o
// `atendimento` que o Comando 2 já blindou com a barreira final.
//
// **Este serviço não reimplementa a barreira de controle.** `processarUm`
// chama `atendimento.responderSePossivel`, que já relê `podeResponder`
// imediatamente antes de qualquer envio (ver `src/dominio/atendimento.js`,
// `podeEntregarAgora`). Um trabalho reivindicado bem depois de a Serena ter
// sido desligada, pausada ou de a conversa ter sido assumida chega até aqui,
// mas não sai — a mesma barreira vale para o caminho síncrono e para este.

function criarServicoDeOutbox({
  repositorio, atendimento, agora = () => new Date(),
  maxTentativas = MAX_TENTATIVAS_PADRAO, leaseMs = LEASE_MS,
  // Achado do incidente de 2026-08-17: `null`/`0` desliga o limite (nunca
  // expira) — default seguro é o próprio `criarServicoDeOutbox` decidir,
  // não um valor mágico espalhado pelos chamadores. `bin/worker-outbox.js`
  // passa `configuracao.serena.idadeMaximaRespostaMs`.
  idadeMaximaRespostaMs = 30 * 60 * 1000,
} = {}) {
  if (!repositorio) throw new Error('serviço da outbox exige um repositório');
  if (!atendimento) throw new Error('serviço da outbox exige o atendimento');

  /** Auditoria nunca derruba o processamento: registrar é importante, mas não é o produto. */
  async function auditar(acao, trabalhoId, detalhe = null) {
    try {
      await repositorio.registrarAuditoria({
        entidade: 'automacao_outbox', entidadeId: trabalhoId, acao, detalhe,
      });
    } catch (erro) {
      console.error(`[outbox] falha ao auditar "${acao}": ${erro.message}`);
    }
  }

  /**
   * Enfileira o trabalho de responder a uma mensagem recebida.
   *
   * Idempotente por (conversa, mensagem de entrada) — chamar duas vezes para
   * o mesmo par não cria dois trabalhos; a constraint do banco resolve
   * (`chave_idempotencia`), e este serviço só audita quando de fato criou.
   */
  async function enfileirar({ conversaId, mensagemEntradaId }) {
    if (!conversaId) throw new Error('trabalho da outbox exige conversa_id');

    const chave = `outbox:${conversaId}:${mensagemEntradaId ?? 0}`;
    const { trabalho, criado } = await repositorio.enfileirarTrabalhoDeOutbox({
      conversaId, mensagemEntradaId, chaveIdempotencia: chave, maxTentativas,
    });

    if (criado) {
      await auditar('outbox_enfileirado', trabalho.id, { conversa_id: conversaId });
    }
    return { trabalho, criado };
  }

  /**
   * Devolve à fila o que ficou preso em 'processando' — o worker que morre
   * no meio de um envio deixa o trabalho reservado para sempre, sem isto.
   */
  async function recuperarPresos() {
    const momento = agora();
    const limite = new Date(momento.getTime() - leaseMs);

    const liberados = await repositorio.liberarTrabalhosDeOutboxPresos({
      antesDe: limite.toISOString(),
      agora: momento.toISOString(),
    });

    for (const trabalho of liberados) {
      if (trabalho.status === 'morto') {
        // Esgotou as tentativas sem que ninguém tivesse processado com
        // sucesso: o trabalho nunca chegou perto da barreira de controle do
        // `atendimento`, então a escalação humana é responsabilidade daqui.
        await atendimento.escalonar(trabalho.conversa_id, 'outbox_dead_letter').catch((erro) => {
          console.error(`[outbox] falha ao escalonar dead-letter (trabalho ${trabalho.id}): ${erro.message}`);
        });
      }
      await auditar(trabalho.status === 'morto' ? 'outbox_morto' : 'outbox_retentativa', trabalho.id, {
        motivo: 'processamento_abandonado', tentativas: trabalho.tentativas, conversa_id: trabalho.conversa_id,
      });
    }

    return liberados;
  }

  /**
   * Processa um trabalho reivindicado.
   *
   * Três desfechos possíveis, decididos por `decidirDesfecho` (domínio):
   *
   *   - **resolvido** — `responderSePossivel` terminou sem lançar, com
   *     qualquer ação válida (respondeu, silenciou, abortou por controle,
   *     escalonou). O trabalho está feito; concluído.
   *   - **incerto** — a entrega estourou o tempo sem confirmação. Nunca
   *     retentado automaticamente: `atendimento` já escalonou para a
   *     equipe (ver `entregarAoPaciente`/`responderSePossivel`).
   *   - **falha_transitoria** — algo lançou antes de `responderSePossivel`
   *     conseguir decidir qualquer coisa (o caso típico é o banco piscar bem
   *     na leitura da conversa, ANTES do trecho que o próprio atendimento já
   *     protege com try/catch). Backoff e nova tentativa; dead-letter com
   *     escalonamento humano ao esgotar.
   */
  /**
   * Achado do incidente de 2026-08-17: um trabalho pode esperar na fila por
   * horas (STOP prolongado, worker parado, fila represada) e ainda assim
   * ficar `pendente` — nada nele muda sozinho. Sem este limite, quando a
   * automação volta a responder, ela despacharia uma resposta gerada agora
   * para uma pergunta feita horas atrás, sem contexto nenhum de que o tempo
   * passou. Idade conta a partir de `criado_em` do TRABALHO — que nasce
   * junto com a mensagem de entrada, na mesma transação (ver
   * db/031_automacao_outbox.sql) — não de quando foi reivindicado.
   */
  function trabalhoExpirado(trabalho) {
    if (!idadeMaximaRespostaMs || !trabalho.criado_em) return false;
    const idadeMs = agora().getTime() - new Date(trabalho.criado_em).getTime();
    return idadeMs > idadeMaximaRespostaMs;
  }

  async function processarUm(trabalho) {
    if (trabalhoExpirado(trabalho)) {
      await atendimento.escalonar(trabalho.conversa_id, 'outbox_expirado_sem_resposta_automatica').catch((erroDeEscalonamento) => {
        console.error(`[outbox] falha ao escalonar trabalho expirado (${trabalho.id}): ${erroDeEscalonamento.message}`);
      });
      const marcado = await repositorio.concluirTrabalhoDeOutbox(trabalho.id, {
        status: 'concluido',
        ultimoErro: 'expirado_sem_resposta_automatica',
      });
      await auditar('outbox_expirado', trabalho.id, {
        conversa_id: trabalho.conversa_id, criado_em: trabalho.criado_em, limite_ms: idadeMaximaRespostaMs,
      });
      return { id: trabalho.id, status: 'concluido', acao: 'expirado_sem_resposta_automatica', trabalho: marcado };
    }

    let resultado = null;
    let erro = null;
    try {
      resultado = await atendimento.responderSePossivel(trabalho.conversa_id, {
        mensagemEntradaId: trabalho.mensagem_entrada_id,
      });
    } catch (excecao) {
      erro = excecao;
    }

    const desfecho = decidirDesfecho(resultado, erro);

    if (desfecho.desfecho === 'resolvido') {
      const marcado = await repositorio.concluirTrabalhoDeOutbox(trabalho.id, { status: 'concluido' });
      await auditar('outbox_concluido', trabalho.id, {
        conversa_id: trabalho.conversa_id, acao: desfecho.acao, motivo: desfecho.motivo,
      });
      return { id: trabalho.id, status: 'concluido', acao: desfecho.acao, trabalho: marcado };
    }

    if (desfecho.desfecho === 'incerto') {
      const marcado = await repositorio.concluirTrabalhoDeOutbox(trabalho.id, {
        status: 'incerto', ultimoErro: String(desfecho.motivo ?? '').slice(0, 500) || null,
      });
      await auditar('outbox_entrega_incerta', trabalho.id, { conversa_id: trabalho.conversa_id, motivo: desfecho.motivo });
      return { id: trabalho.id, status: 'incerto', motivo: desfecho.motivo, trabalho: marcado };
    }

    // falha_transitoria: backoff, ou dead-letter se esgotou.
    const tentativas = Number(trabalho.tentativas) + 1;
    const limite = Number(trabalho.max_tentativas) || maxTentativas;
    const definitivo = esgotou(tentativas, limite);

    const marcado = await repositorio.concluirTrabalhoDeOutbox(trabalho.id, {
      status: definitivo ? 'morto' : 'pendente',
      tentativas,
      disponivelEm: definitivo ? undefined : proximaTentativa(tentativas, { agora: agora() }).toISOString(),
      ultimoErro: String(desfecho.motivo ?? '').slice(0, 500) || null,
    });

    if (definitivo) {
      await atendimento.escalonar(trabalho.conversa_id, 'outbox_dead_letter').catch((erroDeEscalonamento) => {
        console.error(`[outbox] falha ao escalonar dead-letter (trabalho ${trabalho.id}): ${erroDeEscalonamento.message}`);
      });
    }

    await auditar(definitivo ? 'outbox_morto' : 'outbox_retentativa', trabalho.id, {
      conversa_id: trabalho.conversa_id, tentativas, definitivo,
    });

    return {
      id: trabalho.id, status: definitivo ? 'morto' : 'pendente', erro: desfecho.motivo, trabalho: marcado,
    };
  }

  /**
   * Uma passada da fila.
   *
   * `reivindicarTrabalhosDeOutbox` é a operação que impede duplicidade entre
   * workers: seleciona com `FOR UPDATE SKIP LOCKED` e já marca 'processando'
   * na mesma transação. Quem chega depois não enxerga o que o primeiro pegou.
   *
   * **Comando 7, segunda auditoria, achado N-9.** `reivindicarTrabalhosDeOutbox`
   * carimba `reivindicado_em` com um único instante para o LOTE inteiro, mas
   * o laço abaixo processa serialmente. Com um lote grande e trabalhos perto
   * do pior caso documentado (~75s, ver LEASE_MS em `automacao-outbox.js`),
   * o carimbo do lote todo pode vencer antes mesmo de o último trabalho
   * começar a ser processado — e uma varredura concorrente
   * (`recuperarPresos`, rodando em outro worker de verdade) devolveria esse
   * trabalho à fila enquanto ele ainda está em voo, abrindo a mesma janela
   * de duplicata que o M-1 original fechou para o caso de um trabalho só.
   *
   * Por isso, ANTES de processar cada trabalho individualmente, o lease
   * dele é renovado para "agora" — `renovarReivindicacaoDeOutbox` só grava
   * se o trabalho ainda está 'processando' e ainda pertence a ESTE worker;
   * se outro worker já o retomou (a corrida que a renovação normalmente
   * evita, mas que ainda pode acontecer bem no limite), ela devolve `null` e
   * este worker desiste do trabalho — processá-lo de qualquer jeito depois
   * de perder a posse seria exatamente a duplicata que se está evitando.
   */
  async function processarLote({ limite = 20, worker = 'worker' } = {}) {
    const momento = agora();

    const presos = await recuperarPresos();

    const reivindicados = await repositorio.reivindicarTrabalhosDeOutbox({
      agora: momento.toISOString(),
      limite,
      worker,
    });

    const resultados = [];
    for (const trabalho of reivindicados) {
      if (repositorio.renovarReivindicacaoDeOutbox) {
        const renovado = await repositorio.renovarReivindicacaoDeOutbox(trabalho.id, {
          worker, agora: agora().toISOString(),
        });
        if (!renovado) {
          // Outro worker já retomou este trabalho — não é mais nosso.
          await auditar('outbox_lease_perdido', trabalho.id, { conversa_id: trabalho.conversa_id, worker });
          continue;
        }
      }
      resultados.push(await processarUm(trabalho));
    }

    return {
      instante: momento.toISOString(),
      recuperados: presos.length,
      reivindicados: reivindicados.length,
      concluidos: resultados.filter((item) => item.status === 'concluido').length,
      reagendados: resultados.filter((item) => item.status === 'pendente').length,
      mortos: resultados.filter((item) => item.status === 'morto').length,
      incertos: resultados.filter((item) => item.status === 'incerto').length,
      resultados,
    };
  }

  async function resumo() {
    return repositorio.contarTrabalhosDeOutboxPorEstado();
  }

  return {
    enfileirar,
    recuperarPresos,
    processarUm,
    processarLote,
    resumo,
  };
}

module.exports = { criarServicoDeOutbox };
