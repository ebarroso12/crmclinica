'use strict';

// Limite estrito para as rotas que consomem modelo de linguagem.
//
// Por que uma camada separada do limitador de autenticação: o custo de abuso é
// de natureza diferente. Uma tentativa de login a mais gasta CPU nossa; uma
// chamada de LLM a mais gasta DINHEIRO, por token, num provedor de terceiro, e
// não há teto natural. Três abusos possíveis, todos reais:
//
//   1. conta legítima em laço — a tela repete a chamada por um defeito de
//      interface e ninguém percebe até a fatura;
//   2. conta comprometida usada como proxy de IA de graça;
//   3. extração sistemática (`model inversion`): milhares de perguntas em
//      sequência para reconstruir o prompt do sistema ou o contexto de
//      atendimento. Este é o que a barreira de saída sozinha NÃO resolve —
//      ela avalia uma resposta por vez, e o ataque existe justamente no
//      volume. Limitar frequência é o que transforma "algumas horas" em
//      "meses", e é por isso que rate limiting conta como defesa de IA, não
//      só de infraestrutura.
//
// ------------------------------------------------------ onde o estado mora
//
// Reaproveita `criarLimitador` (janela deslizante, por conta e por IP, com o
// contador no banco). Isso importa numa aplicação serverless: contador em
// memória zera a cada invocação, e um limite que zera sozinho não é limite.
//
// ATENÇÃO ao ler a tabela: o uso de IA é gravado em `tentativas_autenticacao`
// com `sucesso = false`. Não é "falha" — naquela tabela a coluna significa
// "consome cota", e `contarFalhas` só conta as linhas com `NOT sucesso`.
// Registrar uso de IA como sucesso faria a chamada não contar para nada.
// Fica aqui, e não numa tabela própria, porque tabela nova exige migration em
// produção; se um dia a separação valer o custo, é um `INSERT` de destino
// diferente e mais nada.

const { ErroDeLimite } = require('./limite');

/**
 * Os tetos. Deliberadamente apertados: nenhuma pessoa de verdade precisa de
 * mais do que isto, e quem precisar pede — é uma linha de configuração.
 *
 * Separados por ação porque o uso legítimo é muito diferente entre elas: um
 * atendente responde algumas orientações por hora; um admin abre o assistente
 * do centro operacional poucas vezes por dia.
 */
const LIMITES_DE_IA = Object.freeze({
  // A equipe orientando a assistente numa conversa (`POST /conversas/:id/orientacao`).
  ia_orientacao: {
    conta: { maximo: 20, janelaMs: 60 * 60 * 1000 },
    ip: { maximo: 60, janelaMs: 60 * 60 * 1000 },
  },
  // Conversa de teste da Serena e dos agentes: é onde se itera prompt, então
  // o uso legítimo é em rajada — janela curta e teto generoso dentro dela.
  ia_teste: {
    conta: { maximo: 30, janelaMs: 15 * 60 * 1000 },
    ip: { maximo: 90, janelaMs: 15 * 60 * 1000 },
  },
  // Assistente e relatório do centro operacional: caros e raros.
  ia_assistente: {
    conta: { maximo: 15, janelaMs: 60 * 60 * 1000 },
    ip: { maximo: 40, janelaMs: 60 * 60 * 1000 },
  },
  // Treinamento por website: além do custo de IA, busca uma página de fora.
  ia_treinamento: {
    conta: { maximo: 10, janelaMs: 60 * 60 * 1000 },
    ip: { maximo: 20, janelaMs: 60 * 60 * 1000 },
  },
});

/** Teto de gasto do dia, em dólares, somando TODAS as finalidades. */
const TETO_DIARIO_USD_PADRAO = 25;

class ErroDeOrcamentoDeIA extends Error {
  constructor(gastoUsd, tetoUsd, segundosAteVirar) {
    super('o teto diário de uso de IA foi atingido');
    this.name = 'ErroDeOrcamentoDeIA';
    this.status = 429;
    this.codigo = 'ia_orcamento_diario';
    // O tratamento de 429 do servidor monta o cabeçalho `retry-after` com
    // isto. Sem o campo, o cabeçalho sairia como a string "undefined" — e um
    // `retry-after` inválido faz cliente educado repetir na hora.
    this.retryAfter = Math.max(1, segundosAteVirar);
    this.gastoUsd = gastoUsd;
    this.tetoUsd = tetoUsd;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.repositorio  Precisa de `contarFalhas`,
 *   `registrarTentativa` e `somarCustoDeIADesde`.
 * @param {object} [deps.limitador]  Injetável nos testes.
 * @param {number} [deps.tetoDiarioUsd]
 */
function criarLimiteDeIA({
  repositorio, limitador = null, tetoDiarioUsd = TETO_DIARIO_USD_PADRAO, agora = () => new Date(),
}) {
  const { criarLimitador } = require('./limite');
  const base = limitador || criarLimitador({ repositorio, limites: LIMITES_DE_IA, agora });

  /**
   * Chame ANTES de gastar. Lança 429 quando o teto estourou.
   *
   * A ordem importa: frequência primeiro (barato, por pessoa), orçamento
   * depois (uma soma no banco). Quem já estourou a própria cota nem chega a
   * custar a consulta do orçamento.
   *
   * @param {string} acao   Uma das chaves de `LIMITES_DE_IA`.
   * @param {string} email  Identifica a conta. `null` cai só no limite por IP.
   */
  async function exigirCota({ acao, email = null, ip = null }) {
    await base.exigirDentroDoLimite({ ip, email, acao });

    // Orçamento é global e último: mesmo dentro da própria cota, ninguém passa
    // do teto do dia. É a rede que pega o caso que os limites por pessoa não
    // pegam — dez contas legítimas somando muito num dia atípico.
    if (!repositorio.somarCustoDeIADesde) return;
    const inicioDoDia = new Date(agora());
    inicioDoDia.setUTCHours(0, 0, 0, 0);

    const gasto = await repositorio.somarCustoDeIADesde(inicioDoDia.toISOString());
    if (gasto >= tetoDiarioUsd) {
      // A cota volta na virada do dia em UTC — é a mesma fronteira usada para
      // somar o gasto, então o número que a resposta promete é o verdadeiro.
      const viradaDoDia = inicioDoDia.getTime() + 24 * 60 * 60 * 1000;
      const segundos = Math.ceil((viradaDoDia - agora().getTime()) / 1000);
      throw new ErroDeOrcamentoDeIA(gasto, tetoDiarioUsd, segundos);
    }
  }

  /**
   * Chame DEPOIS de gastar, sempre — inclusive quando a chamada ao provedor
   * falhou. Tentativa que falhou custou tokens de entrada e, principalmente, é
   * o caminho de um laço: se só o sucesso contasse, um erro em repetição
   * passaria por baixo do limite para sempre.
   */
  async function registrarUso({ acao, email = null, ip = null }) {
    // `sucesso: false` = "consome cota". Ver o comentário no topo do arquivo.
    await base.registrar({ ip, email, acao, sucesso: false });
  }

  return { exigirCota, registrarUso, LIMITES_DE_IA, tetoDiarioUsd };
}

module.exports = {
  criarLimiteDeIA,
  LIMITES_DE_IA,
  TETO_DIARIO_USD_PADRAO,
  ErroDeOrcamentoDeIA,
  ErroDeLimite,
};
