'use strict';

// Jornada do lead: do primeiro contato ao retorno.
//
// O estágio atual responde "onde está?". A jornada responde "como chegou aqui, e
// quando?" — que é a pergunta que a clínica realmente faz quando um lead esfria.
// Por isso cada mudança vira um evento que não se reescreve.

const ETAPAS = Object.freeze(['novo', 'qualificando', 'agendado', 'convertido', 'perdido']);

// Rótulos e o que cada etapa significa na prática da recepção.
const DESCRICAO = Object.freeze({
  novo: { rotulo: 'Novos', significa: 'chegou e ainda não foi qualificado' },
  qualificando: { rotulo: 'Qualificando', significa: 'já se sabe o que procura; falta fechar horário' },
  agendado: { rotulo: 'Agendados', significa: 'tem consulta marcada' },
  convertido: { rotulo: 'Convertidos', significa: 'compareceu à consulta' },
  perdido: { rotulo: 'Perdidos', significa: 'desistiu, sumiu ou não era o público' },
});

// Transições permitidas. A lista é curta e explícita porque um lead que pula de
// "novo" direto para "convertido" quase sempre é erro de clique, não milagre.
const TRANSICOES = Object.freeze({
  novo: ['qualificando', 'agendado', 'perdido'],
  qualificando: ['agendado', 'perdido', 'novo'],
  // Agendado volta para qualificando quando a pessoa desmarca e segue interessada.
  agendado: ['convertido', 'qualificando', 'perdido'],
  // Convertido pode voltar à fila: retorno é um lead novo da mesma pessoa.
  convertido: ['qualificando', 'agendado'],
  perdido: ['qualificando', 'novo'],
});

function transicaoPermitida(de, para) {
  if (!ETAPAS.includes(para)) return false;
  if (!de) return para === 'novo';
  if (de === para) return false;
  return (TRANSICOES[de] ?? []).includes(para);
}

/** Erro de transição, com as opções válidas — a mensagem precisa ensinar o caminho. */
class ErroDeJornada extends Error {
  constructor(de, para) {
    super(`não é possível mover de "${de ?? 'nenhum'}" para "${para}"`);
    this.name = 'ErroDeJornada';
    this.status = 409;
    this.de = de;
    this.para = para;
    this.permitidas = TRANSICOES[de] ?? [];
  }
}

/**
 * O estágio que a qualificação sugere.
 * Só sugere avanço: nunca puxa um lead para trás, porque recuar é decisão da
 * equipe (ou consequência de um agendamento desfeito), não de um cálculo.
 */
function estagioSugerido(lead = {}, camposPendentes = []) {
  if (['agendado', 'convertido', 'perdido'].includes(lead.estagio)) return lead.estagio;

  // Sabendo o que a pessoa procura, ela deixou de ser só "novo".
  const comecouAQualificar = camposPendentes.length < 5;
  return comecouAQualificar ? 'qualificando' : 'novo';
}

/**
 * Monta o evento de jornada a ser gravado.
 * `origem` distingue o que a equipe fez do que a automação fez — sem isso, a
 * trilha vira uma lista de mudanças sem responsável.
 */
function montarEvento({
  leadId, conversaId = null, tipo, de = null, para = null,
  detalhe = null, origem = 'sistema', usuarioId = null,
}) {
  return {
    lead_id: leadId,
    conversa_id: conversaId,
    tipo,
    de,
    para,
    detalhe,
    origem,
    usuario_id: usuarioId,
  };
}

/** Resume a jornada para exibição: primeira e última etapa, e quanto tempo levou. */
function resumir(eventos = []) {
  const deEstagio = eventos.filter((evento) => evento.tipo === 'estagio');
  if (deEstagio.length === 0) return { etapas: 0, primeiro: null, ultimo: null, duracaoHoras: null };

  const ordenados = [...deEstagio].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const primeiro = ordenados[0];
  const ultimo = ordenados.at(-1);

  return {
    etapas: ordenados.length,
    primeiro: { para: primeiro.para, em: primeiro.criado_em },
    ultimo: { para: ultimo.para, em: ultimo.criado_em },
    duracaoHoras: Math.round(
      (new Date(ultimo.criado_em) - new Date(primeiro.criado_em)) / 3_600_000 * 10,
    ) / 10,
  };
}

module.exports = {
  ETAPAS,
  DESCRICAO,
  TRANSICOES,
  transicaoPermitida,
  estagioSugerido,
  montarEvento,
  resumir,
  ErroDeJornada,
};
