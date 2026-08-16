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

function criarEmissorDeConversas({ repositorio } = {}) {
  const assinantes = new Set();

  // NÃO EXISTE CACHE DE AUTORIZAÇÃO AQUI — e isto é a correção, não uma
  // omissão. Gate final do PR #34, provado contra PostgreSQL 18.4 real:
  //
  //   1) evento com conversa atribuida a A: A recebeu = true
  //   2) reatribuicao confirmada no banco: atribuido_a = 2 (B = 2)
  //   3) evento imediatamente apos a reatribuicao: A AINDA recebeu = true
  //   4) evento >5s apos a reatribuicao: A recebeu = false
  //
  // A versão anterior guardava `atribuido_a` num Map com TTL de 5s. O
  // raciocínio da época ("a pior janela de exposição é o TTL, nunca 'para
  // sempre'") aceitava, como custo, até 5 segundos de conteúdo de paciente
  // indo para um atendente que já tinha perdido o acesso. Numa clínica isso
  // não é um trade-off: é o vazamento.
  //
  // E invalidar o cache localmente (por exemplo em `conversa_assumida`) NÃO
  // resolveria: a produção roda em mais de um processo (VPS + Vercel). Uma
  // reatribuição feita no processo X não invalida cache nenhum do processo
  // Y, e o atendente antigo conectado em Y continuaria recebendo. Qualquer
  // solução com estado de autorização em memória de processo tem esse furo
  // por construção; a única que vale para N processos é consultar o estado
  // ATUAL a cada evento.
  //
  // O custo que o cache existia para evitar era real, mas o diagnóstico
  // estava errado: o problema não era "consultar a cada evento", era
  // "consultar POR ASSINANTE" (uma ida ao banco por aba aberta, a cada
  // evento). `empurrar` resolve isso consultando UMA vez por evento e
  // reaproveitando o resultado para todas as assinaturas daquele evento —
  // sem guardar nada entre eventos.

  /**
   * Resolve o escopo ATUAL de uma conversa. Devolve o resultado tri-estado
   * do repositório (ver `obterEscopoDaConversa` em src/dados/repositorio.js):
   * `{ estado: 'existe', atribuidoA }` ou `{ estado: 'inexistente' }`.
   * Qualquer falha LANÇA — erro nunca vira um valor que pareça resultado.
   */
  async function resolverEscopo(conversaId) {
    if (!repositorio?.obterEscopoDaConversa) {
      throw new Error('repositório sem obterEscopoDaConversa — não há como confirmar o escopo de um atendente');
    }
    return repositorio.obterEscopoDaConversa(conversaId);
  }

  /**
   * Decide se ESTA assinatura pode receber um evento, dado o escopo JÁ
   * resolvido do evento — MESMO predicado (`podeAcessarConversaAoVivo`)
   * usado pelo replay em `repositorio.listarEventosDeConversasDesde`.
   *
   * Puro e síncrono de propósito: toda a I/O acontece uma única vez, antes,
   * em `empurrar`. Enquanto esta decisão era `async` e consultava por
   * assinante, ela também era o ponto onde duas publicações concorrentes se
   * intercalavam (BLOQUEADOR 2).
   *
   * `escopo` chega em um de três formatos, e os três são distintos:
   *   - { estado: 'existe', atribuidoA }  → o predicado decide;
   *   - { estado: 'inexistente' }         → nega (conversa que não existe
   *     não é "conversa livre": tratá-las igual concedia acesso, provado);
   *   - { estado: 'erro' }                → nega (fail-closed: sem conseguir
   *     confirmar, não envia).
   */
  function podeReceber(assinatura, escopo) {
    // admin/gestor têm acesso global e a decisão deles NÃO depende de
    // `atribuido_a` — por isso nunca tocam o banco (é a otimização legítima
    // que sobrevive à remoção do cache) e por isso um erro numa consulta
    // que a decisão deles nem usa não pode virar perda de acesso para eles.
    if (assinatura.papel === 'admin' || assinatura.papel === 'gestor') return true;
    if (assinatura.papel !== 'atendente') return false;
    if (!escopo || escopo.estado !== 'existe') return false;
    return podeAcessarConversaAoVivo(assinatura.papel, assinatura.usuarioId, escopo.atribuidoA);
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

    // Candidatas primeiro: o cursor filtra ANTES de qualquer I/O, então uma
    // conexão que já recebeu este evento pelo replay não faz o processo
    // pagar consulta nenhuma por ele.
    const candidatas = [];
    for (const assinatura of assinantes) {
      if (evento.id <= assinatura.depoisDeCursor) continue;
      candidatas.push(assinatura);
    }
    if (candidatas.length === 0) return;

    // UMA consulta por EVENTO — não por assinante (era o custo real que o
    // cache com TTL existia para evitar) e não reaproveitada entre eventos
    // (era o TTL, a janela de exposição). Se nenhuma candidata é atendente,
    // ninguém precisa de `atribuido_a` e não há consulta alguma.
    let escopo = null;
    if (candidatas.some((assinatura) => assinatura.papel === 'atendente')) {
      try {
        escopo = await resolverEscopo(evento.conversa_id);
      } catch (erro) {
        // Fail-closed, sem mascarar: o erro (conexão, permissão 42501, SQL)
        // é registrado como erro e o estado vira explicitamente 'erro' —
        // nunca `null`, que `podeAcessarConversaAoVivo` leria como "livre".
        console.error(`[eventos-conversas] falha ao resolver escopo ao vivo (conversa ${evento.conversa_id}) — negando por padrão: ${erro.code ? `${erro.code} ` : ''}${erro.message}`);
        escopo = { estado: 'erro' };
      }
    }

    for (const assinatura of candidatas) {
      if (!podeReceber(assinatura, escopo)) continue;
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
