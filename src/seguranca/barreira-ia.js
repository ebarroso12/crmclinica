'use strict';

// O que o modelo devolveu pode sair?
//
// Esta é a camada que falha FECHADA. A cerca de entrada (`prompt-seguro.js`)
// reduz a chance de uma instrução de fora pegar; aqui se confere o que de fato
// saiu, e na dúvida não sai. As duas precisam existir porque nenhuma das duas
// é suficiente: prompt é probabilístico, e o custo do erro aqui não é uma
// resposta feia — é dado clínico de um paciente no WhatsApp de outro.
//
// ------------------------------------------------------------------ o destino
//
// A regra não pode ser a mesma para tudo, e é aqui que a maioria das
// implementações erra. O centro operacional PRECISA falar de prontuário e de
// erro técnico com a equipe; o relatório de métricas PRECISA citar números
// internos. Aplicar a barreira estrita neles não deixaria o sistema mais
// seguro: deixaria os relatórios vazios, e alguém desligaria a barreira.
//
// Então o que decide é para ONDE a resposta vai:
//
//   • `paciente` — a resposta será entregue por WhatsApp/Instagram a alguém de
//     fora da clínica. Barreira estrita, falha fechada.
//   • `equipe`  — fica dentro do CRM, para quem já tem acesso àquele dado por
//     RBAC e RLS. Confere-se só o que nunca deveria aparecer em lugar nenhum
//     (o texto das instruções internas), e o teto de tamanho.
//
// Finalidade nova nasce como `paciente`: o padrão seguro é o restritivo, e
// quem criar uma finalidade que fala com a equipe declara isso de propósito.

/**
 * Para onde vai a resposta de cada finalidade do gateway.
 *
 * Manter esta tabela ao lado da barreira, e não espalhada pelas chamadas, é o
 * que permite auditar num lugar só a pergunta "o que deste sistema chega a um
 * paciente?".
 */
const DESTINO_POR_FINALIDADE = Object.freeze({
  // Falam com quem está do outro lado da conversa.
  agente_resposta: 'paciente',
  orientacao_compilada: 'paciente',
  agente_inatividade: 'paciente',
  // Ficam dentro do CRM.
  agente_resumo: 'equipe',
  resumo_atendimento: 'equipe',
  qualificacao_lead: 'equipe',
  relatorio_metricas: 'equipe',
  centro_parecer: 'equipe',
  centro_reparo: 'equipe',
  centro_reparo_executavel: 'equipe',
});

function destinoDaFinalidade(finalidade) {
  return DESTINO_POR_FINALIDADE[finalidade] ?? 'paciente';
}

/**
 * Bastidor: texto escrito para um colega, que não pode chegar ao paciente.
 *
 * Veio de `orientacao.js`, onde nasceu para um caso só, e subiu para cá porque
 * o risco é de toda resposta que sai — não daquele fluxo.
 */
const MARCAS_DE_BASTIDOR = [
  /\bprontu[áa]rio\b/i,
  /\bdiagn[óo]stic/i,
  /\bCID[\s-]?\d/i,
  /\bexame\s+(?:deu|mostrou|indicou)\b/i,
  // Recado para a equipe, não para o paciente.
  /\bn[ãa]o\s+(?:fala|diga|conta|mencione)\b/i,
  /\bentre\s+n[óo]s\b/i,
  /\bpara\s+a\s+equipe\b/i,
];

/**
 * Marcas de INVERSÃO: a resposta está devolvendo o que o sistema sabe, em vez
 * de responder ao paciente.
 *
 * É o sinal de que um ataque de extração funcionou — seja para reconstruir a
 * instrução do sistema, seja para puxar o contexto de outros atendimentos que
 * viajou no prompt. Vale nos DOIS destinos: nem para a equipe a assistente deve
 * despejar o próprio prompt numa mensagem de atendimento.
 */
const MARCAS_DE_INVERSAO = [
  /\b(minhas|as)\s+instru[çc][õo]es\s+(s[ãa]o|dizem|foram)\b/i,
  /\b(system|prompt)\s+(prompt|do\s+sistema)\b/i,
  /\bfui\s+(instru[íi]d[oa]|program[a-z]*)\s+(a|para)\b/i,
  /\bcomo\s+um\s+modelo\s+de\s+linguagem\b/i,
  /<<<CONTEUDO_EXTERNO_(INICIO|FIM)>>>/,
  // O marcador interno do fluxo de orientação nunca deve sair inteiro.
  /\[\[\s*ORIENTAR\b/i,
];

/**
 * Dado pessoal de terceiro numa resposta ao paciente.
 *
 * Um CPF ou um telefone completo na resposta é, quase sempre, contexto de OUTRA
 * pessoa vazando — a assistente não tem por que ditar documento para ninguém.
 * Fica restrito ao destino `paciente`: para a equipe, telefone em resumo é o
 * funcionamento normal da ficha.
 */
const MARCAS_DE_PII = [
  // CPF com ou sem pontuação.
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  // Telefone brasileiro completo com DDD.
  /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g,
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
];

/** Só os dígitos, para comparar telefone escrito de jeitos diferentes. */
function digitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * O contato da PRÓPRIA clínica não é vazamento — é atendimento.
 *
 * Sem esta permissão a barreira barraria "nosso telefone é (16) 3333-4444", que
 * é exatamente o que a assistente existe para dizer. Uma barreira que atrapalha
 * o trabalho legítimo é uma barreira que alguém desliga, e aí ela não protege
 * mais nada — este é o falso positivo que decide se a defesa sobrevive.
 *
 * A comparação é por dígitos e pelo FIM do número: o mesmo telefone aparece com
 * e sem o 55, com e sem o 9, com e sem parênteses.
 */
function ehContatoDaClinica(achado, permitidos) {
  const alvo = digitos(achado);
  if (alvo.length === 0) {
    // Não é telefone: é e-mail. Compara em minúsculas, inteiro.
    return permitidos.some((p) => String(p).toLowerCase() === achado.toLowerCase());
  }
  return permitidos.some((permitido) => {
    const base = digitos(permitido);
    if (base.length < 8) return false;
    const curto = base.slice(-8);
    return alvo.endsWith(curto);
  });
}

/** Teto de tamanho por destino. Resposta gigante é sinal de despejo de contexto. */
const LIMITE_POR_DESTINO = Object.freeze({ paciente: 900, equipe: 8000 });

/**
 * A conferência.
 *
 * @param {string} resposta     O que o modelo devolveu.
 * @param {object} opcoes
 * @param {string} opcoes.finalidade  A finalidade da chamada no gateway.
 * @param {string} [opcoes.origem]    Texto interno que a resposta NÃO pode
 *   copiar (a orientação da equipe, por exemplo). Copiar é o modo mais comum
 *   de vazar bastidor: se sai quase igual, não houve compilação nenhuma.
 * @param {string[]} [opcoes.contatosDaClinica]  Telefones e e-mails da própria
 *   clínica, que podem sair — ver `ehContatoDaClinica`.
 * @returns {{ pode: boolean, motivo: string|null, destino: string }}
 */
function respostaPodeSair(resposta, { finalidade, origem = null, contatosDaClinica = [] } = {}) {
  const destino = destinoDaFinalidade(finalidade);
  const limpo = String(resposta ?? '').trim();

  if (!limpo) return { pode: false, motivo: 'a IA não devolveu texto', destino };

  const limite = LIMITE_POR_DESTINO[destino];
  if (limpo.length > limite) {
    return { pode: false, motivo: `resposta longa demais para ${destino} (${limpo.length} > ${limite})`, destino };
  }

  // Inversão vale nos dois destinos.
  for (const marca of MARCAS_DE_INVERSAO) {
    if (marca.test(limpo)) return { pode: false, motivo: `a resposta expõe instrução interna (${marca})`, destino };
  }

  if (destino !== 'paciente') return { pode: true, motivo: null, destino };

  for (const marca of MARCAS_DE_BASTIDOR) {
    if (marca.test(limpo)) return { pode: false, motivo: `a resposta repete bastidor (${marca})`, destino };
  }

  for (const marca of MARCAS_DE_PII) {
    // `matchAll` porque precisamos do QUE casou, para perguntar se é o contato
    // da própria clínica. E porque `test` com flag `g` guarda `lastIndex`, o
    // que faria a mesma chamada alternar resultado entre execuções.
    for (const achado of limpo.matchAll(marca)) {
      if (ehContatoDaClinica(achado[0], contatosDaClinica)) continue;
      return { pode: false, motivo: 'a resposta carrega dado pessoal identificável', destino };
    }
  }

  const original = String(origem ?? '').trim();
  if (original && limpo.length > 40 && original.includes(limpo.slice(0, 40))) {
    return { pode: false, motivo: 'a resposta é o texto interno copiado, não compilado', destino };
  }

  return { pode: true, motivo: null, destino };
}

module.exports = {
  respostaPodeSair,
  destinoDaFinalidade,
  DESTINO_POR_FINALIDADE,
  MARCAS_DE_BASTIDOR,
  MARCAS_DE_INVERSAO,
  MARCAS_DE_PII,
  LIMITE_POR_DESTINO,
};
