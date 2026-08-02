'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

// Contexto da requisição na camada de dados.
//
// O problema que isto resolve: o banco precisa saber **quem** está pedindo. A
// aplicação conecta com uma credencial só, então, sem ajuda, o PostgreSQL vê
// todas as requisições como a mesma pessoa — e nenhuma policy consegue decidir
// por usuário.
//
// A solução é declarar o usuário na transação (`app.usuario_id`) e deixar as
// policies lerem por `app_usuario_atual()`.
//
// Por que AsyncLocalStorage em vez de passar o usuário por parâmetro: o
// repositório é capturado por closure em nove camadas montadas uma única vez na
// inicialização (atendimento, contas, leads, agenda…). Passar identidade por
// parâmetro obrigaria a mudar todas elas e toda assinatura no caminho. O
// contexto assíncrono atravessa isso sem que nenhuma camada intermediária
// precise saber que ele existe.
//
// O mesmo contexto carrega o client da transação, e é isso que faz uma
// requisição inteira acontecer em uma transação só: ou tudo acontece, ou nada.

const contexto = new AsyncLocalStorage();

/** O que vale agora, ou `null` fora de uma requisição com transação. */
function atual() {
  return contexto.getStore() ?? null;
}

/**
 * Roda `acao` com o contexto ativo.
 *
 * Tudo que `acao` chamar — inclusive várias camadas abaixo — enxerga o mesmo
 * client e o mesmo usuário, sem receber nenhum dos dois por parâmetro.
 */
function executarCom({ client, usuarioId }, acao) {
  return contexto.run({ client, usuarioId: usuarioId ?? null }, acao);
}

module.exports = { atual, executarCom };
