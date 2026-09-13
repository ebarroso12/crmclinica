'use strict';

// Quando o celular toca.
//
// O aviso existe para uma coisa: alguém está esperando resposta e ninguém viu.
// Não é notificação de tudo que acontece — CRM que avisa demais vira CRM que
// ninguém olha, e aí o aviso que importava passa junto com o resto.
//
// Hoje há um gatilho só, o que o Dr. Edson descreveu: a conversa parou na
// equipe (a automação não vai responder) e o paciente está esperando. Os outros
// candidatos (lead novo, resumo pronto, Serena desligada) ficam de fora até
// alguém pedir — acrescentar é uma linha em MOTIVOS.
//
// O aviso leva QUEM falou e o começo do que disse — pedido do Dr. Edson em
// 12/09/2026: "notificação normal, igual à do Gmail". O texto atravessa o
// serviço de push cifrado (RFC 8291): o intermediário entrega, não lê.
//
// O que NÃO vai: só o começo da mensagem, cortado, e nunca mais que isso. Nada
// de histórico, diagnóstico ou dado de agenda — a notificação é um chamado para
// abrir o CRM, não um resumo do prontuário na tela de bloqueio.

const MOTIVOS = Object.freeze({
  aguardando_equipe: 'aguardando_equipe',
});

// Quanto do texto do paciente aparece. Curto de propósito: o suficiente para
// reconhecer o assunto, longe de ser a conversa inteira na tela de bloqueio.
const LIMITE_DA_PREVIA = 120;

/** Uma linha só, sem quebra: notificação não tem parágrafo. */
function umaLinha(texto, limite) {
  const limpo = String(texto ?? '').replace(/\s+/g, ' ').trim();
  if (limpo.length <= limite) return limpo;
  return `${limpo.slice(0, limite - 1).trimEnd()}…`;
}

// Um aviso por conversa a cada janela: sem isso, três mensagens seguidas do
// mesmo paciente fazem o celular tocar três vezes em dez segundos.
const JANELA_DE_SILENCIO_MS = 10 * 60 * 1000;

function criarAvisos({ repositorio, webpush, registrador = null, agora = () => new Date() } = {}) {
  // Memória do processo, de propósito: o silêncio é por worker e por janela
  // curta. Guardar no banco custaria uma escrita por mensagem recebida para
  // economizar uma notificação — a conta não fecha.
  const ultimoAviso = new Map();

  function passouDaJanela(chave) {
    const anterior = ultimoAviso.get(chave);
    const instante = agora().getTime();
    if (anterior && instante - anterior < JANELA_DE_SILENCIO_MS) return false;
    ultimoAviso.set(chave, instante);
    return true;
  }

  /**
   * Monta o que a notificação mostra. Sem conversa (ou sem conseguir ler), cai
   * no texto genérico — melhor um aviso vago que nenhum aviso.
   */
  async function conteudoDoAviso(conversaId) {
    const generico = { titulo: 'CRM Clínica', corpo: 'Alguém está esperando resposta no atendimento.', url: '/' };
    if (!conversaId || !repositorio.obterConversa) return generico;

    try {
      const conversa = await repositorio.obterConversa(conversaId);
      if (!conversa) return generico;

      const contato = conversa.contato_id && repositorio.obterContato
        ? await repositorio.obterContato(conversa.contato_id)
        : null;

      const mensagens = repositorio.listarMensagens
        ? await repositorio.listarMensagens(conversaId, { limite: 5 })
        : [];
      const ultimaDoContato = [...(mensagens ?? [])].reverse()
        .find((mensagem) => mensagem.direcao === 'entrada' && mensagem.conteudo);

      const quem = umaLinha(contato?.nome || contato?.telefone || 'Paciente', 60);
      const disse = umaLinha(ultimaDoContato?.conteudo, LIMITE_DA_PREVIA);

      return {
        titulo: quem,
        corpo: disse || 'Está esperando resposta.',
        url: `/?conversa=${Number(conversaId)}`,
      };
    } catch {
      // Falha ao montar o texto não pode cancelar o aviso.
      return generico;
    }
  }

  /**
   * Avisa quem pode ver aquela conversa. Nunca lança: um aviso que falha não
   * pode derrubar o atendimento que o gerou — o paciente já foi atendido (ou
   * escalonado) quando isto roda.
   */
  async function avisar({ motivo = MOTIVOS.aguardando_equipe, conversaId = null, agenteId = null } = {}) {
    try {
      if (!webpush?.configurado) return { enviados: 0, motivo: 'vapid_nao_configurado' };
      if (conversaId !== null && !passouDaJanela(`${motivo}:${conversaId}`)) {
        return { enviados: 0, motivo: 'dentro_da_janela_de_silencio' };
      }

      const inscricoes = await repositorio.listarInscricoesParaAviso({ agenteId });
      if (inscricoes.length === 0) return { enviados: 0, motivo: 'ninguem_inscrito' };

      // Uma vez só por aviso, não uma por aparelho: ler a conversa é ida ao
      // banco, e o texto é o mesmo para todo mundo que pode ver.
      const conteudo = await conteudoDoAviso(conversaId);
      let enviados = 0;

      for (const inscricao of inscricoes) {
        const resultado = await webpush.empurrar(inscricao.endpoint, {
          urgencia: 'high',
          conteudo,
          // As chaves são deste aparelho: a mensagem é cifrada para ele.
          aparelho: { p256dh: inscricao.p256dh, auth: inscricao.auth },
        });

        if (resultado.entregue) {
          enviados += 1;
          await repositorio.marcarEnvioDeNotificacao(inscricao.endpoint);
          continue;
        }
        // Aparelho que desinstalou o app, limpou os dados ou revogou a
        // permissão: a inscrição está morta e insistir nela é gastar
        // requisição para sempre.
        if (resultado.remover) await repositorio.apagarInscricaoPorEndpoint(inscricao.endpoint);
      }

      return { enviados, motivo };
    } catch (erro) {
      registrador?.aviso?.({ evento: 'aviso_no_celular_falhou', motivo, erro: erro.message });
      return { enviados: 0, motivo: 'falhou', erro: erro.message };
    }
  }

  return { avisar, MOTIVOS, JANELA_DE_SILENCIO_MS };
}

module.exports = { criarAvisos, MOTIVOS, JANELA_DE_SILENCIO_MS };
