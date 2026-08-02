'use strict';

// Erro de contrato: entrada recusada na fronteira do sistema.
// Vira HTTP 400 e nunca carrega dado sensível na mensagem.
class ErroDeContrato extends Error {
  constructor(mensagem, campo = null) {
    super(mensagem);
    this.name = 'ErroDeContrato';
    this.campo = campo;
  }
}

module.exports = { ErroDeContrato };
