'use strict';

// O resumo do atendimento escrito por IA — o que a equipe lê no celular.
//
// O resumo por recorte (regex de idade, primeira frase como "queixa") produzia
// mensagens sem contexto: quando o padrão não casava, chegava "Idade: não
// informada / Queixa: não relatada" — e quem recebia não fazia ideia do que a
// conversa tinha sido. A reclamação veio de quem recebe: "horríveis, sem
// contexto, sem resumo do que foi falado".
//
// Este módulo pede à IA um resumo de verdade, nas regras da casa:
//
//   • só o que está NA conversa — inventar dado clínico ou de agenda é pior
//     que não resumir;
//   • sem diagnóstico: relatar o que o paciente disse é recorte, interpretar
//     sintoma é atividade clínica, e resumo não é prontuário;
//   • curto, em ordem fixa, porque quem lê está entre um paciente e outro.
//
// Falha fechada: gateway fora, resposta vazia ou ilegível devolvem `null` — e
// quem chama usa o resumo por recorte, que continua existindo como reserva.
// Resumo atrasado ou simples é aceitável; resumo inventado, nunca.

// O corpo segue o formato que a equipe aprovou no RESUMO DE LEAD. Telefone,
// qualificação e estágio NÃO entram aqui: vêm do banco, no cabeçalho.
//
// A regra "nas palavras da pessoa" não é estilo, é fronteira clínica: pedir "o
// que a pessoa busca" sem ela convida o modelo a caracterizar quadro ("busca
// tratamento para ansiedade") — e caracterização clínica circulando no WhatsApp
// da equipe sem profissional no circuito é exatamente o que este produto não
// faz. Citar é permitido; interpretar, nunca.
const SISTEMA = [
  'Você escreve o resumo interno de um atendimento de WhatsApp de uma clínica de psiquiatria,',
  'para a equipe da clínica (não para o paciente).',
  'Use SOMENTE o que está na conversa. Não invente dados, não diagnostique, não aconselhe.',
  'Nunca caracterize quadro clínico: cite o que a pessoa DISSE, nas palavras dela, sem interpretar.',
  'Escreva em português do Brasil, direto, sem saudação e sem despedida.',
  'Formato obrigatório, nesta ordem (omita a linha se a conversa não disser nada sobre ela):',
  'Nome citado: … (apenas se a pessoa disser o próprio nome, ou o de quem é a consulta, na conversa)',
  'Idade: … (apenas se dita na conversa; diga de quem é, se for de outra pessoa)',
  'Procura: … (o que a pessoa busca e para quem, 1 a 2 linhas, nas palavras dela)',
  'Situacao: … (o que ficou combinado ou decidido; valores discutidos; convênio; dados ou comprovantes enviados)',
  'Falta: … (o que a equipe da clínica ainda precisa fazer)',
  'Duvida: … (perguntas do paciente que ficaram sem resposta)',
  'Não repita o telefone — a equipe já o recebe em outro lugar.',
  'Máximo de 700 caracteres no total.',
].join('\n');

// Muda o prompt, muda a versão — e a versão entra na chave de idempotência.
// O cache do gateway devolve pelo par chave→resposta; sem a versão na chave,
// um resumo gerado com o prompt antigo voltaria para sempre por baixo do
// cabeçalho novo, e nenhum deploy consertaria.
const PROMPT_VERSION = 'resumo-lead-v2';

const MAXIMO_DE_MENSAGENS = 60;
const MAXIMO_POR_MENSAGEM = 300;
const MAXIMO_DO_RESUMO = 1500;
const MINIMO_DO_RESUMO = 30;

/**
 * A transcrição que a IA lê: papel de quem falou + texto, com teto de tamanho.
 *
 * O nome do cadastro NÃO entra de propósito: o cabeçalho já o carrega, e
 * injetá-lo aqui fazia o modelo repeti-lo no corpo — a linha "Nome citado"
 * existe para o caso oposto, o nome que só aparece NA conversa.
 */
function montarPromptDoResumo({ mensagens = [], qualificacao = null }) {
  const linhas = [];

  // O que a extração de qualificação já apurou entra como apoio — a IA não
  // precisa redescobrir, só conferir com a conversa.
  const apoio = ['interesse', 'pagamento', 'urgencia', 'disponibilidade']
    .filter((campo) => qualificacao?.[campo])
    .map((campo) => `${campo}: ${qualificacao[campo]}`);
  if (typeof qualificacao?.primeira_consulta === 'boolean') {
    apoio.push(`primeira_consulta: ${qualificacao.primeira_consulta ? 'sim' : 'não'}`);
  }
  if (apoio.length > 0) linhas.push(`Qualificação já registrada: ${apoio.join(' · ')}`);

  linhas.push('', 'Conversa (na ordem):');
  for (const mensagem of mensagens.slice(-MAXIMO_DE_MENSAGENS)) {
    const texto = String(mensagem.conteudo ?? '').trim();
    if (!texto) continue;
    const papel = mensagem.autor_tipo === 'contato' ? 'Paciente' : 'Clínica';
    linhas.push(`${papel}: ${texto.length > MAXIMO_POR_MENSAGEM ? `${texto.slice(0, MAXIMO_POR_MENSAGEM)}…` : texto}`);
  }

  return linhas.join('\n');
}

/**
 * O texto que a IA devolveu, se for utilizável.
 *
 * Curto demais não é resumo, é falha do modelo; e o teto protege o WhatsApp da
 * equipe de um modelo tagarela. Nos dois casos de recusa, devolve `null` e o
 * chamador cai no resumo por recorte.
 */
function interpretarResumo(resposta) {
  const texto = String(resposta ?? '').trim();
  if (texto.length < MINIMO_DO_RESUMO) return null;
  return texto.length > MAXIMO_DO_RESUMO ? `${texto.slice(0, MAXIMO_DO_RESUMO - 1)}…` : texto;
}

/**
 * @param {object} dependencias.gateway  `criarGatewayDeIA` — obrigatório.
 */
function criarGeradorDeResumo({ gateway }) {
  if (!gateway) throw new Error('o gerador de resumo exige o gateway de IA');

  return {
    /** Nunca lança: qualquer falha devolve `null` e o chamador usa a reserva. */
    async gerar({ mensagens = [], qualificacao = null, chaveIdempotencia }) {
      if (!chaveIdempotencia) return null;
      if (!mensagens.some((mensagem) => String(mensagem?.conteudo ?? '').trim())) return null;
      try {
        const resultado = await gateway.gerar({
          finalidade: 'resumo_atendimento',
          sistema: SISTEMA,
          prompt: montarPromptDoResumo({ mensagens, qualificacao }),
          // A versão compõe a chave: prompt novo nunca reusa resposta do velho.
          chaveIdempotencia: `${chaveIdempotencia}:${PROMPT_VERSION}`,
          promptVersion: PROMPT_VERSION,
        });
        return interpretarResumo(resultado?.resposta);
      } catch {
        return null;
      }
    },
  };
}

module.exports = {
  criarGeradorDeResumo, montarPromptDoResumo, interpretarResumo, SISTEMA, PROMPT_VERSION,
};
