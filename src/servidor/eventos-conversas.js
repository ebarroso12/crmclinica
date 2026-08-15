'use strict';

const { podeAcessarConversaAoVivo } = require('../seguranca/rbac');

// Barramento do chat ao vivo — Pendência 4 do comando mestre (reconstrução).
//
// ANTES: só em memória do processo (`Set` de conexões, `publicar` gravava
// nada em lugar nenhum). Uma aba que caía e reconectava perdia tudo que
// aconteceu no intervalo; reiniciar o processo apagava o histórico inteiro;
// não havia como uma segunda instância (ou o mesmo processo depois de
// reiniciar) saber "o que eu perdi".
//
// AGORA: toda publicação grava PRIMEIRO em `conversas_eventos` (Postgres,
// migration 037) — a fonte de verdade, com `id` bigserial como CURSOR
// MONOTÔNICO — e só DEPOIS empurra para quem está conectado neste processo,
// por latência (sem isso, todo mundo teria que esperar o próximo poll).
// Quem reconecta (ou nunca perdeu a conexão, mas o processo reiniciou) lê o
// que perdeu do banco via `listarEventosDeConversasDesde`, não da memória.
//
// A escrita durável NUNCA bloqueia nem derruba quem chama: publicar() nunca
// lança. Se o banco falhar, o evento não entra no log (best-effort, como a
// auditoria) — mas a mensagem em si (a fonte de verdade real) já foi gravada
// antes de qualquer chamada a publicar() acontecer; o chat ao vivo é um
// espelho de conveniência, não onde o dado mora.

function criarEmissorDeConversas({ repositorio, ttlCacheDeEscopoMs = 5000 } = {}) {
  const assinantes = new Set();

  // Cache curto de `atribuido_a`, compartilhado entre TODAS as conexões
  // deste processo — BLOQUEADOR 1 da auditoria do PR #34. Sem ele, uma
  // conversa movimentada com várias abas de recepção abertas faria uma
  // consulta ao banco POR ASSINANTE a CADA evento, só para decidir quem
  // pode ver. TTL curto é a defesa contra "conversa reatribuída no meio do
  // TTL continua visível para quem perdeu o acesso" — a pior janela de
  // exposição é o TTL, nunca "para sempre" (padrão trade-off já usado pelo
  // ticket de SSE, que também tem validade curta em vez de longa).
  const cacheDeAtribuicao = new Map(); // conversaId -> { atribuidoA, expiraEm }

  async function resolverAtribuidoA(conversaId) {
    if (!repositorio?.obterAtribuidoDaConversa) {
      throw new Error('repositório sem obterAtribuidoDaConversa — não há como confirmar o escopo de um atendente');
    }
    const agora = Date.now();
    const emCache = cacheDeAtribuicao.get(conversaId);
    if (emCache && emCache.expiraEm > agora) return emCache.atribuidoA;
    const atribuidoA = await repositorio.obterAtribuidoDaConversa(conversaId);
    cacheDeAtribuicao.set(conversaId, { atribuidoA, expiraEm: agora + ttlCacheDeEscopoMs });
    return atribuidoA;
  }

  /**
   * Decide se ESTA assinatura pode receber um evento desta conversa —
   * MESMO predicado (`podeAcessarConversaAoVivo`) usado pelo replay em
   * `repositorio.listarEventosDeConversasDesde`. admin/gestor nunca
   * precisam de `atribuido_a`, então nunca tocam o banco/cache; só
   * atendente paga o custo da consulta (cacheada).
   *
   * Fail-closed: qualquer falha ao resolver o responsável (banco fora do
   * ar, por exemplo) NEGA o evento — nunca envia por não saber dizer não.
   */
  async function autorizada(assinatura, conversaId) {
    if (assinatura.papel === 'admin' || assinatura.papel === 'gestor') return true;
    if (assinatura.papel !== 'atendente') return false;
    try {
      const atribuidoA = await resolverAtribuidoA(conversaId);
      return podeAcessarConversaAoVivo(assinatura.papel, assinatura.usuarioId, atribuidoA);
    } catch (erro) {
      console.error(`[eventos-conversas] falha ao resolver escopo ao vivo — negando por padrão: ${erro.message}`);
      return false;
    }
  }

  /**
   * Registra uma resposta HTTP como assinante. Devolve a função que a
   * remove — quem chama é responsável por chamá-la quando a conexão cair.
   *
   * `depoisDeCursor`: nenhum evento com `id <= depoisDeCursor` é entregue por
   * esta via — é a defesa contra DUPLICAR um evento que o replay (a consulta
   * "tudo desde X" que a rota HTTP faz ANTES de assinar) já entregou. Sem
   * isto, um evento gravado bem no meio de "terminei de responder o replay"
   * e "comecei a receber ao vivo" poderia sair duas vezes.
   *
   * `usuarioId`/`papel`: identidade resgatada do bilhete de uso único (ver
   * http.js) — é o que `autorizada()` usa para decidir, evento a evento, se
   * ESTA conexão pode ver ESTA conversa (BLOQUEADOR 1, auditoria PR #34).
   */
  function inscrever(res, { depoisDeCursor = 0, usuarioId = null, papel = null } = {}) {
    const assinatura = { res, depoisDeCursor, usuarioId, papel };
    assinantes.add(assinatura);
    return () => assinantes.delete(assinatura);
  }

  /** Empurra um evento JÁ GRAVADO para toda conexão aberta NESTE processo autorizada a vê-lo. */
  async function empurrar(evento) {
    // `id:` no formato SSE é o que o navegador usa para preencher
    // `Last-Event-ID` sozinho numa reconexão automática — folga extra além
    // do cursor que a própria rota já devolve no replay inicial.
    const linha = `id: ${evento.id}\ndata: ${JSON.stringify(evento)}\n\n`;
    for (const assinatura of assinantes) {
      if (evento.id <= assinatura.depoisDeCursor) continue;
      if (!(await autorizada(assinatura, evento.conversa_id))) continue;
      try {
        assinatura.res.write(linha);
      } catch {
        assinantes.delete(assinatura);
      }
    }
  }

  /**
   * Grava e publica um evento. Nunca lança — best-effort, como auditoria.
   * Devolve o evento gravado (com `id`/cursor) ou `null` se a escrita falhou
   * ou não há repositório configurado (uso em contexto sem persistência).
   */
  async function publicar({ conversaId, tipo, payload = {} }) {
    if (!repositorio?.registrarEventoDeConversa) return null;
    try {
      const evento = await repositorio.registrarEventoDeConversa({ conversaId, tipo, payload });
      await empurrar(evento);
      return evento;
    } catch (erro) {
      console.error(`[eventos-conversas] falha ao registrar evento "${tipo}": ${erro.message}`);
      return null;
    }
  }

  /**
   * Atalho para o evento mais comum: uma mensagem nova gravada numa
   * conversa. O tipo (`mensagem_recebida`/`mensagem_enviada`) sai da própria
   * direção da mensagem — os 5 pontos de chamada existentes em
   * `atendimento.js` continuam funcionando sem alteração.
   */
  async function publicarMensagem(conversaId, mensagem) {
    if (!mensagem) return null;
    const tipo = mensagem.direcao === 'entrada' ? 'mensagem_recebida' : 'mensagem_enviada';
    return publicar({
      conversaId,
      tipo,
      payload: {
        mensagem_id: mensagem.id ?? null,
        direcao: mensagem.direcao ?? null,
        privada: Boolean(mensagem.privada),
        criado_em: mensagem.criado_em ?? null,
      },
    });
  }

  /** Conversa assumida por um humano — distinto de "chegou mensagem". */
  async function publicarConversaAssumida(conversaId, { usuarioId = null } = {}) {
    return publicar({ conversaId, tipo: 'conversa_assumida', payload: { usuario_id: usuarioId } });
  }

  /** Conversa marcada como resolvida (POST /api/conversas/:id/estado). */
  async function publicarConversaResolvida(conversaId) {
    return publicar({ conversaId, tipo: 'conversa_resolvida', payload: {} });
  }

  /** Falha de entrega ou aborto pela barreira final — nunca conteúdo clínico no payload. */
  async function publicarErro(conversaId, { motivo, mensagemId = null } = {}) {
    return publicar({ conversaId, tipo: 'erro', payload: { motivo, mensagem_id: mensagemId } });
  }

  /** Status de entrega mudou (ex.: falhou_evolution) numa mensagem já gravada. */
  async function publicarStatusDeEntrega(conversaId, { mensagemId, status }) {
    return publicar({ conversaId, tipo: 'status_entrega', payload: { mensagem_id: mensagemId, status } });
  }

  function total() {
    return assinantes.size;
  }

  return {
    inscrever,
    publicar,
    publicarMensagem,
    publicarConversaAssumida,
    publicarConversaResolvida,
    publicarErro,
    publicarStatusDeEntrega,
    total,
  };
}

module.exports = { criarEmissorDeConversas };
