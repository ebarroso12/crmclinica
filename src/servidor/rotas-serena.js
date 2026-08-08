'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { CATEGORIAS, dentroDoHorario } = require('../dominio/serena');
const { avaliarRiscoDoCanal } = require('../dominio/risco-canal');
const { urlDoControle } = require('../integracoes/openclaw-vinculo');

// API da Serena: estado, interruptor, prompt versionado e regras.
//
// O status é a rota mais lida da tela, e a que mais errava antes: dizia "não
// configurado" olhando para variáveis do cliente HTTP antigo enquanto o envio
// real já funcionava pelo gateway WebSocket. Agora ela pergunta ao gateway — e
// separa quatro coisas que não são a mesma:
//
//   • OpenClaw  — o gateway responde?
//   • WhatsApp  — o canal está conectado?
//   • Serena    — a automação está ligada?
//   • número    — qual linha atende?
//
// Um sistema em que "o WhatsApp caiu" e "a Serena foi desligada pela equipe"
// aparecem com a mesma cor é um sistema que faz a equipe reiniciar servidor
// quando bastava clicar em "ligar".

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function criarRotasDaSerena({ serena, entregaDeLembretes, configuracao, vinculo = null, conversa = null }) {
  // Modelos oferecidos no ensaio. A lista é curta de propósito: comparar quinze
  // opções não responde "qual serve para a clínica", e cada uma custa dinheiro
  // por conversa. Ficam os três que fazem sentido comparar — o barato que está
  // em uso, o equilibrado e o mais capaz — de cada família com credencial.
  const MODELOS_DE_TESTE = Object.freeze([
    { id: 'deepseek/deepseek-v4-flash', nome: 'DeepSeek V4 Flash', nota: 'em uso hoje — o mais barato' },
    { id: 'anthropic/claude-haiku-4-5', nome: 'Claude Haiku 4.5', nota: 'rápido e barato' },
    { id: 'anthropic/claude-sonnet-4-6', nome: 'Claude Sonnet 4.6', nota: 'equilíbrio entre custo e cuidado' },
    { id: 'anthropic/claude-opus-4-5', nome: 'Claude Opus 4.5', nota: 'o mais capaz — segue instrução longa melhor' },
    { id: 'openai/gpt-4.1-mini', nome: 'GPT-4.1 Mini', nota: 'barato' },
    { id: 'openai/gpt-4o', nome: 'GPT-4o', nota: 'o mais capaz da OpenAI aqui' },
    { id: 'google/gemini-2.5-flash', nome: 'Gemini 2.5 Flash', nota: 'rápido e barato' },
  ]);

  /**
   * O que a tela precisa saber sobre horário, pausa e plantão — de uma vez.
   *
   * `atendendo` é o campo que importa: responde "a Serena está falando com
   * paciente agora?", que é a pergunta real. Sem ele, a tela teria que refazer a
   * precedência entre interruptor, pausa, plantão e grade — e reimplementar essa
   * ordem no navegador é como as duas versões passam a discordar.
   */
  function resumoDoHorario(configuracao = {}, agora = new Date()) {
    const vigente = (instante) => Boolean(instante) && new Date(instante) > agora;

    const pausada = vigente(configuracao.pausada_ate);
    const emPlantao = vigente(configuracao.ligada_ate);
    const noHorario = dentroDoHorario(configuracao.agenda, agora);

    return {
      agenda: configuracao.agenda ?? null,
      pausada_ate: pausada ? configuracao.pausada_ate : null,
      ligada_ate: emPlantao ? configuracao.ligada_ate : null,
      pausada,
      em_plantao: emPlantao,
      dentro_do_horario: noHorario,
      atendendo: configuracao.ativa !== false && !pausada && (emPlantao || noHorario),
    };
  }

  /**
   * Passo a passo da vinculação manual, com o endereço do servidor.
   *
   * Fica no servidor de propósito: o host vem de `OPENCLAW_SSH_HOST`, e devolvê-lo
   * só a quem é master evita publicá-lo no `app.js`, que qualquer um baixa.
   */
  function instrucaoDeVinculo() {
    const host = configuracao.openclaw.hostDeAdministracao;
    const controle = urlDoControle(configuracao.openclaw.canalClinica?.url);
    if (!host && !controle) return null;

    return {
      titulo: 'Não foi possível gerar o código aqui.',
      antes: 'O caminho normal é o QR desta janela. Se ele não veio, dá para vincular pela tela do OpenClaw:',
      // O link é o caminho de quem está na clínica: é um navegador, não um
      // terminal. O comando fica como segunda opção, para quem já tem SSH — e
      // some quando `OPENCLAW_SSH_HOST` não está configurado, porque instrução
      // que ninguém consegue seguir é ruído.
      url: controle,
      comandos: host ? [`ssh ${host}`, 'vincular-whatsapp'] : [],
      depois: 'O código aparece lá e se renova sozinho enquanto ninguém escaneia. Ao terminar, o estado acima se atualiza.',
    };
  }

  /**
   * GET /api/serena/status
   *
   * Consulta o gateway de verdade. A consulta é `channels.status` — leitura
   * pura, nenhuma mensagem sai.
   */
  async function status(usuario) {
    exigirPermissao(usuario, 'serena:ler');

    const config = await serena.obterConfiguracao();
    const entrega = entregaDeLembretes?.descrever?.() ?? {};
    const gatewayConfigurado = Boolean(configuracao.openclaw.gateway.url
      && (configuracao.openclaw.gateway.token || configuracao.openclaw.gateway.deviceToken));

    // Sem gateway configurado nem se pergunta: a chamada falharia e o "offline"
    // resultante confundiria falta de configuração com serviço fora do ar.
    let canal = { disponivel: false, motivo: 'gateway não configurado' };
    if (gatewayConfigurado && entregaDeLembretes?.verificarCanal) {
      try {
        canal = await entregaDeLembretes.verificarCanal();
      } catch (erro) {
        canal = { disponivel: false, motivo: erro.message };
      }
    }

    // "Alcançável" e "conectado" são coisas diferentes: o gateway pode responder
    // com o WhatsApp desligado, e é exatamente esse o caso que a equipe precisa
    // distinguir para saber se reconecta o celular ou chama o suporte.
    const gatewayRespondeu = canal.conectado !== undefined || canal.disponivel === true;

    return {
      openclaw: {
        estado: !gatewayConfigurado ? 'nao_configurado' : (gatewayRespondeu ? 'online' : 'offline'),
        gateway: configuracao.openclaw.gateway.url || null,
        // O deviceId é público por natureza: é o hash da chave pública.
        dispositivo: entrega.dispositivo ?? null,
        metodo: entrega.metodo ?? null,
      },
      whatsapp: {
        estado: canal.conectado === true ? 'conectado' : 'desconectado',
        numero: canal.numero ?? configuracao.openclaw.numeroWhatsapp ?? null,
        vinculado: canal.vinculado ?? null,
        ...(canal.conectado === true ? {} : { motivo: canal.motivo ?? null }),
      },
      serena: {
        estado: config.ativa ? 'ligada' : 'desligada',
        ativa: config.ativa,
        alterado_em: config.alterado_em ?? null,
        alterado_por: config.alterado_por_nome ?? null,
        motivo: config.motivo ?? null,
      },
      // Separado de `serena.estado` porque responde outra pergunta: aquele diz
      // se o interruptor está ligado, este diz se ela está atendendo agora.
      horario: resumoDoHorario(config),
      entrega: {
        modo: entrega.modo ?? 'dry_run',
        significado: entrega.significado ?? null,
      },
    };
  }

  return {
    status,

    /** GET /api/serena — estado e prompt ativo, o que a tela precisa de uma vez. */
    async painel(usuario) {
      exigirPermissao(usuario, 'serena:ler');

      const [estado, ativo, prompts, regras] = await Promise.all([
        status(usuario),
        serena.obterPromptAtivo(),
        serena.listarPrompts({ limite: 30 }),
        serena.listarRegras({}),
      ]);

      return {
        ...estado,
        prompt_ativo: ativo.prompt
          ? {
            id: ativo.prompt.id,
            versao: ativo.prompt.versao,
            titulo: ativo.prompt.titulo,
            conteudo: ativo.prompt.conteudo,
            publicado_em: ativo.prompt.publicado_em,
          }
          : null,
        prompt_efetivo: ativo.efetivo,
        versoes: prompts.map((prompt) => ({
          id: prompt.id,
          versao: prompt.versao,
          titulo: prompt.titulo,
          publicado: prompt.publicado === true,
          publicado_em: prompt.publicado_em,
          criado_em: prompt.criado_em,
          criado_por: prompt.criado_por_nome ?? null,
        })),
        regras: regras.map((regra) => ({
          id: regra.id,
          nome: regra.nome,
          descricao: regra.descricao,
          conteudo: regra.conteudo,
          categoria: regra.categoria,
          ativa: regra.ativa === true,
          ordem: regra.ordem,
        })),
        vocabulario: { categorias: CATEGORIAS },
        // Quem só tem `serena:ler` vê tudo e não muda nada; a tela usa isto para
        // esconder os botões em vez de deixar o usuário descobrir com um 403.
        pode_gerenciar: usuario?.papel === 'admin',
      };
    },

    /**
     * GET /api/serena/canal/risco — vale a pena continuar no WhatsApp por QR?
     *
     * O número atende por sessão pareada, não pela API oficial, e o WhatsApp
     * derruba quem se comporta como disparador. Trocar de tecnologia tem custo
     * alto — tira o número do celular da recepção —, então a troca só se
     * justifica quando os números mostram que o risco virou real. Esta rota é
     * quem mede, para a decisão não depender de palpite.
     */
    async riscoDoCanal(usuario) {
      exigirPermissao(usuario, 'serena:ler');

      const medidas = await serena.medirCanal({ dias: 30 });

      // Quedas da sessão ainda não são registradas. Zero aqui é honesto — os
      // outros três sinais valem por si, e inventar um número faria a avaliação
      // parecer mais completa do que é.
      return {
        periodo_dias: medidas.dias,
        ...avaliarRiscoDoCanal({ ...medidas, quedasEm24h: 0 }),
        volumes: {
          enviados: medidas.enviados,
          falhas: medidas.falhas,
          contatos: medidas.contatos,
          optouts: medidas.optouts,
        },
      };
    },

    // ------------------------------------------------------------- teste do prompt

    /**
     * POST /api/serena/teste — abre uma conversa de teste com a Serena.
     *
     * Serve para experimentar o prompt antes de soltá-lo no telefone da clínica.
     * A conversa acontece na sessão do painel: nenhuma mensagem sai para número
     * nenhum, e o paciente fictício não vira contato.
     *
     * Sem isto, a única forma de saber como ela responde era escrever para o
     * número real — e foi assim que a equipe descobriu, com paciente na linha,
     * que ela publicava o próprio raciocínio na conversa.
     */
    async abrirTeste(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      if (!conversa) {
        const erro = new Error('gateway do canal não configurado');
        erro.status = 503;
        erro.codigo = 'canal_nao_configurado';
        throw erro;
      }
      return {
        ...(await conversa.abrir({ modelo: corpo?.modelo ?? null })),
        modelos: MODELOS_DE_TESTE,
      };
    },

    /** POST /api/serena/teste/mensagem — fala como paciente. */
    async enviarNoTeste(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      if (!conversa) {
        const erro = new Error('gateway do canal não configurado');
        erro.status = 503;
        throw erro;
      }

      const texto = String(corpo?.texto ?? '').trim();
      if (!texto) throw new ErroDeContrato('escreva a mensagem do paciente', 'texto');

      return conversa.enviar({ sessao: corpo?.sessao, texto });
    },

    /**
     * GET /api/serena/teste?sessao=… — a conversa até agora.
     *
     * Separado do envio porque o modelo responde de forma assíncrona: a tela
     * mostra a pergunta na hora e busca a resposta quando ela fica pronta.
     */
    async lerTeste(usuario, url) {
      exigirPermissao(usuario, 'serena:gerenciar');
      if (!conversa) return { mensagens: [] };

      const sessao = url?.searchParams?.get('sessao');
      if (!sessao) throw new ErroDeContrato('informe a sessão do teste', 'sessao');

      return conversa.historico(sessao);
    },

    /**
     * PUT /api/serena/ativacao — o rollout gradual.
     * `{ "modo": "todos"|"percentual"|"lista", "percentual": 25 }`
     * O desligado global continua soberano; isto regula o LIGADO.
     */
    async definirAtivacao(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');

      const configuracaoNova = await serena.definirAtivacao({
        modo: corpo?.modo,
        percentual: corpo?.percentual ?? null,
        usuarioId: usuario.id,
      });

      return {
        ativacao: {
          modo: configuracaoNova.modo_ativacao,
          percentual: configuracaoNova.ativacao_percentual,
        },
      };
    },

    /** POST /api/serena/ativacao/contatos — inclui/remove contato da lista. */
    async definirContatoDeAtivacao(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');

      const contatoId = Number(corpo?.contato_id);
      if (!Number.isInteger(contatoId) || contatoId <= 0) {
        throw new ErroDeContrato('campo "contato_id" deve ser um identificador válido', 'contato_id');
      }
      if (typeof corpo?.incluido !== 'boolean') {
        throw new ErroDeContrato('campo "incluido" deve ser true ou false', 'incluido');
      }

      return serena.definirContatoDeAtivacao(contatoId, corpo.incluido, { usuarioId: usuario.id });
    },

    /** POST /api/serena/estado — o interruptor. `{ "ativa": false, "motivo": "…" }` */
    async definirEstado(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');

      if (typeof corpo?.ativa !== 'boolean') {
        throw new ErroDeContrato('campo "ativa" deve ser true ou false', 'ativa');
      }

      const configuracaoNova = await serena.definirAtiva(corpo.ativa, {
        motivo: corpo?.motivo ?? null,
        usuarioId: usuario.id,
      });

      return {
        serena: {
          estado: configuracaoNova.ativa ? 'ligada' : 'desligada',
          ativa: configuracaoNova.ativa,
          alterado_em: configuracaoNova.alterado_em,
          motivo: configuracaoNova.motivo,
        },
      };
    },

    // ------------------------------------------------------ horário, pausa, plantão

    /**
     * PUT /api/serena/horario — a grade. `{ "ativa": true, "fuso": "…", "dias": {…} }`
     *
     * Corpo `null` remove o limite e a Serena volta a atender sempre. É
     * diferente de uma grade com todos os dias vazios, que cala a semana
     * inteira — e a diferença precisa ser explícita, não um efeito colateral de
     * apagar as janelas na tela.
     */
    async definirHorario(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const configuracao = await serena.definirAgenda(corpo ?? null, { usuarioId: usuario.id });
      return { horario: resumoDoHorario(configuracao) };
    },

    /** POST /api/serena/pausa — cala por um tempo. `{ "minutos": 15, "motivo": "…" }` */
    async pausar(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const configuracao = await serena.pausar(corpo?.minutos, {
        motivo: corpo?.motivo ?? null,
        usuarioId: usuario.id,
      });
      return { horario: resumoDoHorario(configuracao) };
    },

    /** DELETE /api/serena/pausa — devolve a palavra antes do prazo. */
    async despausar(usuario) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const configuracao = await serena.despausar({ usuarioId: usuario.id });
      return { horario: resumoDoHorario(configuracao) };
    },

    /** POST /api/serena/plantao — atende fora do horário. `{ "minutos": 60 }` */
    async ligarPorTempo(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const configuracao = await serena.ligarPorTempo(corpo?.minutos, { usuarioId: usuario.id });
      return { horario: resumoDoHorario(configuracao) };
    },

    // ---------------------------------------------------------------- canal

    /**
     * GET /api/serena/canal — estado da vinculação do WhatsApp.
     *
     * Separado do status geral porque responde outra pergunta: não é "o canal
     * está no ar?", é "qual telefone está conectado, e preciso reconectar?".
     */
    async estadoDoCanal(usuario) {
      exigirPermissao(usuario, 'serena:ler');
      if (!vinculo) return { disponivel: false, motivo: 'gateway do canal não configurado' };

      try {
        return { disponivel: true, ...(await vinculo.estado()) };
      } catch (erro) {
        // A mensagem crua do gateway carrega URL, identificador de dispositivo e
        // escopos. Quem tem `serena:ler` é a recepção, não quem administra o
        // servidor: o detalhe vai para o log, a tela recebe o que dá para agir.
        console.error('[crmclinica] estado do canal falhou:', erro.message);
        return {
          disponivel: false,
          motivo: 'não foi possível falar com o WhatsApp agora',
          codigo: erro.codigo ?? null,
        };
      }
    },

    /**
     * POST /api/serena/canal/qr — abre a vinculação e devolve o QR do momento.
     *
     * Só o master: vincular troca o telefone por onde a clínica inteira atende,
     * e desvincular sem querer deixaria os pacientes sem resposta.
     *
     * Chamar de novo é esperado — o QR troca sozinho a cada poucos segundos, e
     * a tela repete a chamada para acompanhar.
     */
    async obterQrDoCanal(usuario) {
      if (!usuario?.master) {
        const erro = new Error('apenas o administrador master conecta o WhatsApp da clínica');
        erro.status = 403;
        throw erro;
      }
      if (!vinculo) {
        const erro = new Error('gateway do canal não configurado');
        erro.status = 503;
        erro.codigo = 'canal_nao_configurado';
        throw erro;
      }

      try {
        const resultado = await vinculo.obterQr();
        if (resultado.qr || resultado.vinculado) return resultado;

        // Sem QR pelo gateway, resta o comando no servidor — e ele carrega o
        // endereço da máquina. Isso não pode viajar no `app.js`, que é servido
        // sem autenticação: sai daqui, numa resposta que só o master recebe.
        return { ...resultado, instrucao: instrucaoDeVinculo() };
      } catch (erro) {
        // Gateway fora do ar não é defeito do servidor: sem isto, `ErroDeGateway`
        // caía no 500 genérico e a tela não distinguia "tente de novo" de bug.
        //
        // Vai um erro novo, não o original com um campo a mais: o tratador de
        // `http.js` responde com `erro.message`, e a mensagem do gateway carrega
        // URL, dispositivo e escopos. Reaproveitar o objeto entregaria ao cliente
        // exatamente o detalhe que `estadoDoCanal` acabou de parar de entregar.
        if (!erro.codigo?.startsWith('gateway_') && erro.codigo !== 'openclaw_nao_pareado') throw erro;

        console.error('[crmclinica] vinculação do canal falhou:', erro.message);
        const publico = new Error(erro.codigo === 'openclaw_nao_pareado'
          ? 'o dispositivo ainda não foi aprovado no gateway do WhatsApp'
          : 'o gateway do WhatsApp não respondeu');
        publico.status = 503;
        publico.codigo = erro.codigo;
        throw publico;
      }
    },

    // Não há rota de cancelar. O painel não abre assistente nenhum — quem abre é
    // o `vincular-whatsapp` no servidor —, então cancelar daqui só poderia
    // derrubar o assistente de outra pessoa: o do admin com o comando rodando no
    // terminal, no instante em que ele fecha a janela do navegador.

    // ---------------------------------------------------------------- prompt

    async listarPrompts(usuario) {
      exigirPermissao(usuario, 'serena:ler');
      const prompts = await serena.listarPrompts({ limite: 50 });
      return { versoes: prompts };
    },

    async criarPrompt(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const prompt = await serena.criarPrompt({
        titulo: corpo?.titulo,
        conteudo: corpo?.conteudo,
        usuarioId: usuario.id,
      });
      return { prompt };
    },

    async editarPrompt(usuario, id, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const prompt = await serena.editarPrompt(exigirIdentificador(id, 'prompt_id'), {
        titulo: corpo?.titulo,
        conteudo: corpo?.conteudo,
        usuarioId: usuario.id,
      });
      return { prompt };
    },

    async publicarPrompt(usuario, id) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const prompt = await serena.publicarPrompt(exigirIdentificador(id, 'prompt_id'), {
        usuarioId: usuario.id,
      });
      return { prompt };
    },

    // ---------------------------------------------------------------- regras

    async listarRegras(usuario, parametros) {
      exigirPermissao(usuario, 'serena:ler');
      const regras = await serena.listarRegras({ apenasAtivas: parametros?.get('ativas') === 'sim' });
      return { regras, categorias: CATEGORIAS };
    },

    async criarRegra(usuario, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const regra = await serena.criarRegra({
        nome: corpo?.nome,
        conteudo: corpo?.conteudo,
        categoria: corpo?.categoria ?? 'geral',
        descricao: corpo?.descricao ?? null,
        ordem: corpo?.ordem ?? 100,
        usuarioId: usuario.id,
      });
      return { regra };
    },

    async editarRegra(usuario, id, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      const regraId = exigirIdentificador(id, 'regra_id');

      // `ativa` tem rota própria: ligar e desligar é uma ação de um clique, e
      // misturá-la com a edição faria um salvamento comum poder desligar a
      // regra sem que ninguém tenha pedido.
      const regra = await serena.editarRegra(regraId, {
        nome: corpo?.nome,
        conteudo: corpo?.conteudo,
        categoria: corpo?.categoria,
        descricao: corpo?.descricao,
        ordem: corpo?.ordem,
      }, { usuarioId: usuario.id });

      return { regra };
    },

    async definirRegraAtiva(usuario, id, corpo) {
      exigirPermissao(usuario, 'serena:gerenciar');
      if (typeof corpo?.ativa !== 'boolean') {
        throw new ErroDeContrato('campo "ativa" deve ser true ou false', 'ativa');
      }

      const regra = await serena.definirRegraAtiva(exigirIdentificador(id, 'regra_id'), corpo.ativa, {
        usuarioId: usuario.id,
      });
      return { regra };
    },

    async removerRegra(usuario, id) {
      exigirPermissao(usuario, 'serena:gerenciar');
      return serena.removerRegra(exigirIdentificador(id, 'regra_id'), { usuarioId: usuario.id });
    },
  };
}

module.exports = { criarRotasDaSerena };
