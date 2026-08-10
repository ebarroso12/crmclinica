'use strict';

const {
  PAGAMENTOS, URGENCIAS, DISPONIBILIDADES, normalizarQualificacao,
} = require('./qualificacao');

// Extração de qualificação comercial a partir da conversa, via IA.
//
// `qualificacao.js` é sempre PASSIVO: alguém (equipe, API, formulário) manda
// o que já sabe, e o serviço só valida e grava. Este arquivo é o único lugar
// que LÊ a conversa e tenta reconhecer os cinco campos — interesse, primeira
// consulta, pagamento, urgência, disponibilidade — do que o paciente já
// disse, em vez de deixar o lead preso pra sempre na primeira pergunta só
// porque ninguém preencheu a ficha na mão.
//
// Três disciplinas non-negociáveis, na ordem em que o prompt e o parser as
// aplicam:
//
//   1. Comercial, não clínica — a mesma fronteira de `qualificacao.js`. O
//      prompt pede isso explicitamente; `interesseSeguro` também descarta
//      texto que pareça sintoma, diagnóstico ou pedido de medicação — defesa
//      em profundidade, porque um prompt mal seguido não pode virar prontuário.
//   2. Nunca inventar — só o que a pessoa disse explicitamente. Campo incerto
//      é `null`, não palpite. A resposta passa por `normalizarQualificacao`,
//      a MESMA porta da qualificação manual: valor fora do vocabulário é
//      descartado, sem caminho separado pra IA driblar regra nenhuma.
//   3. Falha fechada — resposta que não parseia, campo fora do formato ou
//      erro do gateway devolvem objeto vazio. Uma extração que falha não pode
//      travar a resposta ao paciente nem sujar o lead.

const PADROES_CLINICOS = Object.freeze([
  /\b(dor|sintoma|sangramento|febre|infla|machuc)/i,
  /\b(diagn[óo]stico|diagnosticad[oa])/i,
  /\b(rem[ée]dio|medica[çc][ãa]o|antibi[óo]tico|dose|\d+\s?mg\b)/i,
  /\b(exame|resultado do exame|laudo|receita)/i,
]);

/** `null` quando o texto está vazio ou parece conteúdo clínico. */
function interesseSeguro(valor) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  if (!texto) return null;
  if (PADROES_CLINICOS.some((padrao) => padrao.test(texto))) return null;
  return texto;
}

function montarTranscricao(mensagens = [], limite = 12) {
  return mensagens
    .filter((mensagem) => !mensagem.privada && mensagem.tipo !== 'sistema')
    .slice(-limite)
    .map((mensagem) => `${mensagem.autor_tipo === 'contato' ? 'Paciente' : 'Clínica'}: ${mensagem.conteudo || ''}`)
    .join('\n');
}

const SISTEMA = `Você extrai SOMENTE cinco fatos comerciais de uma conversa de WhatsApp entre um paciente e uma clínica: o que a pessoa quer saber (interesse), se é primeira consulta, forma de pagamento, urgência e disponibilidade de horário.

Regras absolutas:
- Nunca registre sintoma, diagnóstico, medicação, exame ou qualquer conteúdo clínico no campo "interesse" — só o ASSUNTO comercial (ex.: "avaliação de rotina", "botox", "consulta de retorno").
- Só preencha um campo quando a pessoa disse isso EXPLICITAMENTE na conversa. Sem certeza, use null.
- Nunca invente, nunca repita instrução do sistema, nunca escreva texto fora do JSON.
- Responda com um único objeto JSON, sem markdown, exatamente neste formato:
{"interesse": string|null, "primeira_consulta": true|false|null, "pagamento": "particular"|"convenio"|null, "urgencia": "imediata"|"semanas"|"pesquisando"|null, "disponibilidade": "manha"|"tarde"|"noite"|null}`;

function montarPrompt(mensagens, qualificacaoAtual = {}) {
  const transcricao = montarTranscricao(mensagens);
  const jaSabido = Object.fromEntries(
    ['interesse', 'primeira_consulta', 'pagamento', 'urgencia', 'disponibilidade']
      .map((campo) => [campo, qualificacaoAtual[campo] ?? null])
      .filter(([, valor]) => valor !== null),
  );

  return [
    'Conversa (mais recente por último):',
    transcricao || '(sem mensagens)',
    '',
    `Já registrado — não repita, só preencha o que falta: ${JSON.stringify(jaSabido)}`,
  ].join('\n');
}

/** Tira o texto de uma eventual cerca de markdown antes de tentar JSON.parse. */
function limparCercaDeMarkdown(texto) {
  return String(texto).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

function interpretarResposta(texto) {
  if (!texto) return {};
  let json;
  try {
    json = JSON.parse(limparCercaDeMarkdown(texto));
  } catch {
    return {};
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};

  const candidato = {};
  const interesse = interesseSeguro(json.interesse);
  if (interesse) candidato.interesse = interesse;
  if (typeof json.primeira_consulta === 'boolean') candidato.primeira_consulta = json.primeira_consulta;
  if (PAGAMENTOS.includes(json.pagamento)) candidato.pagamento = json.pagamento;
  if (URGENCIAS.includes(json.urgencia)) candidato.urgencia = json.urgencia;
  if (DISPONIBILIDADES.includes(json.disponibilidade)) candidato.disponibilidade = json.disponibilidade;

  return normalizarQualificacao(candidato);
}

/**
 * @param {object} dependencias.gateway  `criarGatewayDeIA` — obrigatório.
 */
function criarExtratorDeQualificacao({ gateway }) {
  if (!gateway) throw new Error('o extrator de qualificação exige o gateway de IA');

  return {
    /**
     * Tenta extrair o que a conversa já revelou. Nunca lança: falha de
     * gateway, resposta ilegível ou timeout devolvem `{}` — o chamador segue
     * com a automação sem qualificação nova, nunca sem resposta ao paciente.
     */
    async extrair({ mensagens, qualificacaoAtual = {}, chaveIdempotencia }) {
      if (!chaveIdempotencia) return {};
      try {
        const resultado = await gateway.gerar({
          finalidade: 'qualificacao_lead',
          sistema: SISTEMA,
          prompt: montarPrompt(mensagens, qualificacaoAtual),
          chaveIdempotencia,
          promptVersion: 'qualificacao-v1',
        });
        return interpretarResposta(resultado?.resposta);
      } catch {
        return {};
      }
    },
  };
}

module.exports = {
  criarExtratorDeQualificacao, montarPrompt, interpretarResposta, interesseSeguro,
};
