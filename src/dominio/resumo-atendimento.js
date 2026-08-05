'use strict';

// Resumo do atendimento, enviado à equipe quando a conversa esfria.
//
// Sem isto, saber como foi a noite exige abrir o painel e ler conversa por
// conversa — o que ninguém faz antes do primeiro café. A informação que importa
// (quem procurou, o que queria, se marcou) chega tarde ou não chega.
//
// ------------------------------------------------------ o que decide o momento
//
// Não existe evento de "conversa terminou": ninguém se despede no WhatsApp. O
// que existe é silêncio — e silêncio prolongado é o sinal mais honesto de que o
// atendimento acabou.
//
// Esperar demais atrasa a informação; esperar de menos manda resumo de conversa
// que ainda está acontecendo, e a equipe recebe dois ou três da mesma pessoa.
// Trinta minutos é o intervalo em que uma conversa de WhatsApp já morreu sem que
// a informação tenha envelhecido.
//
// ---------------------------------------------------------------- o conteúdo
//
// Nome, idade, queixa, se agendou e se recebeu o formulário — o que o Dr. Edson
// pediu, nessa ordem, porque é a ordem em que ele lê.
//
// A queixa vem do que o paciente escreveu, sem interpretação: resumir sintoma é
// atividade clínica, e este módulo não faz isso. Ele recorta e cita.

const SILENCIO_PADRAO_MIN = 30;

/** Idade dita em texto: "tenho 34", "34 anos", "meu filho de 8". */
function extrairIdade(mensagens) {
  for (const mensagem of mensagens) {
    if (mensagem.autor_tipo !== 'contato') continue;

    const achado = String(mensagem.conteudo ?? '')
      .match(/\b(\d{1,3})\s*anos?\b|\btenho\s+(\d{1,3})\b|\bde\s+(\d{1,2})\s*anos?\b/i);

    const idade = Number(achado?.[1] ?? achado?.[2] ?? achado?.[3]);
    // Acima de 120 é ano ("nasci em 1990") ou número de outra coisa.
    if (Number.isInteger(idade) && idade > 0 && idade <= 120) return idade;
  }
  return null;
}

/**
 * A queixa, nas palavras do paciente.
 *
 * Pega a primeira mensagem dele com conteúdo — a saudação sozinha não conta,
 * porque "oi" não é queixa e mandar isso à equipe é ruído.
 */
function extrairQueixa(mensagens) {
  const SAUDACAO = /^(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[íi]|opa)[\s!.,]*$/i;
  // Resposta curta ao que a Serena perguntou não é queixa. Mandá-la à equipe
  // como se fosse produziria resumos dizendo que o paciente reclamou de "sim".
  const RESPOSTA = /^(sim|n[ãa]o|ok|certo|claro|isso|pode ser|por favor|por gentileza|obrigad[oa])[\s!.,]*/i;

  for (const mensagem of mensagens) {
    if (mensagem.autor_tipo !== 'contato') continue;

    const texto = String(mensagem.conteudo ?? '').trim();
    if (!texto || SAUDACAO.test(texto)) continue;

    // Frase curta que começa com afirmação é resposta; frase longa que começa
    // com "sim" costuma continuar contando o caso ("sim, faz um mês que…").
    if (RESPOSTA.test(texto) && texto.length < 60) continue;

    return texto.length > 240 ? `${texto.slice(0, 237)}…` : texto;
  }
  return null;
}

/** O formulário de pré-consulta foi oferecido? */
function ofereceuFormulario(mensagens) {
  return mensagens.some((mensagem) => mensagem.autor_tipo !== 'contato'
    && /question[áa]rio|formul[áa]rio|pr[ée]-consulta/i.test(String(mensagem.conteudo ?? '')));
}

/**
 * Monta o texto que vai para a equipe.
 *
 * Curto e em ordem fixa: quem lê está no celular, entre um paciente e outro, e
 * precisa achar a informação sem procurar.
 */
function montarResumo({ contato, mensagens = [], agendamento = null, agora = new Date() }) {
  const idade = extrairIdade(mensagens);
  const queixa = extrairQueixa(mensagens);
  const doPaciente = mensagens.filter((m) => m.autor_tipo === 'contato').length;

  const quando = agendamento
    ? new Date(agendamento.inicio).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    : null;

  const linhas = [
    'Atendimento encerrado',
    '',
    `Nome: ${contato?.nome?.trim() || 'não informado'}`,
    `Idade: ${idade ?? 'não informada'}`,
    `Telefone: ${contato?.telefone ?? '—'}`,
    '',
    `Queixa: ${queixa ?? 'não relatada'}`,
    '',
    agendamento ? `Agendou: SIM — ${quando}` : 'Agendou: NÃO',
    `Formulário: ${ofereceuFormulario(mensagens) ? 'enviado' : 'não enviado'}`,
    '',
    `${doPaciente} mensagem(ns) do paciente · ${agora.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })}`,
  ];

  return linhas.join('\n');
}

/**
 * @param {object} dependencias.destinatarios  telefones da equipe
 * @param {object} dependencias.canal  quem entrega no WhatsApp
 */
function criarResumoDeAtendimento({
  repositorio, canal, destinatarios = [], silencioMin = SILENCIO_PADRAO_MIN, agora = () => new Date(),
}) {
  if (!repositorio) throw new Error('resumo de atendimento exige o repositório');

  return {
    ativo: Boolean(canal?.enviar && destinatarios.length > 0),

    async enviarPendentes() {
      if (!canal?.enviar || destinatarios.length === 0) {
        return { enviados: 0, motivo: 'sem canal ou sem destinatários' };
      }

      const conversas = await repositorio.listarConversasSemResumo?.({ silencioMin }) ?? [];

      let enviados = 0;
      for (const conversa of conversas) {
        try {
          const [contato, mensagens, agendamento] = await Promise.all([
            repositorio.obterContato(conversa.contato_id),
            repositorio.listarMensagens(conversa.id, { incluirPrivadas: false }),
            repositorio.obterAgendamentoDoContato?.(conversa.contato_id) ?? null,
          ]);

          const texto = montarResumo({ contato, mensagens, agendamento, agora: agora() });

          // Marca antes de enviar. Se o envio falhar no meio dos destinatários,
          // reenviar tudo no próximo ciclo mandaria o resumo duas vezes para
          // quem já recebeu — e a equipe passaria a ignorar os resumos.
          await repositorio.marcarResumoEnviado(conversa.id);

          for (const destino of destinatarios) {
            await canal.enviar({
              telefone: destino,
              texto,
              chave: `resumo:${conversa.id}:${destino}`,
            });
          }

          enviados += 1;
        } catch (erro) {
          console.error(`[resumo] conversa ${conversa.id} falhou: ${erro.message}`);
        }
      }

      if (enviados > 0) console.log(`[resumo] ${enviados} atendimento(s) resumido(s) para a equipe`);
      return { enviados };
    },
  };
}

module.exports = {
  criarResumoDeAtendimento, montarResumo, extrairIdade, extrairQueixa, ofereceuFormulario,
};
