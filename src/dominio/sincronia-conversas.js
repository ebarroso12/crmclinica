'use strict';

const { validarEvento } = require('../contratos/evento');
const { normalizarTelefone } = require('./serena');

// Traz para o CRM as conversas que acontecem no WhatsApp.
//
// O circuito estava aberto: o paciente escrevia, o OpenClaw entregava à Serena,
// ela respondia — e o CRM nunca ficava sabendo. A aba Conversas ficava vazia, o
// funil não se alimentava, e a equipe não tinha como assumir um atendimento.
//
// Esta versão do OpenClaw não expõe webhook de saída. O caminho que existe é
// perguntar: `sessions.list` devolve as conversas, `chat.history` as mensagens.
//
// ------------------------------------------------------------------ garantias
//
// **Identidade vem do gateway, não da posição.** Cada mensagem traz
// `__openclaw.id`, estável entre leituras. A primeira versão usava o índice no
// array — que parece fixo e não é: basta a janela do histórico ser limitada ou a
// sessão ser compactada para todos os índices deslizarem, e aí a conversa
// inteira reentra como nova, refazendo leads e reaplicando opt-outs antigos.
//
// **Só `user` é o paciente.** O histórico traz `assistant`, `toolResult`,
// `system`. Tratar tudo que não é resposta como fala do paciente gravaria
// resultado de ferramenta como se ele tivesse escrito — e o texto passaria pelo
// detector de "PARAR", podendo desligar os lembretes de quem não pediu nada.
//
// **O que o CRM mandou não volta como novidade.** A resposta da equipe sai pelo
// gateway e reaparece no histórico na leitura seguinte. Sem barrar, ela seria
// gravada de novo, atribuída à Serena — a equipe veria a própria mensagem duas
// vezes, uma delas assinada por quem não a escreveu.

/** Só as sessões que vieram do WhatsApp. As do painel são ensaio, não paciente. */
function ehDoWhatsapp(sessao) {
  const origem = sessao?.origin ?? {};
  return origem.provider === 'whatsapp' || origem.surface === 'whatsapp';
}

/**
 * O telefone de quem escreveu.
 *
 * Usa o mesmo normalizador do resto do sistema. Uma normalização própria aqui
 * criaria um segundo contato para o paciente já cadastrado — um com código de
 * país, outro sem — e ninguém perceberia até a ficha aparecer duplicada.
 */
function telefoneDaSessao(sessao) {
  const bruto = sessao?.origin?.from ?? sessao?.displayName ?? '';

  // Grupo não é paciente. O JID de grupo passa em qualquer teste de tamanho, e
  // sem esta linha um grupo viraria contato com vinte dígitos de telefone.
  if (/@g\.us|-\d{6,}$/.test(String(bruto))) return null;

  try {
    return normalizarTelefone(bruto);
  } catch {
    return null;
  }
}

/**
 * Identificador estável da mensagem, para a idempotência do contrato.
 *
 * Sem `__openclaw.id` não há como reconhecer a mensagem numa releitura — e
 * inventar um identificador faria mensagens de pacientes diferentes colidirem
 * no mesmo índice e serem descartadas como duplicadas. Devolver `null` faz a
 * mensagem ser pulada, que é a única saída honesta.
 */
function idDaMensagem(mensagem) {
  const id = mensagem?.__openclaw?.id;
  return id ? `wa:${id}` : null;
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

/**
 * O instante da mensagem, quando dá para confiar nele.
 *
 * `new Date(x).toISOString()` estoura com `RangeError` em qualquer valor que o
 * `Date` não entenda. Se isso acontecesse dentro do laço, a mensagem seria
 * recusada e descartada — em toda leitura, para sempre, enquanto a
 * sincronização relatasse sucesso.
 */
function instanteDaMensagem(mensagem) {
  const bruto = mensagem?.timestamp;
  if (bruto === null || bruto === undefined) return null;

  const data = new Date(typeof bruto === 'string' && /^\d+$/.test(bruto) ? Number(bruto) : bruto);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

function criarSincronizadorDeConversas({ gateway, atendimento, repositorio, registrar = null }) {
  if (!gateway) throw new Error('sincronizador de conversas exige o gateway');
  if (!atendimento) throw new Error('sincronizador de conversas exige o atendimento');
  if (!repositorio) throw new Error('sincronizador de conversas exige o repositório');

  /** Grava uma resposta que já foi entregue ao paciente — pela Serena ou pela equipe. */
  async function registrarSaida({ telefone, texto, idExterno }) {
    const contato = await repositorio.encontrarOuCriarContato({
      telefone, nome: null, canal: 'whatsapp',
    });
    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

    // Eco do que o próprio CRM enviou: a resposta da equipe volta no histórico
    // como saída do agente. Regravá-la duplicaria a mensagem na tela, com a
    // segunda cópia assinada pela Serena em vez de por quem escreveu.
    if (await repositorio.existeSaidaComTexto?.(conversa.id, texto)) {
      return false;
    }

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
    if (!telefone) return { ignorada: true, motivo: 'sessão sem telefone utilizável' };

    const historico = await gateway.chamar('chat.history', { sessionKey: sessao.key });
    const mensagens = Array.isArray(historico?.messages) ? historico.messages : [];

    let gravadas = 0;

    for (const mensagem of mensagens) {
      // `toolResult`, `system` e afins são mecânica interna do agente, não
      // conversa. Só o que o paciente escreveu e o que a Serena respondeu.
      const papel = mensagem?.role;
      if (papel !== 'user' && papel !== 'assistant') continue;

      const texto = textoDaMensagem(mensagem);
      if (!texto) continue;

      const idExterno = idDaMensagem(mensagem);
      if (!idExterno) {
        registrar?.('mensagem sem identificador do gateway', { sessao: sessao.key });
        continue;
      }

      try {
        if (papel === 'assistant') {
          if (await registrarSaida({ telefone, texto, idExterno })) gravadas += 1;
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
          ocorrido_em: instanteDaMensagem(mensagem),
        });

        const resultado = await atendimento.receberMensagem(evento);
        if (resultado?.acao !== 'mensagem_duplicada') gravadas += 1;
      } catch (erro) {
        // Uma mensagem que o contrato recusa não pode interromper as outras da
        // mesma conversa.
        registrar?.('mensagem recusada', { sessao: sessao.key, erro: erro.message });
      }
    }

    return { telefone, mensagens: mensagens.length, gravadas };
  }

  let emAndamento = false;

  return {
    /**
     * Lê as conversas do WhatsApp e as traz para o CRM.
     *
     * Uma passada por vez: cada ciclo faz uma chamada por conversa, e o ciclo do
     * worker é de um minuto. Duas passadas simultâneas disputariam
     * `encontrarOuCriarConversaAberta`, que é SELECT seguido de INSERT — e o
     * resultado seriam duas conversas abertas para o mesmo paciente, com as
     * mensagens divididas entre elas.
     */
    async sincronizar() {
      if (emAndamento) return { pulada: true, motivo: 'sincronização anterior ainda rodando' };
      emAndamento = true;

      try {
        const lista = await gateway.chamar('sessions.list', {});
        const todas = lista?.sessions ?? lista?.entries ?? lista?.items ?? [];
        const sessoes = todas.filter(ehDoWhatsapp);

        // Nenhuma sessão de WhatsApp entre várias sessões é sinal de que o
        // formato mudou — e silêncio aqui faria a função virar um nada que
        // ninguém percebe.
        if (todas.length > 0 && sessoes.length === 0) {
          registrar?.('nenhuma sessão de WhatsApp reconhecida', { total: todas.length });
        }

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
        if (falhas.length > 0) {
          registrar?.('conversas que falharam', { quantas: falhas.length, primeira: falhas[0] });
        }

        return { conversas, gravadas, falhas, sessoes: sessoes.length };
      } finally {
        emAndamento = false;
      }
    },
  };
}

module.exports = {
  criarSincronizadorDeConversas,
  ehDoWhatsapp,
  telefoneDaSessao,
  idDaMensagem,
  textoDaMensagem,
  instanteDaMensagem,
};
