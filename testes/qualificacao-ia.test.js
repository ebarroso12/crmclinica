'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  criarExtratorDeQualificacao, montarPrompt, interpretarResposta, interesseSeguro,
} = require('../src/dominio/qualificacao-ia');

test('interesseSeguro descarta texto vazio e conteúdo clínico', () => {
  assert.equal(interesseSeguro(''), null);
  assert.equal(interesseSeguro('   '), null);
  assert.equal(interesseSeguro(null), null);
  assert.equal(interesseSeguro('estou com muita dor e febre'), null);
  assert.equal(interesseSeguro('quero saber o resultado do exame'), null);
  assert.equal(interesseSeguro('avaliação de rotina'), 'avaliação de rotina');
});

test('interpretarResposta só aceita JSON estrito no vocabulário conhecido', () => {
  assert.deepEqual(interpretarResposta(''), {});
  assert.deepEqual(interpretarResposta('não é json'), {});
  assert.deepEqual(interpretarResposta('{"pagamento": "bitcoin"}'), {});

  // Cerca de markdown, que o modelo às vezes usa mesmo instruído a não usar.
  const comCerca = '```json\n{"pagamento": "particular"}\n```';
  assert.deepEqual(interpretarResposta(comCerca), { pagamento: 'particular' });

  const completo = JSON.stringify({
    interesse: 'avaliação de rotina',
    primeira_consulta: true,
    pagamento: 'convenio',
    urgencia: 'semanas',
    disponibilidade: 'tarde',
  });
  assert.deepEqual(interpretarResposta(completo), {
    interesse: 'avaliação de rotina',
    primeira_consulta: true,
    pagamento: 'convenio',
    urgencia: 'semanas',
    disponibilidade: 'tarde',
  });

  // Conteúdo clínico no campo comercial nunca sobrevive, mesmo que o modelo
  // desobedeça a instrução do sistema — defesa em profundidade.
  assert.deepEqual(
    interpretarResposta(JSON.stringify({ interesse: 'dor de cabeça forte', pagamento: 'particular' })),
    { pagamento: 'particular' },
  );

  // Array ou tipo primitivo não é um objeto de campos: falha fechada.
  assert.deepEqual(interpretarResposta('[1,2,3]'), {});
  assert.deepEqual(interpretarResposta('"texto solto"'), {});
});

test('montarPrompt inclui a transcrição e só o que já foi confirmado', () => {
  const mensagens = [
    { autor_tipo: 'contato', conteudo: 'Quero saber sobre botox', tipo: 'texto', privada: false },
    { autor_tipo: 'automacao', conteudo: 'Claro! Já é paciente da clínica?', tipo: 'texto', privada: false },
    { autor_tipo: 'sistema', conteudo: 'nota interna', tipo: 'sistema', privada: false },
    { autor_tipo: 'equipe', conteudo: 'nota privada', tipo: 'texto', privada: true },
  ];
  const prompt = montarPrompt(mensagens, { pagamento: 'particular' });

  assert.match(prompt, /Paciente: Quero saber sobre botox/);
  assert.match(prompt, /Clínica: Claro! Já é paciente da clínica\?/);
  assert.doesNotMatch(prompt, /nota interna/);
  assert.doesNotMatch(prompt, /nota privada/);
  assert.match(prompt, /"pagamento":"particular"/);
});

test('extrair nunca lança: gateway com erro devolve objeto vazio', async () => {
  const gateway = { gerar: async () => { throw new Error('provedor fora do ar'); } };
  const extrator = criarExtratorDeQualificacao({ gateway });

  const resultado = await extrator.extrair({
    mensagens: [], qualificacaoAtual: {}, chaveIdempotencia: 'qualificacao:1:1',
  });
  assert.deepEqual(resultado, {});
});

test('extrair nunca lança: resposta ilegível do modelo devolve objeto vazio', async () => {
  const gateway = { gerar: async () => ({ resposta: 'desculpe, não posso ajudar com isso' }) };
  const extrator = criarExtratorDeQualificacao({ gateway });

  const resultado = await extrator.extrair({
    mensagens: [], qualificacaoAtual: {}, chaveIdempotencia: 'qualificacao:1:1',
  });
  assert.deepEqual(resultado, {});
});

test('extrair sem chave de idempotência não chama o gateway', async () => {
  let chamou = false;
  const gateway = { gerar: async () => { chamou = true; return { resposta: '{}' }; } };
  const extrator = criarExtratorDeQualificacao({ gateway });

  const resultado = await extrator.extrair({ mensagens: [], qualificacaoAtual: {} });
  assert.deepEqual(resultado, {});
  assert.equal(chamou, false);
});

test('extrair devolve os campos que o gateway extraiu, validados', async () => {
  const chamadas = [];
  const gateway = {
    gerar: async (pedido) => {
      chamadas.push(pedido);
      return { resposta: JSON.stringify({ interesse: 'avaliação de rotina', urgencia: 'imediata' }) };
    },
  };
  const extrator = criarExtratorDeQualificacao({ gateway });

  const resultado = await extrator.extrair({
    mensagens: [{ autor_tipo: 'contato', conteudo: 'Preciso de uma avaliação urgente', tipo: 'texto' }],
    qualificacaoAtual: {},
    chaveIdempotencia: 'qualificacao:42:7',
  });

  assert.deepEqual(resultado, { interesse: 'avaliação de rotina', urgencia: 'imediata' });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].finalidade, 'qualificacao_lead');
  assert.equal(chamadas[0].chaveIdempotencia, 'qualificacao:42:7');
  assert.match(chamadas[0].sistema, /Comercial|comercial/);
});

test('criarExtratorDeQualificacao exige o gateway', () => {
  assert.throws(() => criarExtratorDeQualificacao({}), /gateway/);
});
