'use strict';

const { decidirAutomacao, montarContextoMinimo, aplicarTemperatura } = require('./conversas');
const { sugerirTemperatura, origemDoCanal } = require('./leads');
const { proximaPergunta, camposPendentes, proximaAcao } = require('./qualificacao');
const { ehPedidoDeOptOut } = require('./lembretes');

// O ciclo de atendimento do crmclinica.
//
// Mensagem chega → grava no banco → decide se a automação pode responder →
// manda contexto mínimo ao OpenClaw → grava a resposta no histórico local.
//
// Três invariantes governam tudo:
//   1. o banco é a fonte de verdade — toda mensagem, de quem for, é gravada aqui;
//   2. quando um humano assume, a automação cala;
//   3. só o contexto mínimo autorizado atravessa para o orquestrador.

/**
 * @param {object} dependencias.serena  Serviço da Serena, opcional.
 *   Quando presente, o interruptor global tem precedência sobre a decisão por
 *   conversa: desligada, ela não responde nada, em conversa nenhuma. Sem o
 *   serviço, vale só a regra por conversa — que é como o sistema funcionava
 *   antes de o interruptor existir.
 */
function criarAtendimento({ repositorio, orquestrador, leads = null, lembretes = null, serena = null, canal = null }) {
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

    // "PARAR" precisa valer na hora. Esperar alguém da equipe ver a mensagem e
    // clicar em algo faria a pessoa que acabou de pedir para não receber nada
    // receber o próximo lembrete — que é exatamente o que ela pediu para evitar.
    if (lembretes && ehPedidoDeOptOut(evento.texto)) {
      try {
        await lembretes.definirOptOut(contato.id, {
          optout: true,
          motivo: 'pedido do contato pelo canal',
          origem: 'contato',
        });
      } catch (erro) {
        console.error(`[atendimento] falha ao registrar opt-out de lembretes: ${erro.message}`);
      }
    }

    // O lead nasce junto da conversa e guarda o vínculo: é o que faz o card do
    // kanban abrir a conversa certa.
    const lead = await repositorio.salvarLead(contato.id, {
      conversaId: conversa.id,
      origem: origemDoCanal(evento.canal),
    });

    // Origem e UTM chegam com o evento quando vêm de formulário ou campanha.
    if (leads && temDadosDeOrigem(evento)) {
      await leads.qualificar(lead.id, evento, { conversaId: conversa.id, origem: 'contato' });
    }
    if (leads) {
      await leads.registrarPrimeiroContato(lead.id, { conversaId: conversa.id, canal: evento.canal });
      await leads.recalcular(await repositorio.obterLead(lead.id), { conversaId: conversa.id });
    }

    await sincronizarTemperatura(conversa.id);

    return responderSePossivel(conversa.id);
  }

  function temDadosDeOrigem(evento) {
    return ['origem_detalhe', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .some((campo) => Boolean(evento[campo]));
  }

  /** Aplica a regra da pausa e, quando permitido, aciona o orquestrador. */
  async function responderSePossivel(conversaId) {
    const conversa = await repositorio.obterConversa(conversaId);

    // Com o serviço da Serena montado, a decisão passa por ele: o interruptor
    // global vem antes da regra por conversa. Note que a mensagem do paciente
    // **já foi gravada** neste ponto — desligar a Serena cala a resposta, não o
    // inbox. É a diferença entre "não respondemos" e "não recebemos".
    const decisao = serena
      ? await serena.podeResponder(conversa)
      : decidirAutomacao(conversa);

    if (!decisao.responder) {
      await repositorio.registrarAuditoria({
        entidade: 'conversa',
        entidadeId: conversaId,
        acao: 'automacao_silenciada',
        detalhe: { motivo: decisao.motivo, escopo: decisao.escopo ?? 'conversa' },
      });
      return {
        acao: 'aguardando_equipe',
        conversa_id: conversaId,
        motivo: decisao.motivo,
        escopo: decisao.escopo ?? 'conversa',
      };
    }

    if (!orquestrador?.disponivel) {
      return { acao: 'sem_orquestrador', conversa_id: conversaId, motivo: 'openclaw_nao_configurado' };
    }

    const mensagens = await repositorio.listarMensagens(conversaId, { incluirPrivadas: false });
    const contexto = montarContextoMinimo(conversa, mensagens);

    // A qualificação vai junto para o orquestrador saber o que já foi perguntado
    // e o que falta — sem isso ele repetiria perguntas já respondidas.
    //
    // Só o que é **comercial**: o que a pessoa procura, se é primeira consulta,
    // forma de pagamento, urgência e horário. Nada clínico atravessa esta linha.
    const lead = await repositorio.obterLeadPorContato(conversa.contato_id);
    if (lead) {
      const pendentes = camposPendentes(lead);
      contexto.qualificacao = {
        interesse: lead.interesse ?? null,
        primeira_consulta: lead.primeira_consulta ?? null,
        pagamento: lead.pagamento ?? null,
        urgencia: lead.urgencia ?? null,
        disponibilidade: lead.disponibilidade ?? null,
        pendentes,
        proxima_pergunta: proximaPergunta(lead)?.pergunta ?? null,
      };
      contexto.lead = {
        estagio: lead.estagio,
        temperatura: lead.temperatura,
        score: lead.score,
      };
    }

    try {
      const resposta = await orquestrador.despacharEvento({
        chave_idempotencia: `conversa:${conversaId}:${mensagens.at(-1)?.id ?? 0}`,
        tipo: 'conversa.mensagem_recebida',
        contexto,
      });

      // O orquestrador pode devolver o que apurou na conversa. Gravar aqui é o
      // que torna a qualificação gradual: uma resposta por vez, sem formulário.
      if (leads && lead && resposta?.qualificacao) {
        await leads.qualificar(lead.id, resposta.qualificacao, {
          conversaId,
          origem: 'automacao',
        });
      }

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

      // A resposta precisa chegar ao paciente. Sem este envio, ela ficava
      // gravada no CRM e nunca saía — a equipe respondia, via a mensagem na
      // tela, e do outro lado ninguém recebia nada.
      const entrega = await entregarAoPaciente(conversa, texto, mensagem.id);
      if (!entrega.enviada) {
        // A mensagem já está gravada. O que falta é a tela saber que ela não
        // saiu — sem isso, quem respondeu fica esperando resposta de alguém que
        // nunca recebeu nada.
        await repositorio.registrarAuditoria({
          entidade: 'conversa',
          entidadeId: conversaId,
          acao: 'resposta_nao_entregue',
          detalhe: { mensagem_id: mensagem.id, motivo: entrega.motivo },
          usuarioId,
        }).catch(() => {});

        return { ...mensagem, enviada: false, motivo_falha: entrega.motivo };
      }

      return { ...mensagem, enviada: true, id_externo: entrega.identificador ?? null };
    }

    return mensagem;
  }

  /**
   * Entrega ao paciente pelo canal de onde a conversa veio.
   *
   * Falha de envio não desfaz o registro: a resposta da equipe é um fato que
   * aconteceu, e apagá-la esconderia da própria equipe o que ela já escreveu.
   * O que muda é a marca — enviada ou não —, para a tela poder dizer a verdade.
   */
  async function entregarAoPaciente(conversa, texto, mensagemId) {
    if (!canal?.enviar) return { enviada: false, motivo: 'canal_nao_configurado' };

    try {
      const contato = await repositorio.obterContato(conversa.contato_id);
      if (!contato?.telefone) return { enviada: false, motivo: 'contato_sem_telefone' };

      const resultado = await canal.enviar({
        telefone: contato.telefone,
        texto,
        // Determinística: um clique duplo, ou uma retentativa da rede, não faz
        // o paciente receber a mesma resposta duas vezes.
        chave: `equipe:${conversa.id}:${mensagemId}`,
      });

      return { enviada: true, identificador: resultado?.identificador ?? null };
    } catch (erro) {
      return { enviada: false, motivo: erro.message };
    }
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
