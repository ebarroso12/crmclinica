'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decidirResposta, montarPromptEfetivo, validarPrompt, validarRegra,
  normalizarTelefone, telefoneValido, ErroDaSerena,
} = require('../src/dominio/serena');

// Regras da Serena, sem banco e sem rede.
//
// O teste mais importante daqui é o da precedência: o desligamento global vem
// antes de qualquer regra por conversa. Uma exceção — uma conversa que
// "merecia" resposta com a automação desligada — é exatamente o caso que o
// desligamento existe para impedir.

// ---------------------------------------------------------------- decisão

test('com a Serena ligada e a conversa livre, ela responde', () => {
  const decisao = decidirResposta({ status: 'aberta' }, { ativa: true });
  assert.deepEqual(decisao, { responder: true, motivo: null, escopo: null });
});

test('desligada globalmente, não responde nem a conversa mais limpa', () => {
  const decisao = decidirResposta({ status: 'aberta' }, { ativa: false });
  assert.equal(decisao.responder, false);
  assert.equal(decisao.motivo, 'serena_desligada');
  assert.equal(decisao.escopo, 'global');
});

test('o desligamento global vence a regra por conversa', () => {
  // Se a ordem fosse a inversa, o motivo registrado seria "assumida_por_humano"
  // e ninguém saberia que a automação estava desligada.
  const decisao = decidirResposta({ assumida_por_humano: true }, { ativa: false });
  assert.equal(decisao.motivo, 'serena_desligada');
});

test('ligada, as regras por conversa continuam valendo', () => {
  const casos = [
    [{ assumida_por_humano: true }, 'assumida_por_humano'],
    [{ atribuido_a: 7 }, 'humano_responsavel'],
    [{ status: 'resolvida' }, 'conversa_resolvida'],
  ];

  for (const [conversa, motivo] of casos) {
    const decisao = decidirResposta(conversa, { ativa: true });
    assert.equal(decisao.responder, false);
    assert.equal(decisao.motivo, motivo);
    assert.equal(decisao.escopo, 'conversa');
  }
});

test('a pausa individual expira sozinha', () => {
  const agora = new Date('2026-08-02T12:00:00Z');
  const pausada = { ia_pausada_ate: '2026-08-02T12:30:00Z' };
  const vencida = { ia_pausada_ate: '2026-08-02T11:30:00Z' };

  assert.equal(decidirResposta(pausada, { ativa: true }, agora).motivo, 'ia_pausada');
  assert.equal(decidirResposta(vencida, { ativa: true }, agora).responder, true);
});

test('sem configuração informada, o padrão é responder', () => {
  // Um sistema que fica mudo porque a configuração não carregou é pior que um
  // que fala: o segundo é percebido na hora.
  assert.equal(decidirResposta({ status: 'aberta' }).responder, true);
});

// ---------------------------------------------------------------- prompt efetivo

const PROMPT = { conteudo: 'Você é Serena, assistente da clínica.' };

test('sem prompt publicado não há prompt efetivo', () => {
  assert.equal(montarPromptEfetivo(null, []), null);
  assert.equal(montarPromptEfetivo({ conteudo: '' }, []), null);
});

test('sem regras, o efetivo é o próprio prompt', () => {
  assert.equal(montarPromptEfetivo(PROMPT, []), PROMPT.conteudo);
});

test('as regras entram agrupadas, com barreira clínica antes de estilo', () => {
  const efetivo = montarPromptEfetivo(PROMPT, [
    { nome: 'curto', categoria: 'estilo', ordem: 10, conteudo: 'Seja breve.', ativa: true },
    { nome: 'sem diagnóstico', categoria: 'barreira', ordem: 10, conteudo: 'Nunca diagnostique.', ativa: true },
    { nome: 'samu', categoria: 'encaminhamento', ordem: 10, conteudo: 'Emergência: SAMU 192.', ativa: true },
  ]);

  const posBarreira = efetivo.indexOf('Nunca diagnostique');
  const posEncaminhamento = efetivo.indexOf('SAMU 192');
  const posEstilo = efetivo.indexOf('Seja breve');

  // O que ela não pode fazer vem antes de como ela fala.
  assert.ok(posBarreira < posEncaminhamento, 'barreira antes de encaminhamento');
  assert.ok(posEncaminhamento < posEstilo, 'encaminhamento antes de estilo');
  assert.match(efetivo, /## Barreiras clínicas/);
});

test('regra desligada some do prompt efetivo', () => {
  const efetivo = montarPromptEfetivo(PROMPT, [
    { nome: 'ligada', categoria: 'geral', ordem: 1, conteudo: 'Vale.', ativa: true },
    { nome: 'desligada', categoria: 'geral', ordem: 2, conteudo: 'Não vale.', ativa: false },
  ]);

  assert.match(efetivo, /Vale\./);
  assert.doesNotMatch(efetivo, /Não vale\./);
});

test('a ordem dentro da categoria é respeitada', () => {
  const efetivo = montarPromptEfetivo(PROMPT, [
    { nome: 'b', categoria: 'barreira', ordem: 20, conteudo: 'Segunda.', ativa: true },
    { nome: 'a', categoria: 'barreira', ordem: 10, conteudo: 'Primeira.', ativa: true },
  ]);
  assert.ok(efetivo.indexOf('Primeira') < efetivo.indexOf('Segunda'));
});

// ---------------------------------------------------------------- validação

test('prompt sem título ou curto demais é recusado', () => {
  assert.throws(() => validarPrompt({ titulo: '', conteudo: 'x'.repeat(50) }), ErroDaSerena);
  assert.throws(() => validarPrompt({ titulo: 'ok', conteudo: 'curto' }), (erro) => {
    assert.equal(erro.codigo, 'conteudo_curto');
    return true;
  });
});

test('prompt válido volta limpo', () => {
  const validado = validarPrompt({ titulo: '  Política  ', conteudo: `  ${'a'.repeat(30)}  ` });
  assert.equal(validado.titulo, 'Política');
  assert.equal(validado.conteudo, 'a'.repeat(30));
});

test('regra exige nome, conteúdo e categoria conhecida', () => {
  assert.throws(() => validarRegra({ nome: '', conteudo: 'algo' }), ErroDaSerena);
  // "ok" tem 2 caracteres e o mínimo é 3 — o conteúdo é validado antes.
  assert.throws(() => validarRegra({ nome: 'x', conteudo: 'vale', categoria: 'inventada' }), (erro) => {
    assert.equal(erro.codigo, 'categoria_invalida');
    return true;
  });
  assert.throws(() => validarRegra({ nome: 'x', conteudo: 'vale', ordem: -1 }), (erro) => {
    assert.equal(erro.codigo, 'ordem_invalida');
    return true;
  });
});

// ---------------------------------------------------------------- telefone

test('telefone é normalizado para o formato do canal', () => {
  // Três formas de escrever a mesma pessoa. Um CRM que cria três fichas para
  // ela não se recupera direito depois.
  assert.equal(normalizarTelefone('(16) 99312-0938'), '5516993120938');
  assert.equal(normalizarTelefone('16993120938'), '5516993120938');
  assert.equal(normalizarTelefone('+55 16 99312-0938'), '5516993120938');
  assert.equal(normalizarTelefone('5516993120938'), '5516993120938');
});

test('telefone vazio ou curto não passa', () => {
  assert.equal(normalizarTelefone(''), null);
  assert.equal(normalizarTelefone(null), null);
  assert.equal(telefoneValido('123'), false);
  assert.equal(telefoneValido('(16) 99312-0938'), true);
  // Fixo com 10 dígitos também é telefone.
  assert.equal(telefoneValido('1633334444'), true);
});
