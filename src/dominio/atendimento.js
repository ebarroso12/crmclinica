'use strict';

const { decidirAutomacao, montarContextoMinimo, aplicarTemperatura } = require('./conversas');
const { sugerirTemperatura, origemDoCanal } = require('./leads');

// O ciclo de atendimento do crmclinica.
//
// Mensagem chega → grava no banco → decide se a automação pode responder →
// manda contexto mínimo ao OpenClaw → grava a resposta no histórico local.
//
// Três invariantes governam tudo:
//   1. o banco é a fonte de verdade — toda mensagem, de quem for, é gravada aqui;
//   2. quando um humano assume, a automação cala;
//   3. só o contexto mínimo autorizado atravessa para o orquestrador.

function criarAtendimento({ repositorio, orquestrador }) {
  /**
   * Recebe uma mensagem de canal: garante contato e conversa, grava e decide.
   * O `id_externo` sustenta a idempotência — reentrega do canal não duplica linha.
   */
  async function receberMensagem(evento) {
    const contato = await repositorio.encontrarOuCriarContato({
      telefone: evento.remetente,
      nome: evento.nome,
      canal: evento.canal,
      // O identificador só existe quando o canal fornece um próprio (perfil do
      // Instagram, por exemplo). Repetir o telefone aqui seria ruído na ficha.
      identificador: evento.identificador ?? null,
    });

    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, evento.canal);

    const { mensagem, duplicada } = await repositorio.registrarMensagem(conversa.id, {
      direcao: 'entrada',
      tipo: 'texto',
      conteudo: evento.texto,
      autor_tipo: 'contato',
      autor_nome: contato.nome,
      id_externo: evento.id_externo,
    });

    if (duplicada) {
      return { acao: 'mensagem_duplicada', conversa_id: conversa.id, mensagem_id: mensagem.id };
    }

    // O lead nasce junto da conversa e guarda o vínculo: é o que faz o card do
    // kanban abrir a conversa certa.
    await repositorio.salvarLead(contato.id, {
      conversaId: conversa.id,
      origem: origemDoCanal(evento.canal),
    });
    await sincronizarTemperatura(conversa.id);

    return responderSePossivel(conversa.id);
  }

  /** Aplica a regra da pausa e, quando permitido, aciona o orquestrador. */
  async function responderSePossivel(conversaId) {
    const conversa = await repositorio.obterConversa(conversaId);
    const decisao = decidirAutomacao(conversa);

    if (!decisao.responder) {
      await repositorio.registrarAuditoria({
        entidade: 'conversa',
        entidadeId: conversaId,
        acao: 'automacao_silenciada',
        detalhe: { motivo: decisao.motivo },
      });
      return { acao: 'aguardando_equipe', conversa_id: conversaId, motivo: decisao.motivo };
    }

    if (!orquestrador?.disponivel) {
      return { acao: 'sem_orquestrador', conversa_id: conversaId, motivo: 'openclaw_nao_configurado' };
    }

    const mensagens = await repositorio.listarMensagens(conversaId, { incluirPrivadas: false });
    const contexto = montarContextoMinimo(conversa, mensagens);

    try {
      const resposta = await orquestrador.despacharEvento({
        chave_idempotencia: `conversa:${conversaId}:${mensagens.at(-1)?.id ?? 0}`,
        tipo: 'conversa.mensagem_recebida',
        contexto,
      });

      const texto = resposta?.resposta || resposta?.texto;
      if (texto) {
        // A resposta da IA entra no mesmo histórico que a equipe lê. Não há
        // registro paralelo: quem abre a conversa vê tudo em ordem.
        await repositorio.registrarMensagem(conversaId, {
          direcao: 'saida',
          conteudo: texto,
          autor_tipo: 'automacao',
          autor_nome: 'Serena',
        });
        await repositorio.registrarAuditoria({
          entidade: 'conversa',
          entidadeId: conversaId,
          acao: 'respondida_pela_automacao',
        });
        return { acao: 'respondida_pela_automacao', conversa_id: conversaId };
      }

      if (resposta?.escalonar) {
        await escalonar(conversaId, resposta.motivo || 'escalonamento_do_orquestrador');
        return { acao: 'escalonada', conversa_id: conversaId, motivo: resposta.motivo };
      }

      return { acao: 'sem_resposta_do_orquestrador', conversa_id: conversaId };
    } catch (erro) {
      // Falha do orquestrador não pode travar o atendimento: entrega para a equipe.
      await escalonar(conversaId, 'falha_no_orquestrador');
      return {
        acao: 'escalonada_por_falha',
        conversa_id: conversaId,
        codigo: erro.codigo || 'desconhecido',
      };
    }
  }

  /**
   * Um humano assume a conversa. A automação para na mesma transação lógica:
   * marcar como assumida e não pausar a IA seriam duas verdades sobre a mesma coisa.
   */
  async function assumir(conversaId, usuarioId = null, { pausarMinutos = null } = {}) {
    const pausaAte = pausarMinutos
      ? new Date(Date.now() + pausarMinutos * 60_000).toISOString()
      : null;

    const conversa = await repositorio.atualizarConversa(conversaId, {
      assumida_por_humano: true,
      atribuido_a: usuarioId,
      ia_pausada_ate: pausaAte,
      status: 'aberta',
    });

    await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      tipo: 'sistema',
      conteudo: 'Conversa assumida pela equipe. A resposta automática está pausada.',
      autor_tipo: 'sistema',
      privada: true,
    });
    await repositorio.registrarAuditoria({
      entidade: 'conversa',
      entidadeId: conversaId,
      acao: 'assumida_por_humano',
      detalhe: { usuario_id: usuarioId },
      usuarioId,
    });

    return conversa;
  }

  /** Devolve a conversa à automação. */
  async function liberar(conversaId) {
    const conversa = await repositorio.atualizarConversa(conversaId, {
      assumida_por_humano: false,
      atribuido_a: null,
      ia_pausada_ate: null,
    });

    await repositorio.registrarAuditoria({
      entidade: 'conversa',
      entidadeId: conversaId,
      acao: 'liberada_para_automacao',
    });
    return conversa;
  }

  /** Resposta escrita por uma pessoa. Assumir é consequência, não pré-requisito. */
  async function responderComoEquipe(conversaId, texto, { usuarioId = null, autorNome = null, privada = false } = {}) {
    const { mensagem } = await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      conteudo: texto,
      autor_tipo: privada ? 'sistema' : 'equipe',
      autor_nome: autorNome,
      privada,
    });

    // Nota interna não é atendimento: não assume a conversa nem cala a IA.
    if (!privada) {
      const conversa = await repositorio.obterConversa(conversaId);
      if (!conversa.assumida_por_humano) await assumir(conversaId, usuarioId);
    }

    return mensagem;
  }

  async function escalonar(conversaId, motivo) {
    await repositorio.atualizarConversa(conversaId, { assumida_por_humano: true, status: 'aberta' });
    await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      tipo: 'sistema',
      conteudo: `Conversa encaminhada para a equipe (${motivo}).`,
      autor_tipo: 'sistema',
      privada: true,
    });
    await repositorio.registrarAuditoria({
      entidade: 'conversa',
      entidadeId: conversaId,
      acao: 'escalonada',
      detalhe: { motivo },
    });
  }

  /** Define a temperatura manualmente, preservando as demais etiquetas. */
  async function definirTemperatura(conversaId, temperatura) {
    const atuais = await repositorio.listarEtiquetasDaConversa(conversaId);
    const novas = aplicarTemperatura(atuais, temperatura);
    await repositorio.definirEtiquetasDaConversa(conversaId, novas);

    const conversa = await repositorio.obterConversa(conversaId);
    await repositorio.salvarLead(conversa.contato_id, { conversaId, temperatura });

    return { conversa_id: conversaId, temperatura, etiquetas: novas };
  }

  /**
   * Aplica a temperatura sugerida — mas só quando ninguém marcou nada.
   * A etiqueta posta por uma pessoa é soberana.
   */
  async function sincronizarTemperatura(conversaId) {
    const conversa = await repositorio.obterConversa(conversaId);
    const sugestao = sugerirTemperatura(conversa);
    if (sugestao.origem === 'etiqueta_da_equipe') return sugestao;

    const novas = aplicarTemperatura(conversa.etiquetas, sugestao.temperatura);
    await repositorio.definirEtiquetasDaConversa(conversaId, novas);
    await repositorio.salvarLead(conversa.contato_id, {
      conversaId,
      temperatura: sugestao.temperatura,
    });

    return sugestao;
  }

  return {
    receberMensagem,
    responderSePossivel,
    assumir,
    liberar,
    responderComoEquipe,
    escalonar,
    definirTemperatura,
    sincronizarTemperatura,
  };
}

module.exports = { criarAtendimento };
