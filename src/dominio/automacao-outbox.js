'use strict';

// Regras da outbox de automação: o trabalho pendente que substitui o
// `setImmediate` como garantia de que uma mensagem aceita pelo webhook
// realmente é processada.
//
// Este arquivo é puro, no mesmo espírito de `lembretes.js`: recebe dados,
// devolve decisão. Não fala com banco, não fala com rede.
//
// Backoff e lease são mais curtos que os dos lembretes de propósito — um
// lembrete de 24h pode esperar uma hora entre tentativas sem que ninguém
// perceba; um paciente que acabou de escrever no WhatsApp está esperando
// AGORA, e uma falha transitória (rede, IA, banco) precisa de uma
// retentativa em segundos, não em minutos.

const BACKOFF_BASE_MS = 5 * 1000;
const BACKOFF_TETO_MS = 2 * 60 * 1000;
const MAX_TENTATIVAS_PADRAO = 5;

// Tempo que um trabalho pode ficar em 'processando' antes de ser considerado
// abandonado por um worker morto.
//
// Precisa ser maior que qualquer tentativa plausível de `responderSePossivel`:
// extração de qualificação (IA, até IA_TIMEOUT_MS), despacho ao orquestrador
// (até o timeout do gateway do orquestrador) e entrega pela Evolution (até
// EVOLUTION_API_TIMEOUT_MS). Com os padrões de hoje (30s + 30s + 15s), isso
// soma ~75s — mas essas três chamadas remotas não são a viagem inteira: há
// leitura/gravação no banco entre elas, sem timeout nenhum contabilizado aí.
//
// Comando 7, achado M-1 da auditoria: o valor antigo (2min) dava só ~1.6x de
// margem sobre esses 75s, e — mais importante — LEASE_MS é uma constante
// FIXA deste arquivo: não acompanha automaticamente se alguém configurar
// IA_TIMEOUT_MS, o timeout do gateway do orquestrador ou
// EVOLUTION_API_TIMEOUT_MS mais alto via env. Margem fina demais aqui é o
// que causa o pior cenário possível: reivindicar de novo um trabalho que só
// está demorando (não morto), dois workers tentando entregar a MESMA
// resposta ao mesmo tempo — ver o aviso em evolution-envio.js sobre a
// Evolution não ter idempotência nativa no endpoint de envio; a única defesa
// real contra essa duplicata é não reivindicar cedo demais.
//
// 5 minutos, no mesmo valor já usado pelo lease análogo de `lembretes.js` —
// dá margem de ~4x sobre o pior caso documentado, sem deixar um trabalho
// preso por muito mais tempo que o necessário enquanto o paciente espera.
//
// Comando 7, segunda auditoria, achado N-9: a conta de "~4x" só é verdadeira
// POR TRABALHO — e até a correção do N-9, o lease era efetivamente por LOTE:
// `reivindicarTrabalhosDeOutbox` carimba `reivindicado_em` uma vez só para
// o lote inteiro (`repositorio.js`), mas `automacao-outbox-servico.js`
// processa o lote serialmente. Num lote grande, a soma do tempo de
// processamento dos trabalhos anteriores comia a margem do trabalho
// seguinte, na prática deixando uma margem real de ~0,2x no pior caso — bem
// menor do que esta constante sozinha sugeria. `processarLote` agora renova
// `reivindicado_em` de CADA trabalho no início do seu próprio processamento
// (`repositorio.renovarReivindicacaoDeOutbox`), então o lease voltou a ser
// por trabalho de verdade, e a conta de ~4x acima volta a valer.
const LEASE_MS = 5 * 60 * 1000;

// Cinco estados, no mesmo espírito de `lembretes.js`: uma falha que ainda pode
// tentar de novo volta para 'pendente' (com `disponivel_em` no futuro) — não
// existe um estado à parte para "falhando"; a contagem de tentativas > 0 já
// diz isso a quem quiser saber.
const ESTADOS = Object.freeze(['pendente', 'processando', 'concluido', 'morto', 'incerto']);

/**
 * Backoff exponencial com teto — igual em espírito ao dos lembretes
 * (`proximaTentativa` em lembretes.js), só que com base e teto bem menores.
 */
function proximaTentativa(tentativas, { agora = new Date(), baseMs = BACKOFF_BASE_MS, tetoMs = BACKOFF_TETO_MS } = {}) {
  const expoente = Math.max(0, Number(tentativas) - 1);
  const atraso = Math.min(baseMs * 2 ** expoente, tetoMs);
  return new Date(agora.getTime() + atraso);
}

/** Esgotou as tentativas? Então o desfecho é dead-letter ('morto'), não nova espera. */
function esgotou(tentativas, maxTentativas = MAX_TENTATIVAS_PADRAO) {
  return Number(tentativas) >= Number(maxTentativas);
}

/** Um trabalho em 'processando' há tempo demais foi abandonado por um worker morto. */
function abandonado(trabalho, { agora = new Date(), leaseMs = LEASE_MS } = {}) {
  if (trabalho.status !== 'processando' || !trabalho.reivindicado_em) return false;
  return agora.getTime() - new Date(trabalho.reivindicado_em).getTime() > leaseMs;
}

/**
 * Traduz o desfecho de `atendimento.responderSePossivel` para o que a outbox
 * deve fazer com o trabalho.
 *
 * Três famílias de resultado:
 *
 *   1. **Resolvido, sem retentativa.** A automação respondeu (ou decidiu,
 *      corretamente, não responder — silenciada, abortada pela barreira final
 *      do Comando 2, escalonada para a equipe, mensagem duplicada). O trabalho
 *      terminou o que tinha para terminar; tentar de novo não mudaria nada e,
 *      no caso da barreira de controle, poderia reentregar uma resposta que o
 *      controle já mandou não sair.
 *
 *   2. **Entrega incerta — nunca retentável automaticamente.** A chamada à
 *      Evolution estourou o tempo sem resposta: não dá para saber se a
 *      mensagem chegou. Reenviar por conta própria arrisca duplicar uma
 *      mensagem que já pode ter saído — pior que esperar um humano olhar.
 *
 *   3. **Falha transitória.** Erro inesperado (banco piscou, exceção não
 *      prevista) — vale tentar de novo, com backoff, até o limite.
 *
 * @param {object|null} resultado  o que `responderSePossivel` devolveu, ou
 *   `null`/`undefined` se a chamada lançou.
 * @param {Error|null} erro        o erro lançado, quando houve um.
 */
function decidirDesfecho(resultado, erro = null) {
  if (erro) {
    return { desfecho: 'falha_transitoria', motivo: erro.message };
  }

  if (resultado?.entregaIncerta) {
    return { desfecho: 'incerto', motivo: resultado.motivo ?? 'entrega_indeterminada' };
  }

  // Todo desfecho conhecido de responderSePossivel que não seja uma exceção é
  // uma resolução válida — inclusive "não respondeu" (silenciada, abortada
  // por controle, escalonada, duplicada, sem orquestrador).
  return { desfecho: 'resolvido', acao: resultado?.acao ?? null, motivo: resultado?.motivo ?? null };
}

module.exports = {
  ESTADOS,
  BACKOFF_BASE_MS,
  BACKOFF_TETO_MS,
  MAX_TENTATIVAS_PADRAO,
  LEASE_MS,
  proximaTentativa,
  esgotou,
  abandonado,
  decidirDesfecho,
};
