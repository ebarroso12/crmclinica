'use strict';

// Resumo do atendimento, enviado à EQUIPE de cada lado quando a conversa esfria.
//
// Sem isto, saber como foi a noite exige abrir o painel e ler conversa por
// conversa — o que ninguém faz antes do primeiro café. A informação que importa
// (quem procurou, o que queria, se marcou) chega tarde ou não chega.
//
// ------------------------------------------------------ o que decide o momento
//
// Não existe evento de "conversa terminou": ninguém se despede no WhatsApp. O
// que existe é silêncio — e silêncio prolongado é o sinal mais honesto de que o
// atendimento acabou (`silencioMin`).
//
// ----------------------------------------------- quem recebe, e com que ritmo
//
// Pedido de 11/09/2026: "resumos estão sendo repetidos e estão demais, envie
// resumos a cada duas horas" e "quem tem de receber resumo é só a equipe — a da
// clínica recebe da clínica, a da Alpins recebe da Alpins" (docs/RESUMOS.md).
//
//   • grupos: a clínica (conversa sem agente) e cada agente;
//   • destinatários: src/dominio/destinatarios-resumo.js (cadastro de usuários);
//   • ritmo: UM resumo por grupo a cada `intervaloMin`, com todos os atendimentos
//     pendentes; o relógio é o último `resumo_enviado_em` do grupo NO BANCO —
//     reiniciar o worker nunca antecipa nada (incidente das 04:55, 126 resumos);
//   • trava: duas cópias do worker nunca resumem ao mesmo tempo
//     (`repositorio.executarComTravaDeResumo`);
//   • canal: a clínica sai pelo número da clínica; o agente, pela instância dele —
//     sem instância, não sai (invariante 2 de docs/AGENTES.md);
//   • marca só o atendimento que ALGUÉM recebeu; o resto fica para o próximo
//     ciclo e a falha vai para a auditoria.
//
// ---------------------------------------------------------------- o conteúdo
//
// Nome, idade, queixa, se agendou e se recebeu o formulário — o que o Dr. Edson
// pediu, nessa ordem, porque é a ordem em que ele lê.
//
// A queixa vem do que o paciente escreveu, sem interpretação: resumir sintoma é
// atividade clínica, e este módulo não faz isso. Ele recorta e cita.

const crypto = require('node:crypto');
const { destinatariosDoGrupo, instanciaDoAgente } = require('./destinatarios-resumo');

const SILENCIO_PADRAO_MIN = 30;
const INTERVALO_PADRAO_MIN = 120;
// Cabe folgado numa mensagem de WhatsApp e ainda se lê no celular.
const LIMITE_POR_MENSAGEM = 3500;
// Teto de atendimentos num resumo: depois de uma parada longa, o resto vai no
// seguinte — um resumo de 30 mensagens seguidas ninguém lê. Era 40: com a IA
// escrevendo no teto, quem está na clínica e numa equipe de agente recebia 40
// mensagens seguidas (conferência final, item 2). Configurável por
// CRMCLINICA_RESUMO_MAXIMO_CONVERSAS.
const MAXIMO_POR_RESUMO = 20;
// Tentativas por envio (pessoa × parte) que falhou com erro conhecido — uma por
// intervalo do grupo; na última, desiste (conferência final sobre 54f6225).
const TENTATIVAS_POR_ENVIO = 3;
const LIMITE_DA_VARREDURA = 500;
// Teto da janela (auditoria A1): nada anterior a 24 h entra num resumo.
const JANELA_MAXIMA_MS = 24 * 60 * 60 * 1000;
const SEPARADOR = '\n\n— — —\n\n';

function horaCurta(data) {
  return data.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

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
 * O cabeçalho que acompanha o resumo escrito pela IA — no formato RESUMO DE
 * LEAD que a equipe aprovou, com o NOME da pessoa no título.
 *
 * Tudo aqui vem DO BANCO, nunca do modelo: nome, telefone, qualificação,
 * estágio e agendamento são os dados que a equipe usa para agir, e dado de
 * ação não pode depender de um resumo que, por regra, só olha a conversa.
 */
function montarCabecalho({ contato, lead = null, agendamento = null }) {
  const nome = contato?.nome?.trim() || null;
  const quando = agendamento ? horaCurta(new Date(agendamento.inicio)) : null;

  const linhas = [
    `RESUMO DE LEAD — ${nome ?? contato?.telefone ?? 'contato sem identificação'}`,
    '',
    `Nome: ${nome ?? 'não informado'}`,
    `Telefone: ${contato?.telefone ?? '—'}`,
  ];

  // "frio (score 0)" é o DEFAULT do banco, não um veredito: todo lead nasce
  // assim antes de qualquer avaliação. Imprimi-lo com cara de fato faria a
  // equipe despriorizar um lead quente que simplesmente ainda não foi olhado.
  const avaliado = lead && (Number(lead.score) > 0 || (lead.temperatura && lead.temperatura !== 'frio'));
  if (avaliado) {
    linhas.push(`Qualificacao: ${lead.temperatura}${Number.isInteger(Number(lead.score)) ? ` (score ${Number(lead.score)})` : ''}`);
  } else if (lead) {
    linhas.push('Qualificacao: ainda não avaliada');
  }
  if (lead?.estagio) linhas.push(`Estagio: ${lead.estagio}`);

  // SEMPRE presente, nos dois sentidos. Sem o "NÃO" explícito, um paciente que
  // cancelou (o estágio fica preso em "agendado") viraria silêncio — e
  // silêncio ao lado de "Estagio: agendado" lê-se como consulta de pé.
  linhas.push(agendamento ? `Agendou: SIM — ${quando}` : 'Agendou: NÃO');

  return linhas.join('\n');
}

/**
 * Cabeçalho do atendimento de um AGENTE. Lead, qualificação e agenda são da
 * clínica (invariante 7 de docs/AGENTES.md) e não entram.
 */
function montarCabecalhoDoAgente({ contato }) {
  const nome = contato?.nome?.trim() || null;
  return [
    `ATENDIMENTO — ${nome ?? contato?.telefone ?? 'contato sem identificação'}`,
    '',
    `Nome: ${nome ?? 'não informado'}`,
    `Telefone: ${contato?.telefone ?? '—'}`,
  ].join('\n');
}

/**
 * O miolo determinístico — a reserva quando a IA não escreve.
 *
 * Recorta e cita, sem interpretar: idade e queixa nas palavras do paciente,
 * formulário por detecção. É menos rico que o corpo da IA, mas entra no MESMO
 * layout — quem recebe não percebe troca de formato, só de profundidade.
 */
function corpoDeReserva(mensagens) {
  const idade = extrairIdade(mensagens);
  const queixa = extrairQueixa(mensagens);

  return [
    idade !== null ? `Idade: ${idade}` : null,
    `Procura: ${queixa ?? 'não relatada'}`,
    `Formulário: ${ofereceuFormulario(mensagens) ? 'enviado' : 'não enviado'}`,
  ].filter(Boolean).join('\n');
}

/** Reserva do agente: só o que a pessoa procura, nas palavras dela. */
function corpoDeReservaDoAgente(mensagens) {
  return `Procura: ${extrairQueixa(mensagens) ?? 'não relatada'}`;
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
  const quando = agendamento ? horaCurta(new Date(agendamento.inicio)) : null;

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
    `${doPaciente} mensagem(ns) do paciente · ${horaCurta(agora)}`,
  ];

  return linhas.join('\n');
}

/**
 * Corta um texto longo sem partir caractere (auditoria B4): percorre por code
 * point (`Array.from`), então um emoji — par substituto em UTF-16 — nunca fica
 * pela metade. O teto continua medido em unidades UTF-16, que é o que o limite
 * da mensagem protege; a reticência final cabe dentro dele.
 */
function cortarSemPartirCaractere(texto, teto) {
  let cortado = '';
  for (const caractere of Array.from(texto)) {
    if (cortado.length + caractere.length > teto - 1) break;
    cortado += caractere;
  }
  return `${cortado}…`;
}

/**
 * Divide o resumo de um grupo em mensagens de até `limite` caracteres. Cada
 * atendimento cai inteiro numa parte só — é o que permite marcar como entregue
 * exatamente o que chegou. Título numerado "(1/3)" quando há mais de uma; o
 * rodapé vai só na última.
 */
function dividirEmMensagens({ titulo, blocos, rodape, limite = LIMITE_POR_MENSAGEM }) {
  const folga = titulo.length + rodape.length + 2 * SEPARADOR.length + 12;
  const teto = Math.max(500, limite - folga);

  const grupos = [];
  let atual = [];
  let tamanho = 0;
  for (const bloco of blocos) {
    const texto = bloco.texto.length > teto ? cortarSemPartirCaractere(bloco.texto, teto) : bloco.texto;
    const acrescimo = texto.length + (atual.length > 0 ? SEPARADOR.length : 0);
    if (atual.length > 0 && tamanho + acrescimo > teto) {
      grupos.push(atual);
      atual = [];
      tamanho = 0;
    }
    tamanho += texto.length + (atual.length > 0 ? SEPARADOR.length : 0);
    atual.push({ ...bloco, texto });
  }
  if (atual.length > 0) grupos.push(atual);

  return grupos.map((grupo, indice) => {
    const cabeca = grupos.length > 1 ? `${titulo} (${indice + 1}/${grupos.length})` : titulo;
    const partes = [cabeca, grupo.map((bloco) => bloco.texto).join(SEPARADOR)];
    if (indice === grupos.length - 1) partes.push(rodape);
    return { texto: partes.join(SEPARADOR), conversas: grupo.map((bloco) => bloco.conversaId) };
  });
}

/**
 * Motivo de falha sem número de pessoa (auditoria B7): qualquer trecho com
 * dígitos e separadores de telefone (espaço, ponto, hífen, parênteses, +) que
 * some 8 ou mais dígitos vira `***` — "99294-3215", "(16) 99294-3215",
 * "+55 16 99294-3215", "5516992943215". Trechos curtos (código HTTP,
 * contagem de tentativas) continuam.
 */
function motivoSemTelefone(mensagem) {
  return String(mensagem ?? 'falha sem mensagem')
    .replace(/\+?\(?\d[\d\s().-]*\d\)?/g, (trecho) => (trecho.replace(/\D/g, '').length >= 8 ? '***' : trecho))
    .slice(0, 300);
}

/**
 * @param {object} dependencias.canal  quem entrega no WhatsApp (`canal-conversas`)
 * @param {number} dependencias.silencioMin  silêncio para a conversa entrar
 * @param {number} dependencias.intervaloMin  um resumo por grupo a cada N minutos
 * @param {object} dependencias.gerador  `criarGeradorDeResumo` — opcional. Com
 *   ele, o resumo é escrito pela IA a partir da conversa inteira; sem ele (ou
 *   quando a IA falha), vale o recorte determinístico. A reserva existe porque
 *   resumo atrasado é aceitável e resumo nenhum não é.
 *
 * `destinatarios` não é mais lido: quem recebe vem do cadastro.
 */
function criarResumoDeAtendimento({
  repositorio, canal, silencioMin = SILENCIO_PADRAO_MIN, intervaloMin = INTERVALO_PADRAO_MIN,
  agora = () => new Date(), gerador = null,
  limitePorMensagem = LIMITE_POR_MENSAGEM, maximoPorResumo = MAXIMO_POR_RESUMO,
}) {
  if (!repositorio) throw new Error('resumo de atendimento exige o repositório');

  const intervaloMs = Math.max(1, Number(intervaloMin) || INTERVALO_PADRAO_MIN) * 60_000;
  const maximoDeConversas = Math.max(1, Math.floor(Number(maximoPorResumo)) || MAXIMO_POR_RESUMO);
  // O worker roda a cada minuto: um aviso que se repete a cada ciclo enterra o
  // log. Repete só quando a situação muda (nova cópia do processo, novo grupo).
  const avisados = new Set();
  function avisarUmaVez(chave, texto) {
    if (avisados.has(chave)) return;
    avisados.add(chave);
    console.warn(`[resumo] ${texto}`);
  }

  async function montarBloco(conversa, doAgente) {
    const [contato, mensagens, agendamento, lead] = await Promise.all([
      repositorio.obterContato(conversa.contato_id),
      repositorio.listarMensagens(conversa.id, { incluirPrivadas: false }),
      doAgente ? null : (repositorio.obterAgendamentoDoContato?.(conversa.contato_id) ?? null),
      doAgente ? null : (repositorio.obterLeadPorContato?.(conversa.contato_id) ?? null),
    ]);

    // Primeiro a IA (resumo de verdade, com contexto); na falha, o recorte
    // determinístico — DENTRO do mesmo layout. A última ENTRADA compõe a chave:
    // sem ela o cache do gateway devolvia para sempre o primeiro resumo.
    const daIa = await gerador?.gerar({
      mensagens,
      qualificacao: lead,
      chaveIdempotencia: `resumo:conversa:${conversa.id}:entrada:${conversa.ultima_entrada_id ?? 'sem-entrada'}`,
      ...(doAgente ? { contexto: 'agente' } : {}),
    });

    const cabecalho = doAgente ? montarCabecalhoDoAgente({ contato }) : montarCabecalho({ contato, lead, agendamento });
    const corpo = daIa ?? (doAgente ? corpoDeReservaDoAgente(mensagens) : corpoDeReserva(mensagens));
    return {
      conversaId: Number(conversa.id),
      ultimaEntradaId: conversa.ultima_entrada_id ?? null,
      texto: [cabecalho, corpo, `Mensagens trocadas: ${mensagens.length}`].join('\n\n'),
    };
  }

  // Última auditoria de falha por grupo (auditoria B5): no máximo uma por
  // intervalo. Vive no processo — reiniciar o worker pode antecipar UMA
  // auditoria, nunca um envio (o relógio dos envios é o banco).
  const ultimaAuditoriaDoGrupo = new Map();

  async function resumirGrupo({ agenteId, conversas, pessoas }) {
    const doAgente = agenteId !== null;
    const relatorio = {
      agente_id: agenteId, pendentes: conversas.length, situacao: null,
      destinatarios: 0, mensagens: 0, enviados: 0, nao_entregues: 0,
    };

    let nome = 'Clínica';
    let instancia = null;
    if (doAgente) {
      const agente = await repositorio.obterAgente?.(agenteId);
      nome = agente?.nome ?? `agente #${agenteId}`;
      instancia = instanciaDoAgente(agente);
      if (!instancia) {
        relatorio.situacao = 'agente_sem_canal';
        avisarUmaVez(`sem-canal:${agenteId}`, `${nome}: ${conversas.length} atendimento(s) sem resumo — o agente não tem WhatsApp ativo, e o resumo dele não sai pelo número da clínica.`);
        return relatorio;
      }
    }

    const destinatarios = destinatariosDoGrupo(pessoas, agenteId);
    relatorio.destinatarios = destinatarios.length;
    if (destinatarios.length === 0) {
      relatorio.situacao = 'sem_destinatarios';
      avisarUmaVez(`sem-destinatarios:${agenteId ?? 'clinica'}`, `${nome}: ${conversas.length} atendimento(s) esperando resumo e ninguém da equipe pode recebê-lo (WhatsApp autorizado e "Recebe resumos" ligados) — veja a tela Usuários.`);
      return relatorio;
    }

    const escolhidas = conversas.slice(0, maximoDeConversas);
    const blocos = [];
    for (const conversa of escolhidas) {
      try {
        blocos.push(await montarBloco(conversa, doAgente));
      } catch (erro) {
        // Fica fora deste resumo e segue pendente: entra no próximo.
        console.error(`[resumo] conversa ${conversa.id} ficou fora do resumo: ${erro.message}`);
      }
    }
    if (blocos.length === 0) {
      relatorio.situacao = 'falha_ao_montar';
      return relatorio;
    }

    const restantes = conversas.length - escolhidas.length;
    const titulo = doAgente ? `RESUMO — ${nome}` : 'RESUMO DA CLÍNICA';
    const rodape = [
      `${blocos.length} atendimento(s) neste resumo · ${horaCurta(agora())}`,
      restantes > 0 ? `Mais ${restantes} atendimento(s) no próximo resumo.` : null,
    ].filter(Boolean).join('\n');
    const partes = dividirEmMensagens({ titulo, blocos, rodape, limite: limitePorMensagem });
    relatorio.mensagens = partes.length;

    // Registro de envios (auditoria M2): a Evolution não recebe chave de
    // idempotência, e um restart no meio do resumo reenviava tudo. Cada envio
    // (pessoa × parte) é reservado em `resumo_envios` ANTES de sair:
    //   • chave nova → reserva e envia;
    //   • 'falhou' → só volta depois de um intervalo, e no máximo
    //     TENTATIVAS_POR_ENVIO vezes: HTTP de erro não prova que não chegou, e
    //     a mesma mensagem saía a cada minuto (conferência final, item 1). Na
    //     última falha vira 'desistido' — definitivo, com auditoria;
    //   • 'enviado' → já chegou: não reenvia e conta como entregue;
    //   • 'enviando' → INCERTO (o processo morreu no meio, ou a Evolution não
    //     confirmou): não reenvia — mesma política de falha indeterminada de
    //     evolution-envio.js — e conta como entregue, para a conversa não ficar
    //     presa na fila.
    // A chave é da pessoa e do CONTEÚDO da parte (conversas + última entrada):
    // a mesma parte num ciclo seguinte é reconhecida, mesmo que outras
    // conversas tenham entrado no fim do resumo.
    const tipoDeGrupo = doAgente ? 'agente' : 'clinica';
    const grupo = doAgente ? `agente:${agenteId}` : 'clinica';
    const entradaDe = new Map(blocos.map((bloco) => [bloco.conversaId, bloco.ultimaEntradaId]));
    const assinaturaDaParte = (parte) => crypto.createHash('sha256')
      .update(parte.conversas.map((id) => `${id}:${entradaDe.get(id) ?? ''}`).join(','))
      .digest('hex').slice(0, 24);
    // Devolve o status gravado ('enviado', 'falhou', 'desistido') ou null.
    async function concluir(chave, status) {
      try {
        return await repositorio.concluirEnvioDeResumo?.(chave, status, { maximoDeTentativas: TENTATIVAS_POR_ENVIO }) ?? null;
      } catch (erro) {
        // Fica 'enviando' (incerto): no próximo ciclo não sai de novo.
        console.error(`[resumo] envio ${status} não registrado: ${erro.message}`);
        return null;
      }
    }
    // Desistência (conferência final, item 1): a mesma pessoa e parte falharam
    // TENTATIVAS_POR_ENVIO vezes. Não é tentado de novo; log e auditoria com as
    // conversas, sem telefone.
    async function registrarDesistencia({ destino, parte, indice, motivo }) {
      console.error(`[resumo] ${nome}: ${TENTATIVAS_POR_ENVIO} tentativas falharam para o usuário ${destino.usuario_id}, `
        + `parte ${indice + 1}, conversas ${parte.conversas.join(', ')} — desistido, não será tentado de novo`);
      try {
        await repositorio.registrarAuditoria?.({
          entidade: doAgente ? 'agente' : 'sistema',
          entidadeId: doAgente ? agenteId : 1,
          acao: 'resumo_desistido',
          detalhe: {
            grupo: tipoDeGrupo,
            agente_id: agenteId,
            usuario_id: destino.usuario_id,
            conversas: [...parte.conversas],
            parte: indice + 1,
            tentativas: TENTATIVAS_POR_ENVIO,
            motivo,
          },
        });
      } catch {
        // Auditoria indisponível não pode derrubar a varredura de resumos.
      }
    }
    // Envio incerto (auditoria M-n1): não é repetido e conta como entregue, mas
    // deixa rastro — log e auditoria por grupo e destinatário, com as conversas
    // e a parte. Sem telefone e sem texto. `motivo`: 'timeout' (a Evolution não
    // confirmou) ou 'reserva_orfa' (o processo morreu depois de reservar).
    async function registrarIncerto({ destino, parte, indice, motivo }) {
      console.error(`[resumo] ${nome}: envio incerto (${motivo}) para o usuário ${destino.usuario_id}, parte ${indice + 1}, `
        + `conversas ${parte.conversas.join(', ')} — não será repetido`);
      try {
        await repositorio.registrarAuditoria?.({
          entidade: doAgente ? 'agente' : 'sistema',
          entidadeId: doAgente ? agenteId : 1,
          acao: 'resumo_envio_incerto',
          detalhe: {
            grupo: tipoDeGrupo,
            agente_id: agenteId,
            usuario_id: destino.usuario_id,
            conversas: [...parte.conversas],
            parte: indice + 1,
            motivo,
          },
        });
      } catch {
        // Auditoria indisponível não pode derrubar a varredura de resumos.
      }
    }
    relatorio.incertos = 0;
    relatorio.desistidos = 0;
    relatorio.conversas_desistidas = 0;

    // Entrega ANTES de marcar. Marcar primeiro fazia toda falha de canal virar
    // resumo perdido para sempre, sem retentativa e sem rastro.
    const recebidas = new Map(blocos.map((bloco) => [bloco.conversaId, 0]));
    const falhas = new Map(blocos.map((bloco) => [bloco.conversaId, []]));
    const desistidas = new Map(blocos.map((bloco) => [bloco.conversaId, 0]));
    for (const destino of destinatarios) {
      for (const [indice, parte] of partes.entries()) {
        const chave = `resumo:${grupo}:${destino.usuario_id}:${assinaturaDaParte(parte)}`;
        const contarComoEntregue = () => { for (const id of parte.conversas) recebidas.set(id, recebidas.get(id) + 1); };
        const contarComoDesistida = () => { for (const id of parte.conversas) desistidas.set(id, desistidas.get(id) + 1); };

        let reserva = 'reservado';
        if (repositorio.reservarEnvioDeResumo) {
          try {
            reserva = await repositorio.reservarEnvioDeResumo({
              chave, grupo: tipoDeGrupo, agenteId, usuarioId: destino.usuario_id, parte: indice + 1, esperaMs: intervaloMs,
            });
          } catch (erro) {
            // Sem registro não se envia: sair sem reserva é o que duplicava.
            for (const id of parte.conversas) falhas.get(id).push(motivoSemTelefone(`registro de envio indisponível: ${erro?.message}`));
            continue;
          }
        }
        if (reserva === 'falhou') {
          // Falhou há menos de um intervalo: não sai agora (conferência final, item 1).
          for (const id of parte.conversas) falhas.get(id).push('falhou há pouco; nova tentativa só depois do intervalo');
          continue;
        }
        if (reserva === 'desistido') {
          contarComoDesistida();
          continue;
        }
        if (reserva !== 'reservado') {
          if (reserva === 'enviando') {
            relatorio.incertos += 1;
            await registrarIncerto({ destino, parte, indice, motivo: 'reserva_orfa' });
          }
          contarComoEntregue();
          continue;
        }

        try {
          await canal.enviar({
            telefone: destino.telefone,
            texto: parte.texto,
            chave,
            ...(instancia ? { instancia } : {}),
          });
          await concluir(chave, 'enviado');
          contarComoEntregue();
        } catch (erro) {
          if (erro?.indeterminado === true) {
            // Não sabemos se chegou: fica 'enviando' e não é repetido.
            relatorio.incertos += 1;
            contarComoEntregue();
            console.error(`[resumo] envio sem confirmação (indeterminado): ${motivoSemTelefone(erro.message)}`);
            await registrarIncerto({ destino, parte, indice, motivo: 'timeout' });
          } else if (await concluir(chave, 'falhou') === 'desistido') {
            relatorio.desistidos += 1;
            contarComoDesistida();
            await registrarDesistencia({ destino, parte, indice, motivo: motivoSemTelefone(erro?.message) });
          } else {
            for (const id of parte.conversas) falhas.get(id).push(motivoSemTelefone(erro?.message));
          }
        }
      }
    }

    const semEntrega = [];
    const parciais = [];
    const motivosDoGrupo = [];
    for (const bloco of blocos) {
      const confirmados = recebidas.get(bloco.conversaId);
      const motivos = falhas.get(bloco.conversaId);
      if (motivos.length > 0) {
        (confirmados > 0 ? parciais : semEntrega).push(bloco.conversaId);
        motivosDoGrupo.push(...motivos);
      }

      // Marca quando ALGUÉM recebeu: repetir para todos por causa de um que
      // falhou mandaria o mesmo resumo duas vezes a quem já leu. Ninguém
      // recebeu: fica sem marca e volta no próximo resumo do grupo.
      // Também marca quando o que falta são só envios DESISTIDOS (conferência
      // final, item 1): sem a marca, a parte mudaria de composição, a chave
      // mudaria e as tentativas recomeçariam — a auditoria resumo_desistido
      // guarda quais conversas ficaram sem entrega.
      const desistida = confirmados === 0 && motivos.length === 0 && desistidas.get(bloco.conversaId) > 0;
      if (confirmados > 0 || desistida) {
        try {
          await repositorio.marcarResumoEnviado(bloco.conversaId, { ultimaEntradaId: bloco.ultimaEntradaId });
        } catch (erro) {
          console.error(`[resumo] conversa ${bloco.conversaId} ${desistida ? 'desistida' : 'entregue'} mas não marcada: ${erro.message}`);
        }
        if (desistida) relatorio.conversas_desistidas += 1;
        else relatorio.enviados += 1;
      } else {
        relatorio.nao_entregues += 1;
      }

    }

    if (motivosDoGrupo.length > 0) {
      const motivos = [...new Set(motivosDoGrupo)];
      console.error(`[resumo] ${nome}: ${semEntrega.length} atendimento(s) sem entrega e ${parciais.length} com entrega parcial — ${motivos.join('; ')}`);
      // Auditoria porque o log do worker vive no VPS e ninguém o lê — mas UMA
      // por grupo por intervalo (auditoria B5): com o canal fora do ar, cada
      // ciclo de 1 min gravava uma por atendimento. Nenhum telefone no detalhe.
      const instante = agora().getTime();
      const ultima = ultimaAuditoriaDoGrupo.get(grupo);
      if (ultima === undefined || instante - ultima >= intervaloMs) {
        ultimaAuditoriaDoGrupo.set(grupo, instante);
        try {
          await repositorio.registrarAuditoria?.({
            entidade: doAgente ? 'agente' : 'sistema',
            entidadeId: doAgente ? agenteId : 1,
            acao: semEntrega.length > 0 ? 'resumo_nao_entregue' : 'resumo_parcialmente_entregue',
            detalhe: {
              grupo: tipoDeGrupo,
              agente_id: agenteId,
              destinatarios: destinatarios.length,
              conversas_sem_entrega: semEntrega,
              conversas_parciais: parciais,
              envios_falhados: motivosDoGrupo.length,
              motivos,
            },
          });
        } catch {
          // Auditoria indisponível não pode derrubar a varredura de resumos.
        }
      }
    }

    relatorio.situacao = relatorio.enviados > 0 ? 'enviado'
      : (relatorio.nao_entregues === 0 && relatorio.conversas_desistidas > 0 ? 'desistido' : 'nao_entregue');
    return relatorio;
  }

  // Janela (auditoria A1; reconferência B-n1 e B-n2): uma conversa entra no
  // resumo do seu grupo quando está em silêncio e tem ENTRADA do contato ainda
  // não resumida — depois da marca da própria conversa — nas últimas 24 h.
  //   • quem impede repetir é a marca por conversa (`resumo_enviado_em`);
  //   • quem impede o histórico nunca resumido (conversa de agente antiga, a fila
  //     acumulada de um worker parado) de virar enxurrada é o teto de 24 h.
  // O início já foi (relógio do grupo) − intervalo − silêncio, e isso perdia
  // atendimento: a sobra acima do teto por resumo saía da janela no terceiro
  // ciclo (B-n1), e a conversa com saídas por mais de intervalo + silêncio
  // depois da última entrada esfriava fora da janela e nunca era resumida (B-n2).
  async function varrer() {
    // O relógio vem do banco: o último envio confirmado de cada grupo. É ele
    // que decide se o grupo já pode receber outro resumo.
    const ultimos = new Map((await repositorio.listarUltimosEnviosDeResumo?.() ?? [])
      .map((linha) => [linha.agente_id === null ? null : Number(linha.agente_id), new Date(linha.ultimo_envio).getTime()]));
    // A última FALHA também anda o relógio (conferência final, item 1): com o
    // canal fora do ar nada é marcado, e o relógio só de envios deixava o grupo
    // tentar a cada minuto — 362 tentativas em 3 h. Fica no banco: reiniciar o
    // worker não antecipa.
    for (const linha of await repositorio.listarUltimasFalhasDeResumo?.() ?? []) {
      const agenteId = linha.agente_id === null ? null : Number(linha.agente_id);
      const falha = new Date(linha.ultima_falha).getTime();
      if (!(ultimos.get(agenteId) >= falha)) ultimos.set(agenteId, falha);
    }
    const instante = agora().getTime();
    const janelas = { padrao: new Date(instante - JANELA_MAXIMA_MS).toISOString(), porGrupo: [] };

    const pendentes = await repositorio.listarConversasSemResumo?.({ silencioMin, limite: LIMITE_DA_VARREDURA, janelas }) ?? [];
    if (pendentes.length === 0) return { enviados: 0, nao_entregues: 0, grupos: [] };

    const porGrupo = new Map();
    for (const conversa of pendentes) {
      const agenteId = conversa.agente_id === null || conversa.agente_id === undefined ? null : Number(conversa.agente_id);
      if (!porGrupo.has(agenteId)) porGrupo.set(agenteId, []);
      porGrupo.get(agenteId).push(conversa);
    }

    let pessoas = null;
    const grupos = [];
    for (const [agenteId, conversas] of porGrupo) {
      const ultimo = ultimos.get(agenteId);
      if (ultimo !== undefined && instante - ultimo < intervaloMs) {
        grupos.push({
          agente_id: agenteId, pendentes: conversas.length, situacao: 'aguardando_intervalo',
          proximo_em: new Date(ultimo + intervaloMs).toISOString(), enviados: 0, nao_entregues: 0,
        });
        continue;
      }
      pessoas ??= await repositorio.listarDestinatariosDeResumo?.() ?? [];
      grupos.push(await resumirGrupo({ agenteId, conversas, pessoas }));
    }

    const enviados = grupos.reduce((soma, grupo) => soma + grupo.enviados, 0);
    const naoEntregues = grupos.reduce((soma, grupo) => soma + grupo.nao_entregues, 0);
    const incertos = grupos.reduce((soma, grupo) => soma + (grupo.incertos ?? 0), 0);
    if (enviados > 0) console.log(`[resumo] ${enviados} atendimento(s) resumido(s) para a equipe`);
    if (naoEntregues > 0) {
      console.error(`[resumo] ${naoEntregues} atendimento(s) sem entrega nenhuma — serão tentados no próximo ciclo`);
    }
    return { enviados, nao_entregues: naoEntregues, incertos, grupos };
  }

  return {
    ativo: Boolean(canal?.enviar),

    async enviarPendentes() {
      if (!canal?.enviar) return { enviados: 0, nao_entregues: 0, motivo: 'sem canal de entrega' };
      if (!repositorio.executarComTravaDeResumo) return varrer();

      const trava = await repositorio.executarComTravaDeResumo(varrer);
      if (!trava.obtida) {
        return { enviados: 0, nao_entregues: 0, motivo: 'outra cópia do worker está resumindo agora' };
      }
      return trava.resultado;
    },
  };
}

/**
 * O resumo pode rodar com este pool? (auditoria B6) A trava
 * (`executarComTravaDeResumo`) segura UMA conexão durante a varredura inteira e
 * as consultas do resumo usam outra: com pool de uma conexão só, elas esperam a
 * conexão que a trava segura e o ciclo trava até o timeout. Mínimo: 2.
 * Devolve o motivo em texto, ou `null` quando pode.
 */
function problemaDoPoolParaResumo(poolMax) {
  const tamanho = Number(poolMax);
  if (Number.isInteger(tamanho) && tamanho >= 2) return null;
  return `CRMCLINICA_DB_POOL_MAX=${poolMax ?? '(vazio)'} é pouco para o resumo: a trava segura uma conexão `
    + 'durante a varredura e as consultas precisam de outra. Use 2 ou mais — o resumo fica DESLIGADO até lá.';
}

module.exports = {
  problemaDoPoolParaResumo,
  criarResumoDeAtendimento, montarResumo, montarCabecalho, montarCabecalhoDoAgente, corpoDeReserva,
  dividirEmMensagens, extrairIdade, extrairQueixa, ofereceuFormulario, motivoSemTelefone,
  LIMITE_POR_MENSAGEM, INTERVALO_PADRAO_MIN,
};
