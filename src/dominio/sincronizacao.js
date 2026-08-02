'use strict';

const {
  decidirAutomacao,
  montarContextoMinimo,
  aplicarTemperatura,
  lerTemperatura,
  ETIQUETA_ATENDIMENTO_HUMANO,
} = require('./conversas');
const { projetarLead, sugerirTemperatura } = require('./leads');

// Orquestra o trânsito Chatwoot → crmclinica → OpenClaw → Chatwoot.
//
// Três invariantes governam tudo aqui:
//   1. o Chatwoot é o inbox — a resposta da automação volta para a conversa dele;
//   2. quando um humano assume, a automação cala;
//   3. só o contexto mínimo autorizado atravessa para o orquestrador.

/**
 * Cria o sincronizador.
 * As dependências entram por parâmetro para que os testes rodem sem rede e sem token real.
 */
function criarSincronizador({ chatwoot, orquestrador, auditoria = [] } = {}) {
  function registrar(acao, detalhe) {
    const registro = { acao, ...detalhe, em: new Date().toISOString() };
    auditoria.push(registro);
    return registro;
  }

  /**
   * Trata um evento já validado pelo contrato do Chatwoot.
   * Devolve a decisão tomada — nunca lança por decisão de negócio.
   */
  async function tratarEvento(evento) {
    switch (evento.evento) {
      case 'message_created':
        return tratarMensagem(evento);
      case 'assignee_changed':
        return tratarAtribuicao(evento);
      case 'conversation_status_changed':
        return tratarMudancaDeEstado(evento);
      case 'conversation_created':
      case 'conversation_updated':
        return sincronizarLead(evento);
      case 'contact_created':
      case 'contact_updated':
        return { acao: 'contato_sincronizado', contato_id: evento.contato.id };
      default:
        return { acao: 'ignorado', evento: evento.evento };
    }
  }

  /**
   * Mensagem nova na conversa.
   *
   * Mensagem da equipe é o sinal mais forte de que um humano entrou: a automação
   * para imediatamente, sem esperar a atribuição formal chegar.
   */
  async function tratarMensagem(evento) {
    const { mensagem, conversa } = evento;

    if (mensagem?.privada) {
      return registrar('nota_interna_ignorada', { conversa_id: evento.conversa_id });
    }

    if (mensagem?.direcao === 'outgoing') {
      const daEquipe = mensagem.autor_tipo === 'user' || mensagem.autor_tipo === 'agent';
      if (daEquipe) {
        return registrar('automacao_pausada', {
          conversa_id: evento.conversa_id,
          motivo: 'humano_respondeu',
        });
      }
      return registrar('resposta_da_automacao_registrada', { conversa_id: evento.conversa_id });
    }

    // Mensagem do paciente: decide se a automação pode responder.
    const decisao = decidirAutomacao(conversa);
    if (!decisao.responder) {
      return registrar('encaminhado_para_equipe', {
        conversa_id: evento.conversa_id,
        motivo: decisao.motivo,
      });
    }

    if (!orquestrador?.disponivel) {
      return registrar('sem_orquestrador', {
        conversa_id: evento.conversa_id,
        motivo: 'openclaw_nao_configurado',
      });
    }

    const contexto = montarContextoMinimo(
      { ...conversa, contato: evento.contato },
      [{ autor: 'contato', texto: mensagem.texto, criadaEm: evento.ocorrido_em }],
    );

    try {
      const resposta = await orquestrador.despacharEvento({
        chave_idempotencia: evento.chave_idempotencia,
        tipo: 'conversa.mensagem_recebida',
        contexto,
      });

      // A resposta do orquestrador volta para a conversa do Chatwoot, nunca para
      // um canal próprio: a equipe precisa ver tudo em um lugar só.
      const texto = resposta?.resposta || resposta?.texto;
      if (texto && chatwoot?.disponivel) {
        await chatwoot.responder(evento.conversa_id, texto);
        return registrar('respondido_pela_automacao', { conversa_id: evento.conversa_id });
      }

      if (resposta?.escalonar) {
        await escalonarParaEquipe(evento.conversa_id, conversa, resposta.motivo);
        return registrar('escalonado', { conversa_id: evento.conversa_id, motivo: resposta.motivo });
      }

      return registrar('sem_resposta_do_orquestrador', { conversa_id: evento.conversa_id });
    } catch (erro) {
      // Falha do orquestrador não pode travar o atendimento: escala para a equipe.
      await escalonarParaEquipe(evento.conversa_id, conversa, 'falha_no_orquestrador');
      return registrar('escalonado_por_falha', {
        conversa_id: evento.conversa_id,
        codigo: erro.codigo || 'desconhecido',
      });
    }
  }

  /** Atribuição mudou: com responsável, a automação sai de cena. */
  async function tratarAtribuicao(evento) {
    if (evento.conversa.responsavel) {
      return registrar('automacao_pausada', {
        conversa_id: evento.conversa_id,
        motivo: 'humano_assumiu',
        responsavel: evento.conversa.responsavel.nome,
      });
    }
    return registrar('automacao_liberada', {
      conversa_id: evento.conversa_id,
      motivo: 'conversa_sem_responsavel',
    });
  }

  async function tratarMudancaDeEstado(evento) {
    const estado = evento.conversa.estado;
    if (estado === 'resolved') {
      const lead = projetarLead({ ...evento.conversa, contato: evento.contato });
      return registrar('conversa_resolvida', { conversa_id: evento.conversa_id, lead_estado: lead.estado });
    }
    if (estado === 'open') {
      return registrar('conversa_reaberta', { conversa_id: evento.conversa_id });
    }
    return registrar('estado_atualizado', { conversa_id: evento.conversa_id, estado });
  }

  /** Projeta a conversa como lead e sincroniza a etiqueta de temperatura. */
  async function sincronizarLead(evento) {
    const conversa = { ...evento.conversa, contato: evento.contato };
    const lead = projetarLead(conversa);
    const sugestao = sugerirTemperatura(conversa);

    // A etiqueta posta pela equipe é soberana: só escrevemos quando não há nenhuma.
    if (sugestao.origem !== 'etiqueta_da_equipe' && chatwoot?.disponivel) {
      const etiquetas = aplicarTemperatura(conversa.etiquetas, sugestao.temperatura);
      await chatwoot.definirEtiquetas(evento.conversa_id, etiquetas);
    }

    return registrar('lead_sincronizado', {
      conversa_id: evento.conversa_id,
      telefone: lead.telefone,
      temperatura: sugestao.temperatura,
      temperatura_origem: sugestao.origem,
    });
  }

  /**
   * Passa a conversa para a equipe: marca a etiqueta de atendimento humano
   * e devolve para a fila aberta.
   */
  async function escalonarParaEquipe(conversaId, conversa = {}, motivo = 'escalonamento') {
    if (!chatwoot?.disponivel) return { escalonado: false, motivo: 'chatwoot_nao_configurado' };

    const etiquetas = conversa.etiquetas || [];
    if (!etiquetas.includes(ETIQUETA_ATENDIMENTO_HUMANO)) {
      await chatwoot.definirEtiquetas(conversaId, [...etiquetas, ETIQUETA_ATENDIMENTO_HUMANO]);
    }
    if (chatwoot.timeId) {
      await chatwoot.atribuirTime(conversaId, chatwoot.timeId);
    }

    return { escalonado: true, motivo };
  }

  /** Define a temperatura manualmente, preservando as demais etiquetas. */
  async function definirTemperatura(conversaId, temperatura) {
    const atuais = await chatwoot.listarEtiquetasDaConversa(conversaId);
    const etiquetas = aplicarTemperatura(atuais, temperatura);
    await chatwoot.definirEtiquetas(conversaId, etiquetas);

    return registrar('temperatura_definida', {
      conversa_id: conversaId,
      temperatura: lerTemperatura(etiquetas),
      preservadas: atuais.length,
    });
  }

  return {
    tratarEvento,
    escalonarParaEquipe,
    definirTemperatura,
    auditoria,
  };
}

module.exports = { criarSincronizador };
