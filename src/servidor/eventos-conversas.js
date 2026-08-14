'use strict';

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

function criarEmissorDeConversas({ repositorio } = {}) {
  const assinantes = new Set();

  /**
   * Registra uma resposta HTTP como assinante. Devolve a função que a
   * remove — quem chama é responsável por chamá-la quando a conexão cair.
   *
   * `depoisDeCursor`: nenhum evento com `id <= depoisDeCursor` é entregue por
   * esta via — é a defesa contra DUPLICAR um evento que o replay (a consulta
   * "tudo desde X" que a rota HTTP faz ANTES de assinar) já entregou. Sem
   * isto, um evento gravado bem no meio de "terminei de responder o replay"
   * e "comecei a receber ao vivo" poderia sair duas vezes.
   */
  function inscrever(res, { depoisDeCursor = 0 } = {}) {
    const assinatura = { res, depoisDeCursor };
    assinantes.add(assinatura);
    return () => assinantes.delete(assinatura);
  }

  /** Empurra um evento JÁ GRAVADO para toda conexão aberta NESTE processo. */
  function empurrar(evento) {
    // `id:` no formato SSE é o que o navegador usa para preencher
    // `Last-Event-ID` sozinho numa reconexão automática — folga extra além
    // do cursor que a própria rota já devolve no replay inicial.
    const linha = `id: ${evento.id}\ndata: ${JSON.stringify(evento)}\n\n`;
    for (const assinatura of assinantes) {
      if (evento.id <= assinatura.depoisDeCursor) continue;
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
      empurrar(evento);
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
