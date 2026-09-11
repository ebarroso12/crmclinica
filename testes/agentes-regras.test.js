'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  CONFIGURACOES_PADRAO, normalizarConfiguracoes, validarConfiguracoes, validarAgente,
  validarTreinamento, validarAcoesDeInatividade, validarCanais,
} = require('../src/dominio/agentes/regras');
const { ErroDeContrato } = require('../src/contratos/erros');

// Regras compartilhadas dos agentes. Isto prova validação e normalização
// isoladas — NÃO prova que repositório, motor e API as usam; cada peça tem a
// própria suíte para isso.

test('normalizarConfiguracoes sem nada devolve os padrões do contrato', () => {
  assert.deepEqual(normalizarConfiguracoes(null), { ...CONFIGURACOES_PADRAO });
  assert.deepEqual(normalizarConfiguracoes('lixo'), { ...CONFIGURACOES_PADRAO });
});

test('normalizarConfiguracoes nunca lança: valor inválido vira o padrão', () => {
  const lido = normalizarConfiguracoes({
    usar_emojis: 'sim', fuso: 'Marte/Olympus', tempo_resposta_segundos: -3,
    limite_interacoes: 0, acao_limite: 'explodir', horario: { fuso: 'Marte/Olympus' },
  });
  assert.equal(lido.usar_emojis, CONFIGURACOES_PADRAO.usar_emojis);
  assert.equal(lido.fuso, CONFIGURACOES_PADRAO.fuso);
  assert.equal(lido.tempo_resposta_segundos, CONFIGURACOES_PADRAO.tempo_resposta_segundos);
  assert.equal(lido.limite_interacoes, CONFIGURACOES_PADRAO.limite_interacoes);
  assert.equal(lido.acao_limite, CONFIGURACOES_PADRAO.acao_limite);
  assert.equal(lido.horario, null);
});

test('limite_interacoes: null explícito é "sem limite", ausência é o padrão', () => {
  assert.equal(normalizarConfiguracoes({ limite_interacoes: null }).limite_interacoes, null);
  assert.equal(normalizarConfiguracoes({}).limite_interacoes, 20);
  assert.equal(validarConfiguracoes({ limite_interacoes: null }).limite_interacoes, null);
});

test('validarConfiguracoes recusa chave desconhecida e tipo errado, com o campo', () => {
  assert.throws(() => validarConfiguracoes({ usar_emoji: true }), (erro) => erro instanceof ErroDeContrato
    && erro.campo === 'configuracoes.usar_emoji');
  assert.throws(() => validarConfiguracoes({ assinar_nome: 'true' }), (erro) => erro.campo === 'configuracoes.assinar_nome');
  assert.throws(() => validarConfiguracoes({ tempo_resposta_segundos: 500 }), ErroDeContrato);
  assert.throws(() => validarConfiguracoes({ acao_limite: 'sumir' }), ErroDeContrato);
});

test('validarAgente na criação exige slug e nome e preenche padrões', () => {
  const agente = validarAgente({ slug: 'teste-1', nome: '  Agente Teste ' });
  assert.equal(agente.slug, 'teste-1');
  assert.equal(agente.nome, 'Agente Teste');
  assert.equal(agente.status, 'desativado', 'agente novo nunca nasce respondendo');
  assert.equal(agente.comunicacao, 'normal');
  assert.equal(agente.finalidade, 'suporte');

  assert.throws(() => validarAgente({ nome: 'Sem slug' }), (erro) => erro.campo === 'slug');
  assert.throws(() => validarAgente({ slug: 'Maiuscula', nome: 'x' }), (erro) => erro.campo === 'slug');
  assert.throws(() => validarAgente({ slug: 'ok', nome: '   ' }), (erro) => erro.campo === 'nome');
});

test('validarAgente na edição devolve só o que veio e recusa campo desconhecido', () => {
  assert.deepEqual(validarAgente({ status: 'ativo' }, { parcial: true }), { status: 'ativo' });
  assert.throws(() => validarAgente({ statuss: 'ativo' }, { parcial: true }), (erro) => erro.campo === 'statuss');
  assert.throws(() => validarAgente({ empresa_site: 'javascript:alert(1)' }, { parcial: true }), (erro) => erro.campo === 'empresa_site');
});

test('validarAcoesDeInatividade ordena por tempo e exige instrução em "interagir"', () => {
  const acoes = validarAcoesDeInatividade([
    { apos_minutos: 30, acao: 'finalizar' },
    { apos_minutos: 5, acao: 'interagir', instrucao: 'Perguntar se ainda tem interesse' },
  ]);
  assert.deepEqual(acoes.map((acao) => [acao.apos_minutos, acao.acao, acao.ordem]), [[5, 'interagir', 0], [30, 'finalizar', 1]]);

  assert.throws(() => validarAcoesDeInatividade([{ apos_minutos: 5, acao: 'interagir' }]), ErroDeContrato);
  assert.throws(() => validarAcoesDeInatividade([
    { apos_minutos: 5, acao: 'finalizar' }, { apos_minutos: 5, acao: 'finalizar' },
  ]), ErroDeContrato);
});

test('validarCanais recusa instância com caractere perigoso e canal repetido', () => {
  assert.deepEqual(validarCanais([{ canal: 'whatsapp', instancia: 'alpins' }]), [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
  assert.throws(() => validarCanais([{ canal: 'whatsapp', instancia: '../clinica' }]), ErroDeContrato);
  assert.throws(() => validarCanais([
    { canal: 'whatsapp', instancia: 'a' }, { canal: 'whatsapp', instancia: 'a' },
  ]), ErroDeContrato);
  assert.throws(() => validarCanais([
    { canal: 'whatsapp', instancia: 'Alpins' }, { canal: 'whatsapp', instancia: 'alpins' },
  ]), ErroDeContrato, 'mesma instância com outra caixa é repetição (índice único por lower(instancia))');
});

test('os dados do Agente Alpins passam em todas as regras', () => {
  const arquivo = path.join(__dirname, '..', 'configuracao', 'agentes', 'alpins.json');
  const alpins = JSON.parse(fs.readFileSync(arquivo, 'utf8'));

  const campos = {};
  for (const chave of ['slug', 'nome', 'descricao', 'status', 'comunicacao', 'comportamento', 'finalidade',
    'empresa_nome', 'empresa_site', 'empresa_descricao', 'provedor', 'modelo', 'configuracoes']) {
    campos[chave] = alpins[chave];
  }
  const agente = validarAgente(campos);
  assert.equal(agente.slug, 'alpins');
  assert.equal(agente.status, 'desativado');
  assert.deepEqual(normalizarConfiguracoes(agente.configuracoes), normalizarConfiguracoes(alpins.configuracoes));

  for (const treinamento of alpins.treinamentos) validarTreinamento(treinamento);
  assert.equal(alpins.treinamentos.length, 9);
  assert.deepEqual(validarAcoesDeInatividade(alpins.acoes_inatividade), [
    { apos_minutos: 10, acao: 'finalizar', instrucao: null, ordem: 0 },
  ]);
  assert.deepEqual(validarCanais(alpins.canais), [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
});
