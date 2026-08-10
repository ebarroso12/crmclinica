'use strict';

// Barramento de eventos do inbox: liga quem grava uma mensagem (webhook do
// canal, automação da Serena, ou a própria equipe respondendo) a quem está
// com a tela de Conversas aberta no navegador.
//
// Processo único (o crmclinica roda como um serviço de sistema, não em
// funções serverless replicadas) — memória do próprio processo basta. Não há
// fila, Redis nem serviço externo por trás disto: é um EventEmitter de fato,
// com Server-Sent Events como transporte até o navegador.

function criarEmissorDeConversas() {
  const assinantes = new Set();

  /**
   * Registra uma resposta HTTP como assinante. Devolve a função que a remove —
   * quem chama é responsável por chamá-la quando a conexão cair (`req.close`).
   */
  function inscrever(res) {
    assinantes.add(res);
    return () => assinantes.delete(res);
  }

  /** Manda o evento para toda conexão aberta. Uma escrita que falha só derruba aquele assinante. */
  function publicar(evento) {
    const linha = `data: ${JSON.stringify(evento)}\n\n`;
    for (const res of assinantes) {
      try {
        res.write(linha);
      } catch {
        assinantes.delete(res);
      }
    }
  }

  /** Atalho para o evento mais comum: uma mensagem nova gravada numa conversa. */
  function publicarMensagem(conversaId, mensagem) {
    if (!mensagem) return;
    publicar({
      tipo: 'mensagem',
      conversa_id: Number(conversaId),
      mensagem_id: mensagem.id ?? null,
      direcao: mensagem.direcao ?? null,
      privada: Boolean(mensagem.privada),
      criado_em: mensagem.criado_em ?? new Date().toISOString(),
    });
  }

  function total() {
    return assinantes.size;
  }

  return { inscrever, publicar, publicarMensagem, total };
}

module.exports = { criarEmissorDeConversas };
