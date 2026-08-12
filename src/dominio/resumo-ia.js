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

const SISTEMA = [
  'Você escreve o resumo interno de um atendimento de WhatsApp de uma clínica de psiquiatria,',
  'para a equipe da clínica (não para o paciente).',
  'Use SOMENTE o que está na conversa. Não invente dados, não diagnostique, não aconselhe.',
  'Escreva em português do Brasil, direto, sem saudação e sem despedida.',
  'Formato obrigatório, nesta ordem (omita a linha se a conversa não disser):',
  'Nome: …',
  'Idade: …',
  'Motivo do contato: … (1 linha, nas palavras do paciente)',
  'Conversa: … (2 a 4 linhas: o que foi falado, o que a pessoa perguntou, o que foi respondido)',
  'Situação: … (agendou? dia e hora; valores discutidos; convênio; primeira consulta ou retorno)',
  'Pendência: … (o que falta resolver ou o próximo passo, se houver)',
  'Máximo de 900 caracteres no total.',
].join('\n');

const MAXIMO_DE_MENSAGENS = 60;
const MAXIMO_POR_MENSAGEM = 300;
const MAXIMO_DO_RESUMO = 1500;
const MINIMO_DO_RESUMO = 30;

/** A transcrição que a IA lê: papel de quem falou + texto, com teto de tamanho. */
function montarPromptDoResumo({ contato = null, mensagens = [], qualificacao = null }) {
  const linhas = [];

  if (contato?.nome) linhas.push(`Contato: ${contato.nome}`);

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
    async gerar({ contato = null, mensagens = [], qualificacao = null, chaveIdempotencia }) {
      if (!chaveIdempotencia) return null;
      if (!mensagens.some((mensagem) => String(mensagem?.conteudo ?? '').trim())) return null;
      try {
        const resultado = await gateway.gerar({
          finalidade: 'resumo_atendimento',
          sistema: SISTEMA,
          prompt: montarPromptDoResumo({ contato, mensagens, qualificacao }),
          chaveIdempotencia,
          promptVersion: 'resumo-v1',
        });
        return interpretarResumo(resultado?.resposta);
      } catch {
        return null;
      }
    },
  };
}

module.exports = { criarGeradorDeResumo, montarPromptDoResumo, interpretarResumo, SISTEMA };
