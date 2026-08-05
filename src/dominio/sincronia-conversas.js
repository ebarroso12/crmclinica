'use strict';

const { validarEvento } = require('../contratos/evento');

// Traz para o CRM as conversas que acontecem no WhatsApp.
//
// O circuito estava aberto: o paciente escrevia, o OpenClaw entregava à Serena,
// ela respondia — e o CRM nunca ficava sabendo. A aba Conversas ficava vazia, o
// funil não se alimentava, ninguém virava contato, e a equipe não tinha como
// assumir um atendimento pelo painel. Duas metades do mesmo sistema, sem fio
// entre elas.
//
// Esta versão do OpenClaw não expõe webhook de saída. O caminho que existe é
// perguntar: `sessions.list` devolve as conversas, `chat.history` devolve as
// mensagens de cada uma. O worker já vive conectado ao gateway, então a leitura
// entra no ciclo que já roda.
//
// ------------------------------------------------------------------ garantias
//
// **Nada é duplicado.** Cada mensagem entra pelo contrato de eventos, com um
// `id_externo` estável derivado da sessão e da posição da mensagem. A
// idempotência do contrato — `sha256(versão|canal|tipo|id_externo)` — recusa a
// segunda entrada da mesma mensagem, e é isso que permite reler o histórico
// inteiro a cada ciclo sem encher o inbox de repetições.
//
// **A resposta da Serena entra como mensagem dela**, não do paciente. Sem essa
// separação, a equipe abriria a conversa e leria o paciente dizendo coisas que
// nunca disse.
//
// **Falha de uma conversa não impede as outras.** Uma sessão com histórico
// corrompido não pode travar a sincronização de todas as demais.

/** Só as sessões que vieram do WhatsApp. As do painel são ensaio, não paciente. */
function ehDoWhatsapp(sessao) {
  const origem = sessao?.origin ?? {};
  return origem.provider === 'whatsapp' || origem.surface === 'whatsapp';
}

/**
 * O telefone de quem escreveu, em E.164 sem o `+`.
 *
 * O contrato guarda assim, e é como o resto do sistema compara telefone. Deixar
 * o `+` passar criaria dois contatos para a mesma pessoa — um com, outro sem.
 */
function telefoneDaSessao(sessao) {
  const bruto = sessao?.origin?.from ?? sessao?.displayName ?? '';
  const digitos = String(bruto).replace(/\D+/g, '');
  return digitos.length >= 10 ? digitos : null;
}

/**
 * Identificador estável de uma mensagem dentro da conversa.
 *
 * Precisa ser o mesmo em toda releitura, ou a idempotência não reconheceria a
 * mensagem já gravada e ela entraria de novo a cada ciclo. Por isso usa a
 * posição — que não muda — e não o instante, que o gateway reescreve.
 */
function idDaMensagem(sessao, indice) {
  const sufixo = sessao.sessionId ?? sessao.key ?? 'sessao';
  return `wa:${sufixo}:${indice}`;
}

function textoDaMensagem(mensagem) {
  const conteudo = mensagem?.content;
  if (typeof conteudo === 'string') return conteudo.trim();
  if (Array.isArray(conteudo)) {
    return conteudo
      .filter((parte) => parte?.type === 'text' && typeof parte.text === 'string')
      .map((parte) => parte.text)
      .join('\n')
      .trim();
  }
  return '';
}

function criarSincronizadorDeConversas({ gateway, atendimento, repositorio, registrar = null }) {
  if (!gateway) throw new Error('sincronizador de conversas exige o gateway');
  if (!atendimento) throw new Error('sincronizador de conversas exige o atendimento');
  if (!repositorio) throw new Error('sincronizador de conversas exige o repositório');

  /**
   * Grava a resposta que a Serena já deu no WhatsApp.
   *
   * Entra como saída da automação, no mesmo histórico que a equipe lê — e não
   * dispara envio nenhum: a mensagem já foi entregue ao paciente pelo OpenClaw.
   * Reenviar aqui faria o paciente receber tudo de novo a cada sincronização.
   */
  async function registrarRespostaDaSerena({ telefone, texto, idExterno }) {
    const contato = await repositorio.encontrarOuCriarContato({
      telefone, nome: null, canal: 'whatsapp',
    });
    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

    const { duplicada } = await repositorio.registrarMensagem(conversa.id, {
      direcao: 'saida',
      tipo: 'texto',
      conteudo: texto,
      autor_tipo: 'automacao',
      autor_nome: 'Serena',
      id_externo: idExterno,
    });

    return !duplicada;
  }

  async function sincronizarUma(sessao) {
    const telefone = telefoneDaSessao(sessao);
    if (!telefone) return { ignorada: true, motivo: 'sessão sem telefone' };

    const historico = await gateway.chamar('chat.history', { sessionKey: sessao.key });
    const mensagens = Array.isArray(historico?.messages) ? historico.messages : [];

    let gravadas = 0;

    for (let indice = 0; indice < mensagens.length; indice += 1) {
      const mensagem = mensagens[indice];
      const texto = textoDaMensagem(mensagem);
      if (!texto) continue;

      const idExterno = idDaMensagem(sessao, indice);

      try {
        if (mensagem.role === 'assistant') {
          // A resposta da Serena entra como saída da automação. Passá-la por
          // `receberMensagem` a gravaria como `autor_tipo: 'contato'` — e a
          // equipe abriria o inbox lendo o paciente dizer o que a Serena disse.
          const gravou = await registrarRespostaDaSerena({ telefone, texto, idExterno, mensagem });
          if (gravou) gravadas += 1;
          continue;
        }

        const evento = validarEvento({
          tipo: 'mensagem.recebida',
          canal: 'whatsapp',
          id_externo: idExterno,
          remetente: telefone,
          // Nome só quando o WhatsApp informou um de verdade: `displayName` cai
          // para o próprio telefone quando o contato não tem nome salvo, e isso
          // criaria fichas chamadas "+5516999999999".
          nome: sessao.displayName && !/^\+?[\d\s()-]+$/.test(sessao.displayName)
            ? sessao.displayName
            : null,
          texto,
          origem: 'whatsapp',
          ocorrido_em: mensagem.timestamp ? new Date(mensagem.timestamp).toISOString() : null,
        });

        const resultado = await atendimento.receberMensagem(evento);
        if (resultado?.acao !== 'mensagem_duplicada') gravadas += 1;
      } catch (erro) {
        // Uma mensagem que o contrato recusa — texto vazio depois de limpar,
        // telefone estranho — não pode interromper as outras da mesma conversa.
        registrar?.('mensagem recusada', { sessao: sessao.key, indice, erro: erro.message });
      }
    }

    return { telefone, mensagens: mensagens.length, gravadas };
  }

  return {
    /**
     * Lê as conversas do WhatsApp e as traz para o CRM.
     *
     * Relê o histórico inteiro de cada conversa a cada ciclo, de propósito: é
     * mais simples e mais seguro que guardar marcador de posição, e a
     * idempotência do contrato torna a releitura barata — mensagem já gravada é
     * recusada antes de tocar o banco.
     */
    async sincronizar() {
      const lista = await gateway.chamar('sessions.list', {});
      const sessoes = (lista?.sessions ?? lista?.entries ?? lista?.items ?? [])
        .filter(ehDoWhatsapp);

      let conversas = 0;
      let gravadas = 0;
      const falhas = [];

      for (const sessao of sessoes) {
        try {
          const resultado = await sincronizarUma(sessao);
          if (!resultado.ignorada) {
            conversas += 1;
            gravadas += resultado.gravadas;
          }
        } catch (erro) {
          // Uma conversa com histórico corrompido não pode travar as demais.
          falhas.push({ sessao: sessao.key, erro: erro.message });
        }
      }

      if (gravadas > 0) {
        console.log(`[conversas] ${gravadas} mensagem(ns) nova(s) em ${conversas} conversa(s)`);
      }

      return { conversas, gravadas, falhas, sessoes: sessoes.length };
    },
  };
}

module.exports = {
  criarSincronizadorDeConversas, ehDoWhatsapp, telefoneDaSessao, idDaMensagem, textoDaMensagem,
};
