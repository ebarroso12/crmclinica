'use strict';

const { ErroDeContrato } = require('../../contratos/erros');
const { validarAgenda, FUSO_PADRAO } = require('../serena');

// Regras dos agentes configuráveis (ver docs/AGENTES.md).
//
// Uma fonte só para as três peças que falam de agente: o repositório (que
// devolve `configuracoes` já mesclado com os padrões), o motor (que lê essas
// configurações para montar a instrução do modelo) e a API (que valida o que
// a tela manda). Padrão espalhado em três lugares é padrão que diverge — e a
// divergência aparece como o agente fazendo na conversa uma coisa diferente da
// que a tela mostra como ligada.
//
// Duas funções de propósito diferente para configurações:
//   - `normalizarConfiguracoes` é TOLERANTE: lê o que está no banco e nunca
//     lança. Um valor estranho numa linha antiga vira o padrão, não derruba o
//     atendimento.
//   - `validarConfiguracoes` é ESTRITA: é a fronteira da API. Campo
//     desconhecido ou tipo errado é recusado com o nome do campo, porque um
//     erro de digitação aceito em silêncio vira um interruptor que ninguém
//     sabe por que não funciona.

const STATUS_AGENTE = Object.freeze(['ativo', 'treinamento', 'desativado']);
const COMUNICACOES = Object.freeze(['formal', 'normal', 'descontraida']);
const FINALIDADES = Object.freeze(['suporte', 'vendas', 'pessoal']);
const TIPOS_TREINAMENTO = Object.freeze(['texto', 'website', 'documento', 'video']);
const ACOES_INATIVIDADE = Object.freeze(['interagir', 'finalizar']);
const CANAIS_AGENTE = Object.freeze(['whatsapp', 'instagram']);
const ACOES_LIMITE = Object.freeze(['transferir', 'finalizar']);

const LIMITES = Object.freeze({
  nome: 80,
  descricao: 160,
  comportamento: 20000,
  empresaNome: 120,
  empresaSite: 300,
  empresaDescricao: 2000,
  provedor: 40,
  modelo: 120,
  tituloTreinamento: 200,
  conteudoTreinamento: 50000,
  origemTreinamento: 500,
  instrucaoInatividade: 512,
  minutosInatividade: 10080,
  acoesInatividade: 10,
  instancia: 100,
  canais: 10,
  tempoRespostaSegundos: 120,
  limiteInteracoes: 1000,
});

const CONFIGURACOES_PADRAO = Object.freeze({
  transferir_para_humano: true,
  resumo_ao_transferir: true,
  usar_emojis: false,
  assinar_nome: false,
  restringir_temas: true,
  dividir_resposta: false,
  consultar_dados_contato: true,
  busca_inteligente: true,
  fuso: FUSO_PADRAO,
  tempo_resposta_segundos: 10,
  limite_interacoes: 20,
  acao_limite: 'transferir',
  horario: null,
});

const CHAVES_BOOLEANAS = Object.freeze([
  'transferir_para_humano', 'resumo_ao_transferir', 'usar_emojis', 'assinar_nome',
  'restringir_temas', 'dividir_resposta', 'consultar_dados_contato', 'busca_inteligente',
]);

const SLUG = /^[a-z0-9-]{2,40}$/;
const INSTANCIA = /^[A-Za-z0-9_.-]{1,100}$/;

function fusoValido(fuso) {
  if (typeof fuso !== 'string' || !fuso.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fuso.trim() });
    return true;
  } catch {
    return false;
  }
}

function inteiroEntre(valor, minimo, maximo) {
  return Number.isInteger(valor) && valor >= minimo && valor <= maximo;
}

/** Lê configurações vindas do banco. Nunca lança: valor inválido vira o padrão. */
function normalizarConfiguracoes(bruto) {
  const origem = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : {};
  const resultado = { ...CONFIGURACOES_PADRAO };

  for (const chave of CHAVES_BOOLEANAS) {
    if (typeof origem[chave] === 'boolean') resultado[chave] = origem[chave];
  }
  if (fusoValido(origem.fuso)) resultado.fuso = origem.fuso.trim();
  if (inteiroEntre(origem.tempo_resposta_segundos, 0, LIMITES.tempoRespostaSegundos)) {
    resultado.tempo_resposta_segundos = origem.tempo_resposta_segundos;
  }
  // `null` explícito é uma escolha ("sem limite"); ausência é o padrão.
  if (Object.prototype.hasOwnProperty.call(origem, 'limite_interacoes')) {
    if (origem.limite_interacoes === null) resultado.limite_interacoes = null;
    else if (inteiroEntre(origem.limite_interacoes, 1, LIMITES.limiteInteracoes)) {
      resultado.limite_interacoes = origem.limite_interacoes;
    }
  }
  if (ACOES_LIMITE.includes(origem.acao_limite)) resultado.acao_limite = origem.acao_limite;
  if (origem.horario && typeof origem.horario === 'object') {
    try {
      resultado.horario = validarAgenda(origem.horario);
    } catch {
      resultado.horario = null;
    }
  }
  return resultado;
}

/**
 * Valida configurações vindas da API. Devolve só as chaves informadas, já
 * normalizadas — quem grava mescla com o que o agente já tem.
 */
function validarConfiguracoes(parcial) {
  if (parcial === undefined || parcial === null) return {};
  if (typeof parcial !== 'object' || Array.isArray(parcial)) {
    throw new ErroDeContrato('configuracoes deve ser um objeto', 'configuracoes');
  }

  const resultado = {};
  for (const [chave, valor] of Object.entries(parcial)) {
    const campo = `configuracoes.${chave}`;
    if (CHAVES_BOOLEANAS.includes(chave)) {
      if (typeof valor !== 'boolean') throw new ErroDeContrato(`${campo} deve ser verdadeiro ou falso`, campo);
      resultado[chave] = valor;
    } else if (chave === 'fuso') {
      if (!fusoValido(valor)) throw new ErroDeContrato(`fuso horário desconhecido: ${valor}`, campo);
      resultado.fuso = valor.trim();
    } else if (chave === 'tempo_resposta_segundos') {
      if (!inteiroEntre(valor, 0, LIMITES.tempoRespostaSegundos)) {
        throw new ErroDeContrato(`${campo} deve ser um inteiro de 0 a ${LIMITES.tempoRespostaSegundos}`, campo);
      }
      resultado.tempo_resposta_segundos = valor;
    } else if (chave === 'limite_interacoes') {
      if (valor !== null && !inteiroEntre(valor, 1, LIMITES.limiteInteracoes)) {
        throw new ErroDeContrato(`${campo} deve ser vazio (sem limite) ou um inteiro de 1 a ${LIMITES.limiteInteracoes}`, campo);
      }
      resultado.limite_interacoes = valor;
    } else if (chave === 'acao_limite') {
      if (!ACOES_LIMITE.includes(valor)) {
        throw new ErroDeContrato(`${campo} deve ser um de: ${ACOES_LIMITE.join(', ')}`, campo);
      }
      resultado.acao_limite = valor;
    } else if (chave === 'horario') {
      resultado.horario = validarAgenda(valor);
    } else {
      throw new ErroDeContrato(`configuração desconhecida: ${chave}`, campo);
    }
  }
  return resultado;
}

function textoLimitado(valor, campo, limite, { obrigatorio = false } = {}) {
  if (valor === undefined || valor === null) {
    if (obrigatorio) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
    return null;
  }
  if (typeof valor !== 'string') throw new ErroDeContrato(`campo "${campo}" deve ser texto`, campo);
  const limpo = valor.trim();
  if (!limpo) {
    if (obrigatorio) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
    return null;
  }
  if (limpo.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return limpo;
}

function enumerado(valor, campo, permitidos) {
  if (!permitidos.includes(valor)) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um de: ${permitidos.join(', ')}`, campo);
  }
  return valor;
}

const CAMPOS_DO_AGENTE = Object.freeze([
  'slug', 'nome', 'descricao', 'status', 'comunicacao', 'comportamento', 'finalidade',
  'empresa_nome', 'empresa_site', 'empresa_descricao', 'provedor', 'modelo', 'configuracoes',
]);

/**
 * Valida os dados de um agente vindos da API.
 *
 * `parcial: false` (criação) exige slug e nome e preenche os padrões do resto.
 * `parcial: true` (edição) devolve só os campos informados. Campo fora da
 * lista é recusado — ver o comentário do topo sobre erro de digitação.
 */
function validarAgente(dados, { parcial = false } = {}) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    throw new ErroDeContrato('agente deve ser um objeto');
  }
  for (const chave of Object.keys(dados)) {
    if (!CAMPOS_DO_AGENTE.includes(chave)) throw new ErroDeContrato(`campo desconhecido: ${chave}`, chave);
  }

  const tem = (campo) => Object.prototype.hasOwnProperty.call(dados, campo);
  const resultado = {};

  if (!parcial || tem('slug')) {
    const slug = typeof dados.slug === 'string' ? dados.slug.trim() : '';
    if (!SLUG.test(slug)) {
      throw new ErroDeContrato('slug deve ter de 2 a 40 caracteres: letras minúsculas, números e hífen', 'slug');
    }
    resultado.slug = slug;
  }
  if (!parcial || tem('nome')) resultado.nome = textoLimitado(dados.nome, 'nome', LIMITES.nome, { obrigatorio: true });
  if (tem('descricao')) resultado.descricao = textoLimitado(dados.descricao, 'descricao', LIMITES.descricao);

  if (!parcial || tem('status')) resultado.status = enumerado(dados.status ?? 'desativado', 'status', STATUS_AGENTE);
  if (!parcial || tem('comunicacao')) {
    resultado.comunicacao = enumerado(dados.comunicacao ?? 'normal', 'comunicacao', COMUNICACOES);
  }
  if (!parcial || tem('finalidade')) {
    resultado.finalidade = enumerado(dados.finalidade ?? 'suporte', 'finalidade', FINALIDADES);
  }

  if (!parcial || tem('comportamento')) {
    const bruto = dados.comportamento ?? '';
    if (typeof bruto !== 'string') throw new ErroDeContrato('campo "comportamento" deve ser texto', 'comportamento');
    const comportamento = bruto.trim();
    if (comportamento.length > LIMITES.comportamento) {
      throw new ErroDeContrato(`campo "comportamento" excede ${LIMITES.comportamento} caracteres`, 'comportamento');
    }
    resultado.comportamento = comportamento;
  }

  if (tem('empresa_nome')) resultado.empresa_nome = textoLimitado(dados.empresa_nome, 'empresa_nome', LIMITES.empresaNome);
  if (tem('empresa_site')) {
    const site = textoLimitado(dados.empresa_site, 'empresa_site', LIMITES.empresaSite);
    if (site && !/^https?:\/\/\S+$/i.test(site)) {
      throw new ErroDeContrato('empresa_site deve ser um endereço http(s)', 'empresa_site');
    }
    resultado.empresa_site = site;
  }
  if (tem('empresa_descricao')) {
    resultado.empresa_descricao = textoLimitado(dados.empresa_descricao, 'empresa_descricao', LIMITES.empresaDescricao);
  }
  if (tem('provedor')) resultado.provedor = textoLimitado(dados.provedor, 'provedor', LIMITES.provedor);
  if (tem('modelo')) resultado.modelo = textoLimitado(dados.modelo, 'modelo', LIMITES.modelo);

  if (tem('configuracoes')) resultado.configuracoes = validarConfiguracoes(dados.configuracoes);
  return resultado;
}

/** Valida um treinamento. Para `website`, quem chama já buscou a página e preencheu `conteudo`. */
function validarTreinamento(dados) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    throw new ErroDeContrato('treinamento deve ser um objeto');
  }
  return {
    tipo: enumerado(dados.tipo ?? 'texto', 'tipo', TIPOS_TREINAMENTO),
    titulo: textoLimitado(dados.titulo, 'titulo', LIMITES.tituloTreinamento),
    conteudo: textoLimitado(dados.conteudo, 'conteudo', LIMITES.conteudoTreinamento, { obrigatorio: true }),
    origem: textoLimitado(dados.origem, 'origem', LIMITES.origemTreinamento),
  };
}

/** Valida a lista inteira de ações de inatividade (a gravação substitui todas). */
function validarAcoesDeInatividade(lista) {
  if (!Array.isArray(lista)) throw new ErroDeContrato('acoes deve ser uma lista', 'acoes');
  if (lista.length > LIMITES.acoesInatividade) {
    throw new ErroDeContrato(`no máximo ${LIMITES.acoesInatividade} ações de inatividade`, 'acoes');
  }

  const vistos = new Set();
  const normalizadas = lista.map((item, indice) => {
    const campo = `acoes[${indice}]`;
    if (!item || typeof item !== 'object') throw new ErroDeContrato(`${campo} deve ser um objeto`, campo);
    if (!inteiroEntre(item.apos_minutos, 1, LIMITES.minutosInatividade)) {
      throw new ErroDeContrato(`${campo}.apos_minutos deve ser um inteiro de 1 a ${LIMITES.minutosInatividade}`, `${campo}.apos_minutos`);
    }
    if (vistos.has(item.apos_minutos)) {
      throw new ErroDeContrato(`${campo}.apos_minutos repete outro tempo da lista`, `${campo}.apos_minutos`);
    }
    vistos.add(item.apos_minutos);
    const acao = enumerado(item.acao, `${campo}.acao`, ACOES_INATIVIDADE);
    const instrucao = textoLimitado(item.instrucao, `${campo}.instrucao`, LIMITES.instrucaoInatividade, {
      // "Interagir" sem instrução deixaria o modelo inventar o que dizer a um
      // cliente que parou de responder — é justamente a mensagem que mais pesa.
      obrigatorio: acao === 'interagir',
    });
    return { apos_minutos: item.apos_minutos, acao, instrucao };
  });

  return normalizadas
    .sort((a, b) => a.apos_minutos - b.apos_minutos)
    .map((acao, ordem) => ({ ...acao, ordem }));
}

/** Valida a lista inteira de canais do agente (a gravação substitui todos). */
function validarCanais(lista) {
  if (!Array.isArray(lista)) throw new ErroDeContrato('canais deve ser uma lista', 'canais');
  if (lista.length > LIMITES.canais) throw new ErroDeContrato(`no máximo ${LIMITES.canais} canais`, 'canais');

  const vistos = new Set();
  return lista.map((item, indice) => {
    const campo = `canais[${indice}]`;
    if (!item || typeof item !== 'object') throw new ErroDeContrato(`${campo} deve ser um objeto`, campo);
    const canal = enumerado(item.canal, `${campo}.canal`, CANAIS_AGENTE);
    const instancia = typeof item.instancia === 'string' ? item.instancia.trim() : '';
    if (!INSTANCIA.test(instancia)) {
      throw new ErroDeContrato(`${campo}.instancia deve ter até ${LIMITES.instancia} caracteres: letras, números, _ . -`, `${campo}.instancia`);
    }
    const chave = `${canal}:${instancia}`;
    if (vistos.has(chave)) throw new ErroDeContrato(`${campo} repete outro canal da lista`, campo);
    vistos.add(chave);
    if (item.ativo !== undefined && typeof item.ativo !== 'boolean') {
      throw new ErroDeContrato(`${campo}.ativo deve ser verdadeiro ou falso`, `${campo}.ativo`);
    }
    return { canal, instancia, ativo: item.ativo !== false };
  });
}

module.exports = {
  STATUS_AGENTE,
  COMUNICACOES,
  FINALIDADES,
  TIPOS_TREINAMENTO,
  ACOES_INATIVIDADE,
  CANAIS_AGENTE,
  ACOES_LIMITE,
  LIMITES,
  CONFIGURACOES_PADRAO,
  normalizarConfiguracoes,
  validarConfiguracoes,
  validarAgente,
  validarTreinamento,
  validarAcoesDeInatividade,
  validarCanais,
};
