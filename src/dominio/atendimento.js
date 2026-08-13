'use strict';

const { decidirAutomacao, montarContextoMinimo, aplicarTemperatura } = require('./conversas');
const { sugerirTemperatura, origemDoCanal } = require('./leads');
const { proximaPergunta, camposPendentes, proximaAcao } = require('./qualificacao');
const { ehPedidoDeOptOut } = require('./lembretes');
const { ErroDeEstrategia } = require('../contratos/erros');

// Comando 7, achado A-3 da auditoria: a barreira final (`podeEntregarAgora`)
// bloqueia por vários motivos, mas até aqui NENHUM deles escalonava — a
// automação gerava uma resposta, a barreira descartava, e a conversa
// continuava do jeito que estava, sem ninguém saber que uma resposta ficou
// presa. Isso está certo para motivos que já SÃO uma decisão humana recente
// (a equipe apertou um botão e sabe o que decidiu) — escalonar de novo seria
// ruído. Está errado para os demais: grade automática, ativação gradual,
// conversa que virou "resolvida" no meio do caminho, ou falha ao reler o
// próprio controle — nesses casos ninguém decidiu nada na hora, e a resposta
// gerada fica perdida sem aviso.
//
// `humano_responsavel` e `ia_pausada` entram na lista pelo mesmo raciocínio
// de `assumida_por_humano`/`serena_pausada`: também são estado que uma pessoa
// já decidiu. Qualquer motivo NÃO listado aqui (presente ou futuro) escalona
// por padrão — fail-open para avisar gente, nunca fail-closed para o silêncio.
const MOTIVOS_DE_DECISAO_HUMANA_RECENTE = new Set([
  'serena_desligada', 'serena_pausada', 'assumida_por_humano', 'humano_responsavel', 'ia_pausada',
]);

function bloqueioDaBarreiraPrecisaEscalar(motivo) {
  return !MOTIVOS_DE_DECISAO_HUMANA_RECENTE.has(motivo);
}

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
 * @param {object} dependencias.emissor  Barramento de eventos do inbox, opcional.
 *   Cada mensagem gravada aqui é anunciada nele — é o que faz a tela de
 *   Conversas atualizar sozinha, sem esperar o próximo ciclo de novo pedido.
 *   Sem ele, o atendimento funciona igual; só ninguém é avisado ao vivo.
 * @param {object} dependencias.qualificacaoIa  `criarExtratorDeQualificacao`, opcional.
 *   Sem ele, a qualificação segue 100% passiva (só o que a equipe, a API ou o
 *   formulário mandarem) — comportamento idêntico ao de antes desta dependência
 *   existir.
 */
function criarAtendimento({
  repositorio, orquestrador, leads = null, lembretes = null, serena = null, canal = null, emissor = null,
  qualificacaoIa = null,
}) {
  /**
   * Recebe uma mensagem de canal: garante contato e conversa, grava e decide.
   * O `id_externo` sustenta a idempotência — reentrega do canal não duplica linha.
   *
   * `despachoEmSegundoPlano`: a gravação é síncrona sempre; com esta opção, a
   * resposta da IA (que pode levar dezenas de segundos) roda DEPOIS do retorno.
   * Existe para a porta de ingresso: o hook do OpenClaw espera no máximo 10s
   * pelo aceite, e segurar a conexão durante o despacho fazia toda entrega
   * "falhar" no lado do plugin e ser reagendada — funcionava, mas por acidente.
   * Se o despacho em segundo plano morrer, a conversa escala para a equipe.
   */
  async function receberMensagem(evento, { despachoEmSegundoPlano = false } = {}) {
    // Defesa em profundidade: a porta HTTP já recusa WhatsApp sem dono, mas
    // este método tem outros chamadores — e um deles esquecer o carimbo não
    // pode virar resposta duplicada ao paciente. Falha ANTES de gravar de
    // propósito: quem chamou errado precisa ver o erro, não um sucesso parcial.
    // O sincronizador oficial sempre carimba, então nada legítimo cai aqui.
    if (evento.canal === 'whatsapp' && !evento.estrategia_ia) {
      throw new ErroDeEstrategia(
        'evento de WhatsApp precisa declarar quem responde por ele',
        'estrategia_ia_ambigua',
      );
    }

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

    // Anuncia assim que a mensagem existe no banco, antes de qualquer decisão
    // de automação — quem está com a tela aberta precisa ver o paciente
    // escrevendo, não só a eventual resposta da Serena minutos depois.
    emissor?.publicarMensagem(conversa.id, mensagem);

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

    // Mensagem que o agente do canal já gerencia: o trabalho do CRM termina na
    // importação. Nada de sessions.list, chat.send ou espera por resposta — o
    // agente já respondeu (ou vai responder) no próprio canal, e redespachar
    // aqui é o que fazia a mesma pergunta ser processada duas vezes.
    if (evento.estrategia_ia === 'openclaw_gerencia') {
      await repositorio.registrarAuditoria({
        entidade: 'conversa',
        entidadeId: conversa.id,
        acao: 'importada_do_canal',
        detalhe: { canal: evento.canal, estrategia_ia: evento.estrategia_ia },
      });
      return {
        acao: 'importada_do_canal',
        ia_despachada: false,
        conversa_id: conversa.id,
        mensagem_id: mensagem.id,
      };
    }

    if (despachoEmSegundoPlano) {
      // Comando 3: era `setImmediate` aqui — uma promessa sem garantia
      // nenhuma numa função serverless da Vercel, que pode ser congelada ou
      // encerrada assim que a resposta HTTP sai. Agora é um trabalho gravado
      // na outbox durável (`automacao_outbox`, db/031), na MESMA transação
      // que já gravou a mensagem — quem chama isto (a rota do webhook) faz
      // essa transação existir, com `repositorio.comUsuario`. O `202` que a
      // rota devolve depois disto só sai depois do commit: "aceito" volta a
      // significar "persistido", não "vou tentar continuar nesta função".
      //
      // Quem processa o trabalho é o worker (`bin/worker-outbox.js`), que
      // chama exatamente `responderSePossivel` — a mesma barreira de
      // controle do Comando 2 vale para o processamento aqui e para o
      // síncrono logo abaixo; nenhum caminho novo de envio foi criado.
      const chave = `outbox:${conversa.id}:${mensagem.id}`;
      const { trabalho } = await repositorio.enfileirarTrabalhoDeOutbox({
        conversaId: conversa.id,
        mensagemEntradaId: mensagem.id,
        chaveIdempotencia: chave,
      });
      return {
        acao: 'aceita_para_despacho',
        ia_despachada: true,
        despacho: 'outbox',
        conversa_id: conversa.id,
        mensagem_id: mensagem.id,
        trabalho_id: trabalho.id,
      };
    }

    return responderSePossivel(conversa.id, { mensagemEntradaId: mensagem.id });
  }

  function temDadosDeOrigem(evento) {
    return ['origem_detalhe', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .some((campo) => Boolean(evento[campo]));
  }

  /**
   * Aplica a regra da pausa e, quando permitido, aciona o orquestrador.
   *
   * `mensagemEntradaId` é a mensagem do paciente que motivou esta chamada. A
   * chave de idempotência do despacho e o `id_externo` da resposta derivam
   * dela — nunca da "última mensagem no momento da leitura", que muda se outro
   * inbound chegar entre a falha e a retentativa e faria o retry parecer um
   * evento novo.
   */
  async function responderSePossivel(conversaId, { mensagemEntradaId = null } = {}) {
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
      // Comando 7, achado A-2 da auditoria: até aqui isto voltava como
      // `sem_orquestrador` sem escalonar — a outbox (`decidirDesfecho`) trata
      // qualquer resultado sem `entregaIncerta` como "resolvido" e marcava o
      // trabalho `concluido`. Paciente sem resposta, conversa sem dono,
      // ninguém avisado. Falta de configuração não é transitória (o valor de
      // `disponivel` vem de config estática, não muda sozinho entre
      // tentativas) — mesmo raciocínio que já vale para
      // `motor_ia_nao_configurado` e `falha_no_orquestrador` logo abaixo.
      // Escalação imediata, não retentativa.
      await escalonar(conversaId, 'sem_orquestrador');
      return { acao: 'escalonada_para_equipe', conversa_id: conversaId, motivo: 'openclaw_nao_configurado' };
    }

    const mensagens = await repositorio.listarMensagens(conversaId, { incluirPrivadas: false });
    const contexto = montarContextoMinimo(conversa, mensagens);

    // O inbound que motivou esta resposta. Com ele, "um inbound → no máximo uma
    // resposta automática" vira uma chave única no banco, não uma esperança.
    const entradaId = mensagemEntradaId
      ?? mensagens.filter((mensagem) => mensagem.direcao === 'entrada').at(-1)?.id
      ?? 0;
    const chaveDaResposta = `serena:resposta:${conversaId}:${entradaId}`;

    // Retentativa depois de queda entre gravar e entregar: a resposta já existe.
    // Não se despacha a IA de novo — reaproveita o texto gravado e tenta só a
    // entrega, com a mesma chave. Comando 7, achado M-1: isso deduplica de
    // verdade pelo gateway WebSocket do OpenClaw (reserva, que usa
    // `idempotencyKey`) — mas NÃO pela Evolution (canal primário hoje), que
    // não expõe idempotência nativa nesse endpoint e ignora a chave (ver
    // evolution-envio.js). A defesa real contra reenvio duplicado pela
    // Evolution é LEASE_MS ter folga suficiente para nunca reivindicar de
    // novo um trabalho que só está demorando (ver automacao-outbox.js).
    const respostaAnterior = mensagens.find((mensagem) => mensagem.id_externo === chaveDaResposta);
    if (respostaAnterior) {
      const entrega = await entregarAoPaciente(conversa, respostaAnterior.conteudo, respostaAnterior.id, {
        origem: 'serena',
      });
      if (entrega.motivo === 'envio_abortado_por_controle') {
        return {
          acao: 'resposta_abortada_por_controle',
          conversa_id: conversaId,
          motivo: entrega.motivoControle,
          entregue: false,
        };
      }

      // Mesmo tratamento da entrega "de primeira" logo abaixo: uma
      // retentativa que continua sem conseguir entregar não pode voltar como
      // "respondida" — a equipe precisa ver isto, e a outbox precisa saber
      // que não é um caso para reagendar sozinha (ver `entregaIncerta`).
      if (!entrega.enviada && entrega.motivo !== 'canal_nao_configurado') {
        await repositorio.registrarAuditoria({
          entidade: 'conversa',
          entidadeId: conversaId,
          acao: 'resposta_nao_entregue',
          detalhe: {
            mensagem_id: respostaAnterior.id, motivo: entrega.motivo, autor: 'automacao',
            indeterminado: entrega.indeterminado === true,
          },
        }).catch(() => {});
        await escalonar(conversaId, 'falha_na_entrega_da_automacao');
        return {
          acao: 'escalonada_por_falha_entrega',
          conversa_id: conversaId,
          motivo: entrega.motivo,
          entregue: false,
          entregaIncerta: entrega.indeterminado === true,
        };
      }

      return {
        acao: 'respondida_pela_automacao',
        conversa_id: conversaId,
        duplicada: true,
        entregue: entrega.enviada,
      };
    }

    // A qualificação vai junto para o orquestrador saber o que já foi perguntado
    // e o que falta — sem isso ele repetiria perguntas já respondidas.
    //
    // Só o que é **comercial**: o que a pessoa procura, se é primeira consulta,
    // forma de pagamento, urgência e horário. Nada clínico atravessa esta linha.
    let lead = await repositorio.obterLeadPorContato(conversa.contato_id);

    // Antes de montar o contexto, tenta preencher com o que a própria
    // conversa já revelou — sem isso um lead que já falou preço e horário
    // continua preso na primeira pergunta pra sempre, só porque ninguém
    // preencheu a ficha na mão. Melhor esforço: falha aqui nunca cala a
    // automação nem atrasa a resposta ao paciente.
    if (qualificacaoIa && leads && lead && camposPendentes(lead).length > 0) {
      try {
        const extraido = await qualificacaoIa.extrair({
          mensagens,
          qualificacaoAtual: lead,
          chaveIdempotencia: `qualificacao:${conversaId}:${entradaId}`,
        });
        if (extraido && Object.keys(extraido).length > 0) {
          const resultado = await leads.qualificar(lead.id, extraido, {
            conversaId,
            origem: 'automacao_ia',
          });
          lead = resultado.lead;
        }
      } catch (erro) {
        console.error(`[atendimento] falha na extração de qualificação: ${erro.message}`);
      }
    }

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
        chave_idempotencia: `conversa:${conversaId}:${entradaId}`,
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
        // registro paralelo: quem abre a conversa vê tudo em ordem. O
        // `id_externo` determinístico faz o índice único do banco garantir que
        // duas execuções concorrentes do mesmo inbound gravem UMA resposta.
        const { mensagem: gravada, duplicada } = await repositorio.registrarMensagem(conversaId, {
          direcao: 'saida',
          conteudo: texto,
          autor_tipo: 'automacao',
          autor_nome: 'Serena',
          id_externo: chaveDaResposta,
        });
        // Publica assim que a mensagem existe, antes de tentar entregar ao
        // paciente: quem está com a tela aberta vê a resposta da Serena na
        // hora, mesmo que a entrega pelo canal falhe ou demore.
        emissor?.publicarMensagem(conversaId, gravada);

        // A resposta precisa CHEGAR ao paciente — gravar no CRM não entrega
        // nada. A chave determinística é passada adiante, mas só o gateway
        // WebSocket do OpenClaw (reserva) de fato deduplica por ela — a
        // Evolution (canal primário) não usa a chave (Comando 7, achado
        // M-1; ver o comentário em `entregarAoPaciente`/evolution-envio.js).
        const entrega = await entregarAoPaciente(conversa, gravada.conteudo, gravada.id, {
          origem: 'serena',
        });

        // O controle mudou entre a leitura do início desta função e o instante
        // do envio (Desligar, Pausar, Assumir, PARAR SERENA, ou a conversa foi
        // resolvida/assumida por outro caminho). `entregarAoPaciente` já
        // recusou e auditou o motivo em `envio_abortado_por_controle`; aqui só
        // resta relatar — sem escalonar (um humano já decidiu, forçar
        // atribuição por cima disso seria o oposto do que ele pediu) e sem
        // tratar como falha de entrega (não é rede fora do ar, é o comando
        // tendo sido obedecido).
        if (entrega.motivo === 'envio_abortado_por_controle') {
          return {
            acao: 'resposta_abortada_por_controle',
            conversa_id: conversaId,
            motivo: entrega.motivoControle,
            entregue: false,
          };
        }

        if (!entrega.enviada && entrega.motivo !== 'canal_nao_configurado') {
          await repositorio.registrarAuditoria({
            entidade: 'conversa',
            entidadeId: conversaId,
            acao: 'resposta_nao_entregue',
            detalhe: {
              mensagem_id: gravada.id, motivo: entrega.motivo, autor: 'automacao',
              indeterminado: entrega.indeterminado === true,
            },
          }).catch(() => {});

          // Arquitetura B: com o agente do canal calado, entrega que falhou
          // significa paciente SEM resposta nenhuma. A conversa não fica parada
          // com a automação — vai para a equipe, com o motivo. A resposta segue
          // gravada com id_externo: liberada a conversa, o retry reaproveita o
          // texto e tenta só a entrega, sem nova chamada de IA.
          await escalonar(conversaId, 'falha_na_entrega_da_automacao');
          return {
            acao: 'escalonada_por_falha_entrega',
            conversa_id: conversaId,
            motivo: entrega.motivo,
            entregue: false,
            // A outbox nunca deve retentar sozinha um envio de desfecho
            // incerto — ver `entregarAoPaciente` e `evolution-envio.js`.
            entregaIncerta: entrega.indeterminado === true,
          };
        }

        await repositorio.registrarAuditoria({
          entidade: 'conversa',
          entidadeId: conversaId,
          acao: 'respondida_pela_automacao',
          detalhe: { mensagem_id: gravada.id, entregue: entrega.enviada, duplicada },
        });
        return {
          acao: 'respondida_pela_automacao',
          conversa_id: conversaId,
          duplicada,
          entregue: entrega.enviada,
        };
      }

      if (resposta?.escalonar) {
        await escalonar(conversaId, resposta.motivo || 'escalonamento_do_orquestrador');
        // Motor de IA sem sessão própria configurada é falha fechada, não
        // silêncio: a conversa vai para a equipe com o motivo dizendo o que
        // falta ligar — em vez de o CRM fingir que despachou para algum lugar.
        if (resposta.motivo === 'motor_ia_nao_configurado') {
          return { acao: 'escalonada_para_equipe', conversa_id: conversaId, motivo: resposta.motivo };
        }
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

    const { mensagem: avisoDeAssumir } = await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      tipo: 'sistema',
      conteudo: 'Conversa assumida pela equipe. A resposta automática está pausada.',
      autor_tipo: 'sistema',
      privada: true,
    });
    emissor?.publicarMensagem(conversaId, avisoDeAssumir);
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
    // Publica assim que a mensagem existe, mesmo antes de tentar entregar ao
    // paciente: outra tela da equipe olhando a mesma conversa precisa ver a
    // resposta na hora, e não deve esperar pelo canal externo para isso.
    emissor?.publicarMensagem(conversaId, mensagem);

    // Nota interna não é atendimento: não assume a conversa nem cala a IA.
    if (!privada) {
      const conversa = await repositorio.obterConversa(conversaId);
      if (!conversa.assumida_por_humano) await assumir(conversaId, usuarioId);

      // A resposta precisa chegar ao paciente. Sem este envio, ela ficava
      // gravada no CRM e nunca saía — a equipe respondia, via a mensagem na
      // tela, e do outro lado ninguém recebia nada.
      const entrega = await entregarAoPaciente(conversa, texto, mensagem.id);

      // Instalação sem canal não é falha de envio: é um sistema que nunca
      // prometeu entregar. Alarmar aqui faria a tela gritar em todo ambiente de
      // desenvolvimento, e o alarme que soa sempre deixa de ser lido.
      if (entrega.motivo === 'canal_nao_configurado') return mensagem;

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
   * A barreira final: relê o controle no último instante possível antes de
   * qualquer envio gerado pela automação.
   *
   * `responderSePossivel` já consultou `podeResponder` no início — mas entre
   * aquela leitura e este ponto passam a extração de qualificação, a chamada
   * ao orquestrador (rede, pode levar dezenas de segundos) e a gravação da
   * resposta. Desligar, Pausar, Assumir ou PARAR SERENA clicado nesse
   * intervalo precisa valer, e só vale se alguém checar de novo bem aqui —
   * reaproveitar a decisão antiga é exatamente o defeito que motivou esta
   * função existir.
   *
   * Relê do zero, nunca do que já estava em memória: `conversa` chega para
   * `entregarAoPaciente` como o objeto lido no início da chamada, e é
   * justamente esse objeto que pode estar desatualizado.
   *
   * Falha ao reler o estado é fail-closed: não saber se pode responder não é
   * "responde assim mesmo", é "não responde".
   */
  async function podeEntregarAgora(conversaId) {
    let conversaFresca;
    try {
      conversaFresca = await repositorio.obterConversa(conversaId);
    } catch {
      return { permitido: false, motivo: 'falha_ao_reler_controle' };
    }
    if (!conversaFresca) return { permitido: false, motivo: 'conversa_nao_encontrada' };

    try {
      const decisao = serena
        ? await serena.podeResponder(conversaFresca)
        : decidirAutomacao(conversaFresca);
      if (!decisao.responder) return { permitido: false, motivo: decisao.motivo };
      return { permitido: true };
    } catch {
      return { permitido: false, motivo: 'falha_ao_reler_controle' };
    }
  }

  /**
   * Entrega ao paciente pelo canal de onde a conversa veio.
   *
   * Falha de envio não desfaz o registro: a resposta da equipe é um fato que
   * aconteceu, e apagá-la esconderia da própria equipe o que ela já escreveu.
   * O que muda é a marca — enviada ou não —, para a tela poder dizer a verdade.
   */
  async function entregarAoPaciente(conversa, texto, mensagemId, { origem = 'equipe' } = {}) {
    // Só a automação passa pela barreira final. Uma resposta escrita por um
    // humano não precisa reconferir "a Serena pode responder": quem decide
    // por um humano é o próprio humano, no instante em que ele clicou em
    // enviar — não há geração assíncrona entre a decisão e o envio para uma
    // corrida acontecer.
    if (origem === 'serena') {
      const controle = await podeEntregarAgora(conversa.id);
      if (!controle.permitido) {
        // Auditoria com motivo técnico e o identificador da mensagem, nunca o
        // texto: nem o que a Serena gerou, nem o que o paciente escreveu, nem
        // qualquer coisa que possa carregar conteúdo clínico.
        await repositorio.registrarAuditoria({
          entidade: 'conversa',
          entidadeId: conversa.id,
          acao: 'envio_abortado_por_controle',
          detalhe: { mensagem_id: mensagemId, motivo: controle.motivo },
        }).catch(() => {});

        // Comando 7, achado A-3 (segunda parte): a mensagem já está gravada
        // e visível na tela — sem esta marca, ela aparece indistinguível de
        // uma resposta que realmente saiu. Vale para TODO bloqueio da
        // barreira, escalonando ou não: em ambos os casos o paciente não
        // recebeu nada.
        if (repositorio.marcarEntregaFalhou) {
          await repositorio.marcarEntregaFalhou(mensagemId, controle.motivo).catch((erro) => {
            console.error(`[atendimento] falha ao marcar entrega não realizada: ${erro.message}`);
          });
        }

        // Comando 7, achado A-3: motivo que não é uma decisão humana recente
        // (ver MOTIVOS_DE_DECISAO_HUMANA_RECENTE) precisa escalonar — sem
        // isso, a resposta que a automação acabou de gerar fica descartada
        // em silêncio, e a conversa segue do jeito que estava como se nada
        // tivesse acontecido.
        if (bloqueioDaBarreiraPrecisaEscalar(controle.motivo)) {
          await escalonar(conversa.id, `barreira_final:${controle.motivo}`).catch((erro) => {
            console.error(`[atendimento] falha ao escalonar bloqueio da barreira final: ${erro.message}`);
          });
        }

        // Nem Evolution, nem o fallback do OpenClaw: `canal.enviar` não é
        // chamado neste caminho, então nenhum dos dois transportes é acionado.
        return { enviada: false, motivo: 'envio_abortado_por_controle', motivoControle: controle.motivo };
      }
    }

    if (!canal?.enviar) return { enviada: false, motivo: 'canal_nao_configurado' };

    try {
      const contato = await repositorio.obterContato(conversa.contato_id);
      if (!contato?.telefone) return { enviada: false, motivo: 'contato_sem_telefone' };

      const resultado = await canal.enviar({
        telefone: contato.telefone,
        texto,
        // Comando 7, segunda auditoria, achado N-10: este comentário dizia
        // que a chave, sozinha, impedia o paciente de receber a mesma
        // resposta duas vezes — falso para a Evolution (canal primário
        // hoje), que recebe a chave mas nunca a usa (documentado em
        // evolution-envio.js:9-11: o endpoint de envio não tem idempotência
        // nativa nenhuma). A chave protege contra DUPLO PROCESSAMENTO do
        // MESMO trabalho pelo mecanismo de outbox/lease — cada trabalho só
        // é reivindicado por um worker de cada vez, e o lease agora é
        // renovado por trabalho individual (achado N-9, `processarLote`),
        // não mais por lote inteiro. O transporte Evolution em si não
        // deduplica no lado dele; só o gateway WebSocket do OpenClaw
        // (reserva) usa a chave de verdade (`idempotencyKey`).
        chave: `${origem}:${conversa.id}:${mensagemId}`,
      });

      return { enviada: true, identificador: resultado?.identificador ?? null };
    } catch (erro) {
      // `indeterminado`: a chamada estourou o tempo sem resposta — não dá para
      // dizer se a mensagem saiu ou não. Quem chama (a outbox) precisa saber
      // disso para NUNCA reenviar automaticamente neste caso.
      return { enviada: false, motivo: erro.message, indeterminado: erro.indeterminado === true };
    }
  }

  async function escalonar(conversaId, motivo) {
    await repositorio.atualizarConversa(conversaId, { assumida_por_humano: true, status: 'aberta' });
    const { mensagem: avisoDeEscalonamento } = await repositorio.registrarMensagem(conversaId, {
      direcao: 'saida',
      tipo: 'sistema',
      conteudo: `Conversa encaminhada para a equipe (${motivo}).`,
      autor_tipo: 'sistema',
      privada: true,
    });
    emissor?.publicarMensagem(conversaId, avisoDeEscalonamento);
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
