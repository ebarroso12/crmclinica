'use strict';

// A URL canônica ÚNICA do formulário de pré-consulta.
//
// Regra do produto, sem exceção: todo formulário de pré-consulta enviado pelo
// CRM ou pela Serena — adulto, criança, adolescente, primeira consulta,
// retorno, convênio, qualquer situação — usa exatamente este endereço.
//
// Por que uma constante e não uma variável de ambiente:
//
//   Um link configurável é um link que pode divergir entre ambientes sem que
//   ninguém perceba, e o modo de falhar aqui é mandar ao paciente um
//   questionário que não é o dele. Já aconteceu: paciente adulto recebeu
//   questionário infantil. Uma constante versionada torna a divergência
//   visível no diff e testável na suíte (ver
//   `testes/formulario-pre-consulta-link-unico.test.js`, que falha se
//   QUALQUER outro link de pré-consulta aparecer no código enviado).
//
//   Se um dia o endereço mudar, muda AQUI, num commit, com revisão — não por
//   alguém editando um `.env` no servidor às pressas.
//
// Por que não há escolha por idade ou tipo de consulta:
//
//   O formulário é um só. Qualquer ramificação (adulto/criança, primeira
//   consulta/retorno) reintroduz exatamente a classe de bug que esta regra
//   existe para eliminar. Nenhuma função deste módulo aceita idade, faixa
//   etária, tipo de consulta ou qualquer parâmetro capaz de alterar a URL.

const URL_FORMULARIO_PRE_CONSULTA = 'https://formulario.edsonbarrosojr.com.br/';

/**
 * O link do formulário de pré-consulta. Sempre o mesmo, para todo mundo.
 *
 * Não recebe argumentos de propósito: não existe "o link do formulário
 * infantil" nem "o link do retorno" para este sistema poder devolver.
 */
function linkDoFormularioPreConsulta() {
  return URL_FORMULARIO_PRE_CONSULTA;
}

/**
 * O texto que acompanha o envio do formulário.
 *
 * `nome` é só cortesia na abertura — não influencia o link, e o link é
 * montado a partir da constante acima, nunca de string interpolada por quem
 * chama. Quem quiser outro texto continua obrigado a usar este mesmo link.
 */
function mensagemDeFormularioPreConsulta({ nome = null } = {}) {
  const abertura = nome ? `${nome}, sua consulta está confirmada!` : 'Sua consulta está confirmada!';
  return `${abertura} Para o Dr. Edson Barroso conhecer sua história antes do atendimento, `
    + `preencha o formulário de pré-consulta: ${URL_FORMULARIO_PRE_CONSULTA}\n\n`
    + 'Conforme a Lei Geral de Proteção de Dados, suas informações são sigilosas '
    + 'e somente o Dr. Edson tem acesso a este formulário.';
}

module.exports = {
  URL_FORMULARIO_PRE_CONSULTA,
  linkDoFormularioPreConsulta,
  mensagemDeFormularioPreConsulta,
};
