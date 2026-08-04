'use strict';

// Regras da Serena — o agente de atendimento.
//
// Arquivo puro: recebe dados, devolve decisão e texto. Não fala com banco nem
// com rede. É aqui que ficam as respostas para:
//
//   • a Serena pode responder esta conversa agora?
//   • qual é o prompt que está no ar, montado a partir da versão publicada mais
//     as regras ligadas?
//   • uma regra ou versão de prompt é válida?
//
// A primeira pergunta tem duas camadas, e a ordem entre elas importa. O
// desligamento **global** vem antes de tudo: quando a equipe cala a automação,
// nenhuma conversa é exceção. Só depois vale a decisão por conversa — humano
// assumiu, alguém é responsável, conversa resolvida, pausa temporária.

const CATEGORIAS = Object.freeze(['barreira', 'encaminhamento', 'fluxo', 'estilo', 'geral']);

// Ordem de leitura no prompt montado. Barreira clínica primeiro: o que a Serena
// **não** pode fazer vem antes de como ela fala, porque um modelo que lê a
// instrução de estilo primeiro tende a tratá-la como a mais importante.
const ORDEM_DAS_CATEGORIAS = Object.freeze({
  barreira: 10,
  encaminhamento: 20,
  fluxo: 30,
  estilo: 40,
  geral: 50,
});

const TITULO_POR_CATEGORIA = Object.freeze({
  barreira: 'Barreiras clínicas',
  encaminhamento: 'Quando encaminhar para a equipe',
  fluxo: 'Fluxo de atendimento',
  estilo: 'Estilo',
  geral: 'Outras regras',
});

const LIMITE_CONTEUDO_PROMPT = 50000;
const LIMITE_CONTEUDO_REGRA = 5000;

class ErroDaSerena extends Error {
  constructor(mensagem, codigo = 'serena_invalida', status = 400) {
    super(mensagem);
    this.name = 'ErroDaSerena';
    this.codigo = codigo;
    this.status = status;
  }
}

const FUSO_PADRAO = 'America/Sao_Paulo';

/** `null`, vazio ou data passada são todos "não vigora". */
function noFuturo(instante, agora) {
  if (!instante) return false;
  const data = instante instanceof Date ? instante : new Date(instante);
  return !Number.isNaN(data.getTime()) && data > agora;
}

/** "08:30" → 510. Devolve `null` para qualquer coisa que não seja hora do dia. */
function emMinutos(texto) {
  const casou = /^(\d{1,2}):(\d{2})$/.exec(String(texto ?? '').trim());
  if (!casou) return null;

  const horas = Number(casou[1]);
  const minutos = Number(casou[2]);
  if (horas > 23 || minutos > 59) return null;
  return horas * 60 + minutos;
}

/**
 * Que horas são, e que dia da semana é, **no fuso da clínica**.
 *
 * O servidor roda em UTC e a clínica atende em São Paulo. Ler a hora do processo
 * daria três horas de diferença — a Serena calaria às 15h e voltaria a falar de
 * madrugada, sem nada no código parecendo errado. `Intl` é o que sabe disso,
 * inclusive no horário de verão, se ele voltar.
 */
function momentoLocal(agora, fuso = FUSO_PADRAO) {
  let partes;
  try {
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(agora);
  } catch {
    // Fuso inválido no banco não pode calar a clínica: cai no padrão em vez de
    // estourar dentro da decisão de responder.
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: FUSO_PADRAO, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(agora);
  }

  const valor = (tipo) => partes.find((parte) => parte.type === tipo)?.value ?? '';
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // `hour` sai "24" à meia-noite em algumas versões do ICU; 24:00 é 00:00.
  const hora = Number(valor('hour')) % 24;

  return { dia: dias[valor('weekday')] ?? 0, minutos: hora * 60 + Number(valor('minute')) };
}

/**
 * Está dentro de alguma janela da grade?
 *
 * Sem grade, ou com a grade desligada, a resposta é **sim**: o horário é um
 * limite que alguém escolhe pôr, e a ausência dele não pode virar silêncio.
 *
 * Janela que cruza a meia-noite (`22:00`–`02:00`) é aceita e testada nas duas
 * metades — plantão noturno é o caso que a leitura ingênua (`inicio <= agora <=
 * fim`) erraria calando justamente quem configurou para atender de madrugada.
 *
 * @param {object} agenda `{ ativa, fuso, dias: { "0".."6": [["08:00","18:00"]] } }`
 */
function dentroDoHorario(agenda, agora = new Date()) {
  if (!agenda || agenda.ativa !== true) return true;

  const { dia, minutos } = momentoLocal(agora, agenda.fuso || FUSO_PADRAO);
  const ontem = (dia + 6) % 7;

  const janelasDe = (indice) => {
    const bruto = agenda.dias?.[String(indice)] ?? agenda.dias?.[indice] ?? [];
    return Array.isArray(bruto) ? bruto : [];
  };

  for (const [inicioBruto, fimBruto] of janelasDe(dia)) {
    const inicio = emMinutos(inicioBruto);
    const fim = emMinutos(fimBruto);
    if (inicio === null || fim === null) continue;
    // Fim igual ao início seria janela de duração zero; tratamos como o dia todo
    // só quando for explicitamente 00:00–00:00, que é como se escreve "sempre".
    if (inicio === fim) { if (inicio === 0) return true; continue; }
    if (inicio < fim) { if (minutos >= inicio && minutos < fim) return true; continue; }
    // Cruza a meia-noite: vale do início até 24h.
    if (minutos >= inicio) return true;
  }

  // A outra metade de uma janela que começou ontem e atravessou a meia-noite.
  for (const [inicioBruto, fimBruto] of janelasDe(ontem)) {
    const inicio = emMinutos(inicioBruto);
    const fim = emMinutos(fimBruto);
    if (inicio === null || fim === null || inicio <= fim) continue;
    if (minutos < fim) return true;
  }

  return false;
}

/**
 * A Serena pode responder?
 *
 * Três camadas, e a ordem entre elas é a regra mais importante deste arquivo.
 *
 * **Global, nesta ordem:**
 *
 *   1. `ativa === false` cala tudo. É o botão de desligar, e ele não tem
 *      exceção: uma conversa que "merecia" resposta enquanto a automação está
 *      desligada é exatamente o caso que o desligamento existe para impedir.
 *   2. `pausada_ate` no futuro — a intervenção. Alguém está no meio de resolver
 *      algo à mão e não quer a Serena falando por cima.
 *   3. `ligada_ate` no futuro — o plantão esporádico. Vence **só o horário**,
 *      nunca o desligamento nem a pausa. Quem desligou ou pausou fez isso
 *      depois, e a máquina não passa por cima de decisão humana recente.
 *   4. o horário programado, se houver.
 *
 * Estados contraditórios não existem porque o serviço nunca os grava: pausar
 * limpa `ligada_ate`, e ligar por tempo limpa `pausada_ate`. Resolver o conflito
 * na escrita, e não na leitura, é o que mantém esta função legível.
 *
 * @param {object} conversa       a conversa, como vem do repositório
 * @param {object} configuracao   `{ ativa, pausada_ate, ligada_ate, agenda }`
 * @param {Date}   agora          para a pausa temporária e o horário
 */
function decidirResposta(conversa = {}, configuracao = { ativa: true }, agora = new Date()) {
  if (configuracao?.ativa === false) {
    return { responder: false, motivo: 'serena_desligada', escopo: 'global' };
  }

  if (noFuturo(configuracao?.pausada_ate, agora)) {
    return { responder: false, motivo: 'serena_pausada', escopo: 'global' };
  }

  // Plantão esporádico: liga fora do horário, por um tempo, sem mexer na agenda.
  // Sem isto, atender um sábado exigiria editar a grade e lembrar de desfazer —
  // e o "lembrar de desfazer" é justamente o que ninguém faz.
  const emPlantao = noFuturo(configuracao?.ligada_ate, agora);
  if (!emPlantao && !dentroDoHorario(configuracao?.agenda, agora)) {
    return { responder: false, motivo: 'fora_do_horario', escopo: 'global' };
  }

  if (conversa.assumida_por_humano) {
    return { responder: false, motivo: 'assumida_por_humano', escopo: 'conversa' };
  }
  if (conversa.atribuido_a) {
    return { responder: false, motivo: 'humano_responsavel', escopo: 'conversa' };
  }
  if (conversa.status === 'resolvida') {
    return { responder: false, motivo: 'conversa_resolvida', escopo: 'conversa' };
  }
  if (conversa.ia_pausada_ate && new Date(conversa.ia_pausada_ate) > agora) {
    return { responder: false, motivo: 'ia_pausada', escopo: 'conversa' };
  }

  return { responder: true, motivo: null, escopo: null };
}

/**
 * Monta o prompt que está no ar: a versão publicada mais as regras ligadas.
 *
 * Regras desligadas não aparecem — é o que torna "desativar regra" uma ação com
 * efeito imediato, sem edição de texto. Sem prompt publicado, devolve `null`:
 * montar um prompt a partir de regras soltas produziria instruções sem
 * identidade, e um agente sem identidade responde qualquer coisa.
 */
function montarPromptEfetivo(promptPublicado, regras = []) {
  if (!promptPublicado?.conteudo) return null;

  const ativas = regras
    .filter((regra) => regra.ativa)
    .sort((a, b) => (ORDEM_DAS_CATEGORIAS[a.categoria] ?? 99) - (ORDEM_DAS_CATEGORIAS[b.categoria] ?? 99)
      || (a.ordem ?? 100) - (b.ordem ?? 100)
      || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  if (ativas.length === 0) return promptPublicado.conteudo;

  const secoes = [];
  let categoriaAtual = null;
  for (const regra of ativas) {
    if (regra.categoria !== categoriaAtual) {
      categoriaAtual = regra.categoria;
      secoes.push(`\n## ${TITULO_POR_CATEGORIA[categoriaAtual] ?? 'Regras'}`);
    }
    secoes.push(`- ${regra.conteudo.trim()}`);
  }

  return `${promptPublicado.conteudo.trim()}\n${secoes.join('\n')}\n`;
}

/** Texto validado de um prompt novo. Vazio ou minúsculo não vira versão. */
function validarPrompt({ titulo, conteudo }) {
  const tituloLimpo = String(titulo ?? '').trim();
  const conteudoLimpo = String(conteudo ?? '').trim();

  if (!tituloLimpo) throw new ErroDaSerena('o prompt precisa de um título', 'titulo_obrigatorio');
  if (tituloLimpo.length > 120) throw new ErroDaSerena('o título é longo demais', 'titulo_longo');
  if (conteudoLimpo.length < 20) {
    throw new ErroDaSerena('o prompt precisa de pelo menos 20 caracteres', 'conteudo_curto');
  }
  if (conteudoLimpo.length > LIMITE_CONTEUDO_PROMPT) {
    throw new ErroDaSerena(`o prompt não pode passar de ${LIMITE_CONTEUDO_PROMPT} caracteres`, 'conteudo_longo');
  }

  return { titulo: tituloLimpo.slice(0, 120), conteudo: conteudoLimpo };
}

function validarRegra({ nome, conteudo, categoria = 'geral', descricao = null, ordem = 100 }) {
  const nomeLimpo = String(nome ?? '').trim();
  const conteudoLimpo = String(conteudo ?? '').trim();

  if (!nomeLimpo) throw new ErroDaSerena('a regra precisa de um nome', 'nome_obrigatorio');
  if (nomeLimpo.length > 80) throw new ErroDaSerena('o nome da regra é longo demais', 'nome_longo');
  if (conteudoLimpo.length < 3) throw new ErroDaSerena('a regra precisa de conteúdo', 'conteudo_curto');
  if (conteudoLimpo.length > LIMITE_CONTEUDO_REGRA) {
    throw new ErroDaSerena(`a regra não pode passar de ${LIMITE_CONTEUDO_REGRA} caracteres`, 'conteudo_longo');
  }
  if (!CATEGORIAS.includes(categoria)) {
    throw new ErroDaSerena(`categoria deve ser uma de: ${CATEGORIAS.join(', ')}`, 'categoria_invalida');
  }

  const ordemNumero = Number(ordem);
  if (!Number.isInteger(ordemNumero) || ordemNumero < 0 || ordemNumero > 9999) {
    throw new ErroDaSerena('a ordem deve ser um número de 0 a 9999', 'ordem_invalida');
  }

  return {
    nome: nomeLimpo.slice(0, 80),
    conteudo: conteudoLimpo,
    categoria,
    descricao: descricao ? String(descricao).trim().slice(0, 300) : null,
    ordem: ordemNumero,
  };
}

/**
 * Telefone só com dígitos, para comparar sem depender de máscara.
 *
 * "(16) 99312-0938", "16993120938" e "+55 16 99312-0938" são a mesma pessoa, e
 * um CRM que cria três fichas para ela não se recupera direito depois.
 */
function normalizarTelefone(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  // Número brasileiro sem código do país ganha o 55: é o formato que o canal
  // usa, e guardar dos dois jeitos faria a busca falhar em metade dos casos.
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

function telefoneValido(valor) {
  const normalizado = normalizarTelefone(valor);
  // 55 + DDD (2) + número (8 ou 9). Menos que isso não disca.
  return Boolean(normalizado) && normalizado.length >= 12 && normalizado.length <= 15;
}

/**
 * Valida e normaliza a grade de horários vinda da interface.
 *
 * Recusa em vez de corrigir: uma janela com hora inválida silenciosamente
 * descartada viraria "a Serena não responde de manhã" sem nada para investigar.
 * Aqui o erro sai com o dia e a janela que o causaram.
 */
function validarAgenda(bruto) {
  if (bruto === null || bruto === undefined) return null;
  if (typeof bruto !== 'object' || Array.isArray(bruto)) {
    throw new ErroDaSerena('a grade de horários deve ser um objeto', 'agenda_invalida');
  }

  const fuso = String(bruto.fuso ?? FUSO_PADRAO).trim() || FUSO_PADRAO;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fuso });
  } catch {
    throw new ErroDaSerena(`fuso horário desconhecido: ${fuso}`, 'agenda_invalida');
  }

  const dias = {};
  const NOMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  for (let dia = 0; dia <= 6; dia += 1) {
    const janelas = bruto.dias?.[String(dia)] ?? bruto.dias?.[dia] ?? [];
    if (!Array.isArray(janelas)) {
      throw new ErroDaSerena(`as janelas de ${NOMES[dia]} devem ser uma lista`, 'agenda_invalida');
    }

    dias[String(dia)] = janelas.map((janela) => {
      if (!Array.isArray(janela) || janela.length !== 2) {
        throw new ErroDaSerena(`janela de ${NOMES[dia]} deve ser [início, fim]`, 'agenda_invalida');
      }
      const [inicio, fim] = janela;
      if (emMinutos(inicio) === null || emMinutos(fim) === null) {
        throw new ErroDaSerena(
          `horário inválido em ${NOMES[dia]}: "${inicio}"–"${fim}" (use HH:MM)`, 'agenda_invalida',
        );
      }
      return [String(inicio).trim(), String(fim).trim()];
    });
  }

  return { ativa: bruto.ativa === true, fuso, dias };
}

module.exports = {
  FUSO_PADRAO,
  dentroDoHorario,
  validarAgenda,
  CATEGORIAS,
  ORDEM_DAS_CATEGORIAS,
  TITULO_POR_CATEGORIA,
  LIMITE_CONTEUDO_PROMPT,
  LIMITE_CONTEUDO_REGRA,
  ErroDaSerena,
  decidirResposta,
  montarPromptEfetivo,
  validarPrompt,
  validarRegra,
  normalizarTelefone,
  telefoneValido,
};
