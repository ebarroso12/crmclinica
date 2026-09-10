'use strict';

const { normalizarConfiguracoes } = require('./regras');

// Fluxo de atendimento dos agentes configuráveis (docs/AGENTES.md).
//
// Vive fora de `atendimento.js` de propósito: aquele arquivo carrega o
// caminho da clínica, com anos de correção acumulada em cada linha, e a regra
// número 1 dos agentes é "a clínica não muda". O atendimento só pergunta
// "esta conversa é de um agente?" e, se for, delega para cá — reaproveitando
// as MESMAS peças que já protegem o paciente: `entregar` (a barreira final
// que relê o controle antes de todo envio, as marcas de entregue/incerto) e
// `escalonar` (nada some em silêncio).
//
// O que este fluxo garante, e onde:
//   - um inbound → no máximo uma resposta: `id_externo` determinístico
//     (`agente:{id}:resposta:{conversa}:{entrada}`, partes com `:pN`) e a
//     mesma chave na chamada de IA;
//   - retentativa depois de queda no meio do caminho refaz a geração pela
//     MESMA chave (o gateway devolve o resultado gravado, sem nova cobrança),
//     retoma as partes que não saíram e conclui a transferência pedida — antes
//     ela reentregava só o que estava gravado e dava por "respondida",
//     perdendo transferência e partes (achado ALTO 1 da auditoria);
//   - rajada de mensagens vira uma resposta só (o atraso de
//     `tempo_resposta_segundos` é aplicado ao enfileirar, `atrasoDeResposta`);
//   - limite de interações e ação ao atingir;
//   - transferência para a equipe com resumo em nota privada;
//   - ações de inatividade idempotentes por chave, com cursor (nenhuma
//     conversa fica para sempre fora da varredura) e teto de tempo por passada;
//   - auditoria com nomes próprios (`agente_*`): as métricas, a view analítica
//     e o alerta crítico da Serena contam `respondida_pela_automacao`,
//     `resposta_nao_entregue` etc. — o agente não pode acender sinal da clínica.
//
// O que NÃO está provado aqui: nada disto chama modelo ou Evolution de
// verdade — os testes usam motor e canal falsos, e a concorrência entre
// processos só se prova contra PostgreSQL real.

const MARCA_INATIVIDADE = ':inatividade:';
const ESCALONAR_COMO_AGENTE = Object.freeze({ acaoDeAuditoria: 'agente_escalonada' });

function textoValido(parte) {
  return typeof parte === 'string' && parte.trim().length > 0;
}

function criarFluxoDeAgentes({
  repositorio, agentes = null, emissor = null, entregar, escalonar,
  instanciasDaClinica = [], agora = () => new Date(),
}) {
  if (!repositorio) throw new Error('o fluxo de agentes exige o repositório');
  if (typeof entregar !== 'function' || typeof escalonar !== 'function') {
    throw new Error('o fluxo de agentes exige entregar e escalonar');
  }

  const instanciasConhecidasDaClinica = new Set(
    (instanciasDaClinica ?? []).map((nome) => String(nome).trim().toLowerCase()).filter(Boolean),
  );
  let cursorDeInatividade = 0;

  /** Auditoria nunca derruba o atendimento — e nunca carrega texto de conversa. */
  async function auditar(conversaId, acao, detalhe) {
    try {
      await repositorio.registrarAuditoria({ entidade: 'conversa', entidadeId: conversaId, acao, detalhe });
    } catch (erro) {
      console.error(`[agentes] falha ao auditar "${acao}": ${erro.message}`);
    }
  }

  function escalonarAgente(conversaId, motivo) {
    return escalonar(conversaId, motivo, ESCALONAR_COMO_AGENTE);
  }

  async function registrarAvisoPrivado(conversaId, conteudo, idExterno = null) {
    const { mensagem, duplicada } = await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      tipo: 'sistema',
      conteudo,
      autor_tipo: 'sistema',
      privada: true,
      ...(idExterno ? { id_externo: idExterno } : {}),
    });
    if (!duplicada) emissor?.publicarMensagem(conversaId, mensagem);
    return mensagem;
  }

  /**
   * Dono da instância por onde a mensagem entrou. Com `incluirInativos`:
   * uma instância que é de um agente, com o canal desligado, continua sendo
   * dele — cair no fluxo da clínica faria a Serena responder um cliente do
   * agente pelo número da clínica.
   */
  async function agenteDoCanal(canal, instancia) {
    if (!instancia || !repositorio.obterAgentePorCanal) return null;
    return repositorio.obterAgentePorCanal(canal, instancia, { incluirInativos: true });
  }

  /**
   * Instância que não é da clínica e (quem chama já conferiu) não é de agente
   * nenhum. Só decide quando a lista da clínica foi configurada: sem ela, a
   * única resposta segura é "não sei" — tratar a instância da própria clínica
   * como estranha, por um nome de configuração diferente do real, calaria o
   * atendimento de pacientes.
   */
  function instanciaSemDono(instancia) {
    if (!instancia || instanciasConhecidasDaClinica.size === 0) return false;
    return !instanciasConhecidasDaClinica.has(String(instancia).trim().toLowerCase());
  }

  /** Quando o trabalho da outbox deve ficar disponível: agora + tempo de resposta do agente. */
  function atrasoDeResposta(agente) {
    const segundos = normalizarConfiguracoes(agente?.configuracoes).tempo_resposta_segundos;
    return segundos > 0 ? new Date(agora().getTime() + segundos * 1000).toISOString() : null;
  }

  /** A mesma pergunta que a barreira final faz à Serena, feita ao agente da conversa. */
  async function decidir(conversa) {
    if (!agentes) return { responder: false, motivo: 'motor_de_agentes_nao_configurado' };
    const agente = await repositorio.obterAgente(conversa.agente_id);
    return agentes.decidir(conversa, agente);
  }

  /**
   * Instância da Evolution por onde a conversa do agente sai. `null` quando o
   * agente não tem canal ativo daquele tipo — e aí não se envia nada: sair
   * pela instância padrão seria responder pelo número da clínica.
   */
  async function instanciaDeEnvio(conversa) {
    const agente = await repositorio.obterAgente(conversa.agente_id);
    const canal = agente?.canais?.find((item) => item.canal === conversa.canal && item.ativo !== false);
    return canal ? canal.instancia : null;
  }

  /**
   * Entrega uma parte já gravada. `parada` preenchida = o fluxo precisa
   * parar e devolver esse desfecho (mesmos desfechos do caminho da Serena,
   * para a outbox decidir igual).
   */
  async function entregarParte(conversa, mensagem) {
    const entrega = await entregar(conversa, mensagem.conteudo, mensagem.id, { origem: 'agente' });

    if (entrega.motivo === 'envio_abortado_por_controle') {
      return {
        enviada: false,
        parada: {
          acao: 'resposta_abortada_por_controle', conversa_id: conversa.id, motivo: entrega.motivoControle, entregue: false,
        },
      };
    }

    // Sem canal nenhum configurado (desenvolvimento) não é falha de envio — mesma
    // leitura do caminho da Serena.
    if (!entrega.enviada && entrega.motivo !== 'canal_nao_configurado') {
      await auditar(conversa.id, 'agente_resposta_nao_entregue', {
        mensagem_id: mensagem.id, motivo: entrega.motivo, indeterminado: entrega.indeterminado === true,
      });
      await escalonarAgente(conversa.id, 'falha_na_entrega_da_automacao');
      return {
        enviada: false,
        parada: {
          acao: 'escalonada_por_falha_entrega',
          conversa_id: conversa.id,
          motivo: entrega.motivo,
          entregue: false,
          entregaIncerta: entrega.indeterminado === true,
        },
      };
    }

    return { enviada: entrega.enviada === true, parada: null };
  }

  /**
   * Grava e entrega as partes em ordem.
   *
   * Parte que já existe (`duplicada`) tem dois significados, e quem chama diz
   * qual vale:
   *   - `retomar: true` (resposta a um inbound): é a MESMA resposta de uma
   *     tentativa anterior que caiu no meio — o trabalho da outbox só volta a
   *     um worker quando o anterior perdeu o lease. Parte já entregue fica como
   *     está; entrega incerta nunca é repetida sozinha; o resto é entregue agora.
   *   - `retomar: false` (inatividade): não há lease protegendo a varredura, e
   *     duplicada ali é outra cópia do worker no meio da mesma ação — quem
   *     gravou primeiro entrega, esta desiste.
   */
  async function gravarEEntregar(conversa, agente, partes, chave, { retomar }) {
    const mensagemIds = [];
    let todasEnviadas = true;

    for (const [indice, parte] of partes.entries()) {
      const { mensagem, duplicada } = await repositorio.registrarMensagem(conversa.id, {
        direcao: 'saida',
        conteudo: parte,
        autor_tipo: 'automacao',
        autor_nome: agente.nome,
        id_externo: indice === 0 ? chave : `${chave}:p${indice + 1}`,
      });

      if (duplicada) {
        if (!retomar) return { parada: null, mensagemIds, todasEnviadas: false, concorrente: true };
        if (mensagem.entregue_em) {
          mensagemIds.push(mensagem.id);
          continue;
        }
        if (mensagem.entrega_indeterminada) {
          return {
            parada: {
              acao: 'escalonada_por_falha_entrega',
              conversa_id: conversa.id,
              motivo: 'entrega_indeterminada',
              entregue: false,
              entregaIncerta: true,
            },
            mensagemIds,
            todasEnviadas: false,
          };
        }
      } else {
        emissor?.publicarMensagem(conversa.id, mensagem);
      }

      const { enviada, parada } = await entregarParte(conversa, mensagem);
      if (parada) return { parada, mensagemIds, todasEnviadas: false };
      if (!enviada) todasEnviadas = false;
      mensagemIds.push(mensagem.id);
    }

    return { parada: null, mensagemIds, todasEnviadas };
  }

  /**
   * Passa a conversa para a equipe. É `assumir` sem dono: a automação cala
   * até alguém devolver. Idempotente: conversa já com a equipe não recebe
   * segundo aviso nem segundo resumo. O resumo vai em nota privada — o motivo
   * em prosa do modelo pode repetir o que o cliente disse, então fica na
   * conversa (que a equipe já lê) e nunca na auditoria.
   */
  async function transferir(conversa, agente, configuracoes, motivo, motivoDoModelo = null) {
    const conversaId = conversa.id;
    const transicao = repositorio.assumirConversaSeNecessario
      ? await repositorio.assumirConversaSeNecessario(conversaId, { usuarioId: null, pausaAte: null })
      : await repositorio.atualizarConversa(conversaId, {
        assumida_por_humano: true, atribuido_a: null, ia_pausada_ate: null, status: 'aberta',
      });
    if (!transicao) return false;

    const porque = motivo === 'limite_de_interacoes' ? 'limite de interações atingido' : 'pedido do agente';
    await registrarAvisoPrivado(
      conversaId,
      `${agente.nome} transferiu a conversa para a equipe (${porque}). A resposta automática está pausada.`,
    );
    emissor?.publicarConversaAssumida?.(conversaId, { usuarioId: null });

    if (configuracoes.resumo_ao_transferir && agentes?.gerarResumo) {
      try {
        const historico = await repositorio.listarMensagens(conversaId, { incluirPrivadas: false });
        const ultimaId = historico.at(-1)?.id ?? 0;
        const chaveResumo = `agente:${agente.id}:resumo:${conversaId}:${ultimaId}`;
        const resumo = await agentes.gerarResumo({ agente, mensagens: historico, chaveIdempotencia: chaveResumo });
        const texto = [
          textoValido(motivoDoModelo) ? `Motivo apontado pelo agente: ${motivoDoModelo.trim()}` : null,
          textoValido(resumo) ? resumo.trim() : null,
        ].filter(Boolean).join('\n\n');
        if (texto) await registrarAvisoPrivado(conversaId, `Resumo para a equipe:\n${texto}`, chaveResumo);
      } catch (erro) {
        // Sem resumo a transferência continua valendo: a conversa já está com a equipe.
        console.error(`[agentes] resumo da transferência não gerado (conversa ${conversaId}): ${erro.message}`);
      }
    }

    await auditar(conversaId, 'transferida_para_humano', { agente_id: agente.id, motivo });
    return true;
  }

  /**
   * Resolve a conversa. A transição é atômica (`definirStatusSeNecessario`):
   * duas cópias do worker chegando juntas produzem UM aviso e UMA auditoria,
   * não dois (achado BAIXO 6 da auditoria).
   */
  async function finalizar(conversa, agente, motivo, extra = {}) {
    const transicao = repositorio.definirStatusSeNecessario
      ? await repositorio.definirStatusSeNecessario(conversa.id, 'resolvida')
      : await repositorio.atualizarConversa(conversa.id, { status: 'resolvida' });
    if (!transicao) return false;

    const texto = motivo === 'inatividade'
      ? `Atendimento finalizado por ${agente.nome}: o cliente não respondeu em ${extra.apos_minutos} min.`
      : `Atendimento finalizado por ${agente.nome}: limite de interações atingido.`;
    await registrarAvisoPrivado(conversa.id, texto);
    await auditar(conversa.id, motivo === 'inatividade' ? 'finalizada_por_inatividade' : 'finalizada_por_limite', {
      agente_id: agente.id, ...extra,
    });
    return true;
  }

  /** Responde a um inbound de uma conversa de agente. Mesmos desfechos do caminho da Serena. */
  async function responder(conversa, { mensagemEntradaId = null } = {}) {
    const conversaId = conversa.id;

    if (!agentes) {
      // Falta de configuração não é transitória: escala, não retenta.
      await escalonarAgente(conversaId, 'motor_de_agentes_nao_configurado');
      return { acao: 'escalonada_para_equipe', conversa_id: conversaId, motivo: 'motor_de_agentes_nao_configurado' };
    }

    const agente = await repositorio.obterAgente(conversa.agente_id);
    const decisao = agentes.decidir(conversa, agente);
    if (!decisao.responder) {
      await auditar(conversaId, 'agente_automacao_silenciada', {
        motivo: decisao.motivo, agente_id: conversa.agente_id,
      });
      return { acao: 'aguardando_equipe', conversa_id: conversaId, motivo: decisao.motivo, escopo: 'agente' };
    }

    const configuracoes = normalizarConfiguracoes(agente.configuracoes);
    const mensagens = await repositorio.listarMensagens(conversaId, { incluirPrivadas: false });
    const entradaMaisNova = mensagens.filter((mensagem) => mensagem.direcao === 'entrada').at(-1) ?? null;
    const entradaId = mensagemEntradaId ?? entradaMaisNova?.id ?? 0;

    if (mensagemEntradaId && entradaMaisNova && Number(entradaMaisNova.id) > Number(mensagemEntradaId)) {
      return {
        acao: 'agrupada_com_mensagem_posterior', conversa_id: conversaId, mensagem_entrada_id: Number(mensagemEntradaId),
      };
    }

    const chave = `agente:${agente.id}:resposta:${conversaId}:${entradaId}`;
    const retomada = mensagens.some((mensagem) => mensagem.id_externo === chave
      || String(mensagem.id_externo ?? '').startsWith(`${chave}:p`));

    // Na retomada o limite não é reavaliado: a resposta que está sendo
    // concluída já foi autorizada, e as partes dela já contam no total.
    // Partes de uma resposta dividida contam uma a uma — o limite é de
    // mensagens automáticas, que é o que o cliente vê chegar.
    if (!retomada && configuracoes.limite_interacoes !== null && repositorio.contarRespostasDaAutomacao) {
      const respostas = await repositorio.contarRespostasDaAutomacao(conversaId);
      if (respostas >= configuracoes.limite_interacoes) {
        if (configuracoes.acao_limite === 'finalizar') {
          await finalizar(conversa, agente, 'limite_de_interacoes', { limite: configuracoes.limite_interacoes });
          return { acao: 'finalizada_por_limite', conversa_id: conversaId };
        }
        await transferir(conversa, agente, configuracoes, 'limite_de_interacoes');
        return { acao: 'transferida_por_limite', conversa_id: conversaId };
      }
    }

    const contato = conversa.contato ?? (await repositorio.obterContato(conversa.contato_id));
    const treinamentos = await repositorio.listarTreinamentos(agente.id);

    let geracao;
    try {
      // Mesma chave na retomada: o gateway devolve a resposta já gerada, e é
      // ela que diz quantas partes existem e se havia transferência a concluir.
      geracao = await agentes.gerarResposta({
        agente, treinamentos, mensagens, contato, chaveIdempotencia: chave,
      });
    } catch (erro) {
      await escalonarAgente(conversaId, 'falha_no_motor_do_agente');
      return { acao: 'escalonada_por_falha', conversa_id: conversaId, codigo: erro.codigo || 'desconhecido' };
    }

    const partes = (geracao?.partes ?? []).filter(textoValido);
    const pediuTransferencia = geracao?.transferir === true;

    if (partes.length === 0 && !pediuTransferencia) {
      await auditar(conversaId, 'agente_sem_resposta', { motivo: 'motor_ia_sem_resposta', agente_id: agente.id });
      await escalonarAgente(conversaId, 'motor_ia_sem_resposta');
      return { acao: 'sem_resposta_do_agente', conversa_id: conversaId, motivo: 'motor_ia_sem_resposta' };
    }

    const { parada, mensagemIds, todasEnviadas } = await gravarEEntregar(conversa, agente, partes, chave, { retomar: true });
    if (parada) return parada;

    if (pediuTransferencia) {
      await transferir(conversa, agente, configuracoes, 'pedido_do_agente', geracao.motivo ?? null);
    }

    await auditar(conversaId, 'agente_respondida', {
      agente_id: agente.id, mensagem_ids: mensagemIds, transferida: pediuTransferencia, retomada,
    });
    return {
      acao: pediuTransferencia ? 'respondida_e_transferida' : 'respondida_pela_automacao',
      conversa_id: conversaId,
      entregue: todasEnviadas,
      partes: mensagemIds.length,
      ...(retomada ? { duplicada: true } : {}),
    };
  }

  /**
   * Uma conversa candidata a ação de inatividade. O relógio conta a partir da
   * última resposta do agente que NÃO é ela mesma uma ação de inatividade —
   * senão cada "ainda está aí?" reiniciaria o prazo e o "finalizar" nunca
   * chegaria. Uma ação por passada, a de menor prazo ainda não feita.
   */
  async function tratarInatividade(candidata, cacheDeAgentes) {
    if (!cacheDeAgentes.has(candidata.agente_id)) {
      cacheDeAgentes.set(candidata.agente_id, await repositorio.obterAgente(candidata.agente_id));
    }
    const agente = cacheDeAgentes.get(candidata.agente_id);
    if (!agente || agente.status !== 'ativo') return 'ignorada';

    const acoes = [...(agente.acoes_inatividade ?? [])].sort((a, b) => a.apos_minutos - b.apos_minutos);
    if (acoes.length === 0) return 'ignorada';

    const conversa = await repositorio.obterConversa(candidata.conversa_id);
    if (!conversa || conversa.status === 'resolvida' || conversa.assumida_por_humano || conversa.atribuido_a) {
      return 'ignorada';
    }

    const mensagens = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: false });
    const indiceUltimaEntrada = mensagens.map((mensagem) => mensagem.direcao === 'entrada').lastIndexOf(true);
    const depois = mensagens.slice(indiceUltimaEntrada + 1);
    // Equipe escreveu depois do cliente: quem está conduzindo é gente, não o agente.
    if (depois.length === 0 || depois.some((mensagem) => mensagem.autor_tipo !== 'automacao')) return 'ignorada';

    const ancora = [...depois].reverse()
      .find((mensagem) => !String(mensagem.id_externo ?? '').includes(MARCA_INATIVIDADE));
    if (!ancora) return 'ignorada';

    const minutos = (agora().getTime() - new Date(ancora.criado_em).getTime()) / 60000;
    const base = `agente:${agente.id}${MARCA_INATIVIDADE}${conversa.id}:${ancora.id}`;
    const feitas = new Set(depois
      .map((mensagem) => String(mensagem.id_externo ?? ''))
      .filter((id) => id.startsWith(`${base}:`))
      .map((id) => Number(id.slice(base.length + 1).split(':')[0])));

    const devida = acoes.find((acao) => minutos >= acao.apos_minutos && !feitas.has(acao.apos_minutos));
    if (!devida) return 'ignorada';

    if (devida.acao === 'finalizar') {
      const finalizou = await finalizar(conversa, agente, 'inatividade', { apos_minutos: devida.apos_minutos });
      return finalizou ? 'finalizada' : 'ignorada';
    }

    // Falar com o cliente passa pelas mesmas regras de uma resposta (horário, controle).
    if (!agentes.decidir(conversa, agente).responder) return 'ignorada';

    const chave = `${base}:${devida.apos_minutos}`;
    const contato = conversa.contato ?? (await repositorio.obterContato(conversa.contato_id));
    const treinamentos = await repositorio.listarTreinamentos(agente.id);
    const gerado = await agentes.gerarFollowup({
      agente, treinamentos, mensagens, contato, instrucao: devida.instrucao, chaveIdempotencia: chave,
    });
    const partes = (gerado?.partes ?? []).filter(textoValido);
    if (partes.length === 0) return 'ignorada';

    const { parada, concorrente } = await gravarEEntregar(conversa, agente, partes, chave, { retomar: false });
    if (parada || concorrente) return 'ignorada';

    await auditar(conversa.id, 'interacao_por_inatividade', { agente_id: agente.id, apos_minutos: devida.apos_minutos });
    return 'interagiu';
  }

  /**
   * Uma passada de inatividade.
   *
   * Cursor por id de conversa: cada passada continua de onde a anterior parou
   * e volta ao começo ao chegar no fim. Sem isso, conversas que nunca terão
   * ação ocupavam o topo da lista para sempre e escondiam as outras (achado
   * MÉDIO 3 da auditoria). O teto de tempo impede uma passada lenta (IA fora
   * do ar em "interagir") de virar um laço de minutos. Uma conversa que falha
   * não leva as outras junto.
   */
  async function processarInatividade({ limite = 20, orcamentoMs = 20000 } = {}) {
    const resumo = { verificadas: 0, finalizadas: 0, interacoes: 0, ignoradas: 0, falhas: 0, adiadas: 0 };
    if (!agentes || !repositorio.listarConversasDeAgenteParaInatividade) return resumo;

    const inicio = Date.now();
    const candidatas = await repositorio.listarConversasDeAgenteParaInatividade({
      limite, aposConversaId: cursorDeInatividade,
    });
    const cacheDeAgentes = new Map();
    let ultimaTratada = cursorDeInatividade;

    for (const candidata of candidatas) {
      if (Date.now() - inicio > orcamentoMs) {
        resumo.adiadas = candidatas.length - resumo.verificadas;
        break;
      }
      resumo.verificadas += 1;
      try {
        const desfecho = await tratarInatividade(candidata, cacheDeAgentes);
        if (desfecho === 'finalizada') resumo.finalizadas += 1;
        else if (desfecho === 'interagiu') resumo.interacoes += 1;
        else resumo.ignoradas += 1;
      } catch (erro) {
        resumo.falhas += 1;
        console.error(`[agentes] inatividade da conversa ${candidata.conversa_id} falhou: ${erro.message}`);
      }
      ultimaTratada = candidata.conversa_id;
    }

    // Lista incompleta e tudo tratado = chegou ao fim: a próxima passada recomeça.
    cursorDeInatividade = resumo.adiadas === 0 && candidatas.length < limite ? 0 : ultimaTratada;
    return resumo;
  }

  return {
    agenteDoCanal,
    instanciaSemDono,
    atrasoDeResposta,
    decidir,
    instanciaDeEnvio,
    responder,
    transferir,
    finalizar,
    processarInatividade,
  };
}

module.exports = { criarFluxoDeAgentes, MARCA_INATIVIDADE };
