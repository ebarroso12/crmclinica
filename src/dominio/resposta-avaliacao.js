'use strict';

// O agente que responde às avaliações do Google Meu Negócio.
//
// ------------------------------------------------------- a regra que manda
//
// Este consultório é de saúde mental. Responder publicamente a uma avaliação
// tem um limite que não é de estilo, é de ética profissional: **a resposta não
// pode confirmar que quem avaliou é paciente**, nem citar data, procedimento,
// diagnóstico, tratamento ou qualquer detalhe do atendimento — nem mesmo para
// corrigir uma informação errada. O sigilo não se suspende porque a outra
// pessoa falou primeiro.
//
// Por isso o texto padrão agradece sem dizer "obrigado pela consulta", lamenta
// sem dizer "lamento que seu tratamento", e oferece um canal privado em vez de
// discutir em público. `validarResposta` é o que impede um texto fora dessa
// linha de sair — inclusive um texto escrito pela IA.
//
// ------------------------------------------------- o que nunca é automático
//
// Avaliação de 3 estrelas ou menos NUNCA é respondida sozinha. Uma reclamação
// pública é onde um médico se machuca, e a resposta certa depende de contexto
// que só uma pessoa tem. O agente escreve a sugestão e para: quem publica é
// gente.

const { normalizarParaComparacao } = require('./texto-normalizado');

/** Teto de caracteres da resposta pública. Curto é mais seguro e se lê melhor. */
const LIMITE_RESPOSTA = 350;

/** A partir de quantas estrelas a resposta pode sair sozinha. */
const ESTRELAS_PARA_AUTOMATICO = 4;

// Cada padrão mapeia uma vedação concreta. O motivo viaja junto: veredito sem
// motivo não ensina ninguém a escrever melhor da próxima vez.
const VEDACOES = Object.freeze([
  {
    padrao: /\b(sua consulta|seu atendimento|seu tratamento|sua sessao|na sua consulta|quando voce (veio|esteve|passou)|nosso paciente|nossa paciente|foi atendid|obrigad[oa] pela (consulta|sessao|visita))/i,
    motivo: 'confirma que a pessoa é paciente — o sigilo não permite, nem em resposta pública',
  },
  {
    padrao: /\b(diagnostic|medicac|remedio|dose|posologia|receita|laudo|tdah|autism|bipolar|depress|ansiedade|transtorno|terapia|psicoterapia)/i,
    motivo: 'cita conteúdo clínico — detalhe de atendimento não vai para resposta pública',
  },
  {
    padrao: /\b(garant|cura(mos|do|da)?|100%|resultado garantido|melhor medico|unico especialista)/i,
    motivo: 'promessa de resultado ou autopromoção — vedado pela publicidade médica',
  },
  {
    padrao: /\b(mentira|mentiroso|difama|caluni|processar|advogad|inveridic|absurd|mal.?educad|falso relato|nao foi bem assim)/i,
    motivo: 'discute ou acusa em público — resposta a reclamação não é debate',
  },
  {
    padrao: /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b([01]?\d|2[0-3]):[0-5]\d\b/,
    motivo: 'menciona data ou horário — é detalhe de atendimento',
  },
]);

const SINAIS_DE_AGRADECIMENTO = /\b(obrigad|agradec|grato|gratid)/i;

/**
 * Confere um texto de resposta contra as vedações. Devolve a lista de motivos
 * — vazia quando o texto pode sair.
 *
 * Vale para o texto da IA e para o texto escrito à mão na tela: a barreira é
 * do canal, não do autor.
 */
function validarResposta(texto) {
  const limpo = String(texto ?? '').trim();
  const problemas = [];

  if (!limpo) return ['a resposta está vazia'];
  if (limpo.length > LIMITE_RESPOSTA) {
    problemas.push(`a resposta passa de ${LIMITE_RESPOSTA} caracteres`);
  }
  // Normalizado: nem a vedação nem o agradecimento podem depender de acento
  // ou caixa. "DIAGNÓSTICO" e "diagnostico" são a mesma coisa aqui, e
  // "Agradeço" com cedilha precisa contar como agradecimento.
  const normalizado = normalizarParaComparacao(limpo);

  if (!SINAIS_DE_AGRADECIMENTO.test(normalizado) && !SINAIS_DE_AGRADECIMENTO.test(limpo)) {
    problemas.push('a resposta não agradece — foi o primeiro pedido da clínica');
  }

  for (const vedacao of VEDACOES) {
    if (vedacao.padrao.test(normalizado) || vedacao.padrao.test(limpo)) problemas.push(vedacao.motivo);
  }

  return problemas;
}

/**
 * O texto de reserva — determinístico, mesma avaliação, mesmo texto.
 *
 * Existe porque resposta atrasada é aceitável e resposta nenhuma não é: se a
 * IA cair ou escrever algo que a barreira recusa, este texto sai no lugar.
 */
function textoDeReserva({ estrelas, canalPrivado = null }) {
  const contato = canalPrivado
    ? ` Se quiser falar com a gente, é só chamar em ${canalPrivado}.`
    : ' Estamos à disposição pelos nossos canais de atendimento.';

  if (Number(estrelas) >= ESTRELAS_PARA_AUTOMATICO) {
    return `Muito obrigado pelo carinho e por reservar um tempo para avaliar o consultório.${contato}`;
  }

  // Nota baixa: agradece, não se defende, não pergunta o que aconteceu em
  // público — e leva a conversa para onde ela pode acontecer com sigilo.
  return `Obrigado por reservar um tempo para deixar seu retorno. Levamos cada mensagem a sério.${contato}`;
}

/**
 * @param {object} dependencias.gerador  opcional: escreve a resposta com IA.
 *   Sem ele (ou quando o texto da IA é recusado pela barreira), vale o texto
 *   de reserva — no mesmo formato, só menos personalizado.
 * @param {boolean} dependencias.autoPublicar  publica sozinho as avaliações
 *   de 4-5 estrelas. Nota baixa nunca é automática, com ou sem esta chave.
 */
function criarAgenteDeAvaliacoes({
  gerador = null, canalPrivado = null, autoPublicar = false,
} = {}) {
  /**
   * Decide o que fazer com UMA avaliação e devolve o texto pronto.
   *
   * Não publica nada: quem publica é quem tem o cliente do Google na mão (ver
   * `src/integracoes/google-avaliacoes.js`). Aqui é só a decisão e o texto —
   * é o que torna esta regra testável sem tocar a rede.
   */
  async function responder(avaliacao = {}) {
    const estrelas = Number(avaliacao.estrelas);
    const reserva = textoDeReserva({ estrelas, canalPrivado });

    let texto = reserva;
    let origem = 'reserva';

    if (gerador?.gerar) {
      try {
        const daIa = await gerador.gerar({
          estrelas,
          comentario: avaliacao.comentario ?? null,
          autor: avaliacao.autor ?? null,
          chaveIdempotencia: `avaliacao:${avaliacao.id ?? 'sem-id'}`,
        });
        const problemasDaIa = daIa ? validarResposta(daIa) : ['a IA não devolveu texto'];
        if (problemasDaIa.length === 0) {
          texto = String(daIa).trim();
          origem = 'ia';
        } else {
          // Recusa da barreira não é erro do sistema: é a barreira fazendo o
          // trabalho dela. Fica no log com o motivo, para o prompt melhorar.
          console.warn(`[avaliacoes] texto da IA recusado (${problemasDaIa.join('; ')}) — usando o de reserva`);
        }
      } catch (erro) {
        console.error(`[avaliacoes] gerador indisponível (${erro.message}) — usando o de reserva`);
      }
    }

    const problemas = validarResposta(texto);
    if (problemas.length > 0) {
      // A reserva falhar na própria barreira é defeito de código, não de
      // conteúdo — e não pode virar publicação.
      return { publicar: false, texto: null, origem, motivo: 'texto_recusado', problemas };
    }

    const positiva = Number.isFinite(estrelas) && estrelas >= ESTRELAS_PARA_AUTOMATICO;

    return {
      texto,
      origem,
      estrelas: Number.isFinite(estrelas) ? estrelas : null,
      // Nota baixa é sempre rascunho. Uma reclamação pública é onde um médico
      // se machuca, e a resposta certa depende de contexto que só uma pessoa
      // tem — o agente escreve a sugestão e para.
      publicar: autoPublicar === true && positiva,
      motivo: positiva
        ? (autoPublicar === true ? 'avaliacao_positiva_automatica' : 'publicacao_automatica_desligada')
        : 'nota_baixa_exige_pessoa',
    };
  }

  return { responder, validarResposta, LIMITE_RESPOSTA, ESTRELAS_PARA_AUTOMATICO };
}

module.exports = {
  criarAgenteDeAvaliacoes,
  validarResposta,
  textoDeReserva,
  LIMITE_RESPOSTA,
  ESTRELAS_PARA_AUTOMATICO,
};
