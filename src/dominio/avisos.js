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
// O empurrão não leva texto (ver src/seguranca/webpush.js): a notificação
// aparece na tela de bloqueio, e nome de paciente ali é vazamento. O aparelho
// mostra um texto fixo e, ao ser tocado, abre o CRM.

const MOTIVOS = Object.freeze({
  aguardando_equipe: 'aguardando_equipe',
});

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
      let enviados = 0;

      for (const inscricao of inscricoes) {
        const resultado = await webpush.empurrar(inscricao.endpoint, { urgencia: 'high' });

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
