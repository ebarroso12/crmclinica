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

// Erro de estratégia de IA: o evento é bem formado, mas ninguém confiável disse
// quem responde por ele — ou alguém disse algo que a porta de entrada não pode
// aceitar. Vira HTTP 422: não é sintaxe (400), é semântica recusada.
//
// Falhar fechado aqui é o ponto: um evento de WhatsApp sem dono declarado que
// caísse no fluxo de despacho faria o CRM reenviar ao agente uma mensagem que o
// agente já viu — e o paciente receberia duas respostas para uma pergunta.
class ErroDeEstrategia extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroDeEstrategia';
    this.status = 422;
    this.codigo = codigo;
  }
}

module.exports = { ErroDeContrato, ErroDeEstrategia };
