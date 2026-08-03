'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { CATEGORIAS } = require('../dominio/serena');

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

function criarRotasDaSerena({ serena, entregaDeLembretes, configuracao }) {
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
