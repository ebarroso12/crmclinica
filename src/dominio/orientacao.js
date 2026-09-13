'use strict';

// Quando a assistente não sabe e pergunta para a clínica.
//
// O caso que deu origem a isto: alguém escreve "vi o post de vocês" e pergunta
// sobre uma promoção. A assistente não tem como saber o que estava escrito na
// publicação — e as duas saídas que ela tinha eram ruins: inventar (o pior de
// todos os erros num CRM de clínica) ou escalar e sumir da conversa, deixando o
// lead falando sozinho.
//
// O caminho novo tem três passos:
//
//   1. ela diz ao lead que é uma assistente de IA, que não tem como confirmar o
//      conteúdo da publicação, e que vai verificar com um profissional;
//   2. registra a dúvida aqui e o celular de quem pode responder toca;
//   3. a pessoa escreve a orientação no CRM — em português de bastidor, do
//      jeito que falaria com um colega — e a assistente COMPILA isso numa
//      resposta ao lead, no tom dela.
//
// O passo 3 é o delicado: a orientação é texto interno, escrito depressa, que
// pode conter recado para a equipe ("pode dar 10% se insistir"), valor que não
// se anuncia, ou opinião. Repassar literalmente seria vazar bastidor para o
// paciente. Por isso ela é COMPILADA, com uma instrução estreita e uma barreira
// de conferência antes de sair.

const LIMITE_DA_DUVIDA = 500;
const LIMITE_DA_ORIENTACAO = 2000;

/**
 * Vinte minutos. O número é do Dr. Edson, e a razão é de atendimento: passado
 * esse tempo, quem escreveu já desistiu de esperar — e silêncio, num primeiro
 * contato, é o que faz a pessoa procurar outra clínica.
 */
const ESPERA_ATE_AVISAR_MS = 20 * 60 * 1000;

/**
 * O que ela diz quando ninguém orientou a tempo.
 *
 * Três coisas, nesta ordem, e nenhuma a mais: admite que não sabe daquele
 * ponto, diz que a equipe vai entrar em contato, e DÁ ANDAMENTO — porque o
 * resto do atendimento (entender a necessidade, agendar) não depende da
 * dúvida que travou. Nada sobre a publicação é inventado para preencher o
 * vazio.
 */
const AVISO_DE_ESPERA = 'Sobre esse ponto eu não consegui confirmar a informação, '
  + 'e não quero te passar nada errado — a equipe da clínica vai entrar em contato com você o quanto antes. '
  + 'Enquanto isso, posso seguir te ajudando por aqui: me conta o que você precisa?';

/**
 * O que a assistente NÃO pode dizer ao repassar uma orientação.
 *
 * A orientação vem de um humano com pressa, e o que ele escreve é para OUTRO
 * humano da clínica. Estas marcas denunciam texto que é bastidor puro — se
 * aparecerem na resposta compilada, ela não sai: a conversa volta para a equipe
 * responder à mão. Falhar fechado aqui é barato; o contrário não é.
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
 * O marcador que a assistente usa para dizer "não sei disto, perguntem".
 *
 * Ele vai NO FIM do texto que ela gerou e o sistema o remove antes de enviar —
 * o paciente nunca deve vê-lo. É a única forma de a Serena responder E pedir
 * ajuda no mesmo passo: o orquestrador dela devolve texto puro, sem campo para
 * sinalizar intenção (o motor dos agentes tem `transferir_para_humano`; este
 * caminho não tinha nada equivalente).
 *
 * Se o marcador vazar por falha de remoção, o paciente lê algo estranho mas
 * inofensivo; se um paciente tentar forjá-lo na mensagem dele, o efeito é a
 * conversa ir para a equipe — que é seguro por construção.
 */
// `[\s\S]*?` até o `]]`, e não `[^\]]*`: a dúvida costuma citar a pergunta do
// paciente, e citação com colchete acontece ("qual o valor do [promo] do
// post?"). Com a versão antiga o marcador simplesmente não casava — o paciente
// recebia `[[ORIENTAR: …]]` no meio da mensagem E ninguém era avisado.
//
// `g` porque a assistente pode emitir dois marcadores na mesma resposta.
// `replace` sem a flag troca só o primeiro, e o segundo ia inteiro para o
// paciente.
const MARCADOR = /\[\[\s*ORIENTAR\s*:?\s*([\s\S]*?)\]\]/gi;

/**
 * Separa o que vai para o paciente do pedido de orientação.
 *
 * Devolve sempre `{ texto, duvida }`: sem marcador, `duvida` é nula e o texto
 * sai inteiro.
 */
function separarPedidoDeOrientacao(resposta) {
  const bruto = String(resposta ?? '');
  // `matchAll` em vez de `match`: com a flag `g`, `match` devolveria os textos
  // casados inteiros e perderia o grupo — a dúvida. E `matchAll` não mexe no
  // `lastIndex` do regex compartilhado, então duas chamadas seguidas veem o
  // mesmo resultado (`test`/`exec` com `g` não veriam).
  const achados = [...bruto.matchAll(MARCADOR)];
  if (achados.length === 0) return { texto: bruto.trim(), duvida: null };

  // Espaço no lugar do marcador, não vazio: "o valor[[ORIENTAR: x]]é" viraria
  // "o valoré". O aperto de espaços logo em seguida desfaz o excesso.
  const limpo = bruto.replace(MARCADOR, ' ').replace(/\s{2,}/g, ' ').trim();
  const duvida = achados.map((achado) => (achado[1] ?? '').trim()).filter(Boolean).join(' | ');
  return { texto: limpo, duvida: duvida || 'A assistente não soube responder e pediu orientação.' };
}

function texto(valor, limite) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  return bruto.slice(0, limite);
}

/**
 * Impressão curta e estável do texto, para compor a chave de idempotência da
 * compilação. Não é segredo nem identidade — é só "este texto ou outro".
 */
function impressao(valor) {
  return require('node:crypto').createHash('sha256')
    .update(String(valor ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Liga a compilação ao gateway multi-IA do projeto (`src/ia/gateway.js`).
 *
 * Existe aqui, e não em cada ponto de montagem, porque são três: o servidor
 * HTTP e dois workers. Quando isto morava só na cabeça de quem montava, o
 * recurso subiu para produção sem `orientacoes` em nenhum dos três — a
 * assistente prometia "vou confirmar com um profissional" e nada era
 * registrado (achado em revisão independente, 13/09/2026).
 *
 * Sem gateway devolve `null`, e `compilar` já trata isso: a orientação fica
 * registrada e quem responde ao paciente é uma pessoa.
 */
function compiladorPeloGateway(gateway) {
  if (!gateway?.gerar) return null;
  return {
    async gerar({ instrucao, chave }) {
      const resultado = await gateway.gerar({
        finalidade: 'orientacao_compilada',
        prompt: instrucao,
        chaveIdempotencia: chave,
        promptVersion: 'orientacao-v1',
      });
      return resultado?.resposta ?? '';
    },
  };
}

/**
 * A resposta compilada pode sair?
 *
 * Fail-closed: na dúvida, não sai. Quem paga o preço de uma resposta barrada é
 * a equipe (responde à mão); quem pagaria o preço de uma resposta indevida é o
 * paciente.
 */
function respostaPodeSair(resposta, { orientacao } = {}) {
  const limpo = String(resposta ?? '').trim();
  if (!limpo) return { pode: false, motivo: 'a IA não devolveu texto' };
  if (limpo.length > 600) return { pode: false, motivo: 'resposta longa demais para uma mensagem' };

  for (const marca of MARCAS_DE_BASTIDOR) {
    if (marca.test(limpo)) return { pode: false, motivo: `a resposta repete bastidor (${marca})` };
  }

  // Copiar a orientação inteira é o modo mais comum de vazar bastidor: se o
  // texto sair quase idêntico ao que a equipe escreveu internamente, não
  // houve compilação nenhuma.
  const original = String(orientacao ?? '').trim();
  if (original && limpo.length > 40 && original.includes(limpo.slice(0, 40))) {
    return { pode: false, motivo: 'a resposta é a orientação copiada, não compilada' };
  }

  return { pode: true };
}

function criarOrientacoes({ repositorio, ia = null, agora = () => new Date() } = {}) {
  /**
   * A assistente registra que precisa de ajuda.
   *
   * Não lança: isto roda no meio do atendimento, e um erro aqui não pode
   * impedir a resposta que a assistente já deu ao lead.
   */
  async function pedir({ conversaId, duvida, agenteId = null }) {
    try {
      const registrada = await repositorio.criarOrientacao({
        conversaId,
        agenteId,
        duvida: texto(duvida, LIMITE_DA_DUVIDA) || 'Dúvida sem descrição.',
      });
      return { pedida: Boolean(registrada), id: registrada?.id ?? null };
    } catch (erro) {
      // O índice único barra a segunda pendência na mesma conversa: isso é o
      // comportamento desejado, não uma falha.
      if (String(erro.code) === '23505') return { pedida: false, motivo: 'ja_existe_pendente' };

      // Qualquer outra falha é grave e invisível: a assistente JÁ prometeu ao
      // lead que ia confirmar com um profissional, e sem este registro ninguém
      // é chamado e não fica rastro nenhum. Engolir sem auditar deixava esse
      // caso indistinguível de "correu tudo bem".
      await repositorio.registrarAuditoria?.({
        entidade: 'conversa',
        entidadeId: conversaId,
        acao: 'orientacao_nao_registrada',
        // O texto da dúvida não entra: pode carregar relato do paciente.
        detalhe: { codigo: erro.code ?? null, erro: String(erro.message ?? '').slice(0, 200) },
      }).catch(() => {});
      return { pedida: false, motivo: erro.message };
    }
  }

  /**
   * A clínica orientou. A assistente compila e responde ao lead.
   *
   * `enviar` é injetado (quem sabe entregar é o atendimento): recebe o texto
   * final e faz gravar + entregar pelo canal da conversa.
   */
  async function responder({ orientacaoId, orientacao, usuarioId, enviar }) {
    const pendente = await repositorio.obterOrientacao(orientacaoId);
    if (!pendente || pendente.estado !== 'pendente') {
      const erro = new Error('esta orientação já foi respondida');
      erro.status = 409;
      throw erro;
    }

    const textoDaOrientacao = texto(orientacao, LIMITE_DA_ORIENTACAO);
    if (!textoDaOrientacao) {
      const erro = new Error('escreva a orientação');
      erro.status = 400;
      throw erro;
    }

    const compilada = await compilar({
      orientacaoId, duvida: pendente.duvida, orientacao: textoDaOrientacao,
    });
    const permitido = respostaPodeSair(compilada, { orientacao: textoDaOrientacao });

    // A compilação leva segundos, e nesse intervalo o outro atendente que
    // abriu a mesma conversa pode ter respondido. Quem marcou é quem envia:
    // sem isto os dois passavam pela leitura lá em cima, os dois compilavam e
    // o paciente recebia duas mensagens sobre a mesma dúvida.
    const marcou = await repositorio.responderOrientacao(orientacaoId, {
      orientacao: textoDaOrientacao,
      usuarioId,
      respondidaEm: agora().toISOString(),
    });
    if (marcou === false) {
      const erro = new Error('esta orientação já foi respondida');
      erro.status = 409;
      throw erro;
    }

    if (!permitido.pode) {
      // A orientação fica registrada e a conversa continua com a equipe: quem
      // responde ao lead é uma pessoa, desta vez.
      return { respondida: true, enviada: false, motivo: permitido.motivo };
    }

    await enviar(compilada);
    return { respondida: true, enviada: true, texto: compilada };
  }

  /**
   * A compilação em si.
   *
   * A instrução é estreita de propósito: transformar bastidor em resposta ao
   * paciente, sem acrescentar nada. Sem IA configurada, não há compilação — e
   * responder à mão é melhor que repassar bastidor.
   */
  async function compilar({ orientacaoId, duvida, orientacao }) {
    if (!ia?.gerar) return null;

    const instrucao = [
      'Você é a assistente de atendimento da clínica.',
      'Um profissional da clínica respondeu internamente a uma dúvida sua. Escreva a mensagem que o paciente vai receber.',
      '',
      'Regras, todas obrigatórias:',
      '- Use SOMENTE o que está na orientação. Não acrescente informação, número, prazo, preço ou condição que não esteja lá.',
      '- Não copie a orientação: ela é texto interno. Escreva como você falaria com o paciente.',
      '- Não repita recado destinado à equipe, opinião interna, nem nada sobre como a clínica decide as coisas.',
      '- Nunca cite diagnóstico, exame, prontuário ou CID.',
      '- Uma a três frases, em português do Brasil, tom acolhedor e direto, próprio para WhatsApp.',
      '- Se a orientação não responder à dúvida, escreva apenas que a equipe vai retornar com a informação.',
      '',
      `Dúvida que você registrou: ${duvida}`,
      `Orientação do profissional: ${orientacao}`,
    ].join('\n');

    try {
      // A chave amarra a compilação à orientação E ao texto exato escrito: um
      // retry (rede caiu, atendente clicou duas vezes) reaproveita a resposta
      // já paga; corrigir a orientação e reenviar gera compilação nova.
      const chave = `orientacao-${orientacaoId}-${impressao(orientacao)}`;
      const saida = await ia.gerar({ instrucao, chave });
      return typeof saida === 'string' ? saida.trim() : (saida?.texto ?? '').trim();
    } catch {
      return null;
    }
  }

  /**
   * Quem espera há mais de vinte minutos recebe o aviso — uma vez só — e a
   * conversa VOLTA a andar.
   *
   * O segundo efeito é tão importante quanto o primeiro: ao pedir orientação, a
   * conversa foi para a equipe e a assistente calou. Se ninguém responder, ela
   * precisa retomar o atendimento em vez de deixar o lead esperando por uma
   * informação que talvez nunca venha — o agendamento não depende da dúvida que
   * travou.
   *
   * `liberarConversa` é injetado (quem sabe devolver à automação é o
   * atendimento) e é opcional: sem ele, o aviso sai e a conversa continua com a
   * equipe, que era o comportamento antes desta decisão.
   */
  async function avisarQuemEspera({ enviarNaConversa, liberarConversa = null, assistentePodeFalar = null }) {
    const limite = new Date(agora().getTime() - ESPERA_ATE_AVISAR_MS).toISOString();
    const esperando = await repositorio.listarOrientacoesSemAviso(limite);

    let avisados = 0;
    for (const pendente of esperando) {
      // A assistente pode falar nesta conversa agora?
      //
      // Este aviso sai assinado por ela, e o worker roda de minuto em minuto,
      // 24h por dia. Sem perguntar, uma dúvida registrada às 23h50 fazia a
      // Serena "falar" às 00h10, fora do horário — e PARAR SERENA, o
      // interruptor e o canal desligado não valiam aqui, porque a entrega
      // deste aviso não passa pela barreira final. E não pode passar: a
      // conversa está deliberadamente assumida (foi `entregarParaAClinica` que
      // a assumiu), e a barreira recusaria justamente o aviso que essa pausa
      // estava esperando.
      //
      // Fail-closed: não saber se ela pode falar é não falar. A pendência fica
      // e o próximo ciclo tenta de novo — dentro do horário, agora.
      if (assistentePodeFalar) {
        let liberada = false;
        try {
          liberada = await assistentePodeFalar(pendente.conversa_id);
        } catch {
          liberada = false;
        }
        if (!liberada) continue;
      }

      try {
        // A chave é derivada da orientação, então uma retentativa grava a MESMA
        // linha, não uma nova. Sem ela, entrega falhando (canal fora do ar,
        // instalação sem canal, timeout) fazia o `catch` abaixo engolir o erro
        // e o ciclo seguinte gravar outra mensagem — 1440 linhas por dia numa
        // conversa parada, todas marcadas "não entregue", na thread que a
        // equipe lê.
        await enviarNaConversa(pendente.conversa_id, AVISO_DE_ESPERA, {
          chave: `orientacao-aviso-${pendente.id}`,
        });
        await repositorio.marcarOrientacaoAvisada(pendente.id, agora().toISOString());
        avisados += 1;

        // Marcado ANTES de liberar: se a liberação falhar, o aviso não sai de
        // novo no próximo ciclo. Repetir a mensagem para o lead é pior que a
        // conversa continuar mais um tempo com a equipe.
        if (liberarConversa) await liberarConversa(pendente.conversa_id);
      } catch {
        // Canal fora do ar agora: tenta no próximo ciclo. A chave determinística
        // garante que a retentativa não duplique a mensagem.
      }
    }
    return { avisados };
  }

  return { pedir, responder, avisarQuemEspera, respostaPodeSair, AVISO_DE_ESPERA, ESPERA_ATE_AVISAR_MS };
}

module.exports = {
  criarOrientacoes,
  compiladorPeloGateway,
  separarPedidoDeOrientacao,
  MARCADOR,
  respostaPodeSair,
  MARCAS_DE_BASTIDOR,
  AVISO_DE_ESPERA,
  ESPERA_ATE_AVISAR_MS,
};
