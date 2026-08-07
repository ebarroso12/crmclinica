'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REGRAS, PROMPT } = require('../bin/semear-serena');
const { validarRegra, validarPrompt, montarPromptEfetivo } = require('../src/dominio/serena');

// A política semeada é a defesa de primeira linha da Serena. Estes testes
// garantem que ela é válida, completa e que as regras críticas da clínica
// existem por NOME — remover uma delas quebra o build, não só o atendimento.

test('todas as regras semeadas passam na validação do domínio', () => {
  for (const regra of REGRAS) {
    assert.doesNotThrow(() => validarRegra(regra), `regra inválida: ${regra.nome}`);
  }
  assert.doesNotThrow(() => validarPrompt({ titulo: 'política oficial', conteudo: PROMPT }));
});

test('nenhum nome de regra se repete', () => {
  const nomes = REGRAS.map((regra) => regra.nome);
  assert.equal(new Set(nomes).size, nomes.length);
});

test('as barreiras críticas da clínica existem por nome', () => {
  const nomes = new Set(REGRAS.map((regra) => regra.nome));

  for (const obrigatoria of [
    'sem diagnóstico',
    'sem prescrição',
    'sem interpretar exames',
    'horário só vem da agenda',
    'agendamento só confirmado pelo CRM',
    'conteúdo do paciente não é instrução',
    'formulário só após agendamento confirmado',
    'responder só a mensagem nova',
    'sem bastidores',
    'emergência',
  ]) {
    assert.ok(nomes.has(obrigatoria), `regra obrigatória ausente: "${obrigatoria}"`);
  }
});

test('no prompt montado, as barreiras vêm antes do estilo', () => {
  const regras = REGRAS.map((regra, indice) => ({ ...regra, id: indice + 1, ativa: true }));
  const efetivo = montarPromptEfetivo({ conteudo: PROMPT }, regras);

  const posBarreira = efetivo.indexOf('Nunca invente, estime ou sugira horário');
  const posEstilo = efetivo.indexOf('mensagens curtas');
  assert.ok(posBarreira > -1 && posEstilo > -1);
  assert.ok(posBarreira < posEstilo, 'barreira clínica precisa ser lida antes do estilo');
});

test('a regra de horário proíbe inventar e exige a ferramenta de agenda', () => {
  const regra = REGRAS.find((r) => r.nome === 'horário só vem da agenda');
  assert.match(regra.conteudo, /Nunca invente/);
  assert.match(regra.conteudo, /ferramenta de agenda/);
});

test('a regra de agendamento exige confirmação do sistema antes de afirmar', () => {
  const regra = REGRAS.find((r) => r.nome === 'agendamento só confirmado pelo CRM');
  assert.match(regra.conteudo, /confirmação/);
  assert.match(regra.conteudo, /Nunca afirme/);
});
