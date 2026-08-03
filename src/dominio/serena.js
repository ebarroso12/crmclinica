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

/**
 * A Serena pode responder?
 *
 * `configuracao.ativa === false` cala tudo. É o botão de desligar, e ele não
 * tem exceção: uma conversa que "merecia" resposta enquanto a automação está
 * desligada é exatamente o caso que o desligamento existe para impedir.
 *
 * @param {object} conversa       a conversa, como vem do repositório
 * @param {object} configuracao   `{ ativa: boolean }`
 * @param {Date}   agora          para a pausa temporária
 */
function decidirResposta(conversa = {}, configuracao = { ativa: true }, agora = new Date()) {
  if (configuracao?.ativa === false) {
    return { responder: false, motivo: 'serena_desligada', escopo: 'global' };
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

module.exports = {
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
