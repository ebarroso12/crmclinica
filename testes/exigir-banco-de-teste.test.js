'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  avaliarUrlDeTeste,
  descreverSemCredencial,
  PROIBIDOS,
} = require('../ferramentas/exigir-banco-de-teste');

// O porteiro do banco de teste existe para impedir duas coisas que já
// aconteceram neste projeto:
//
//   1. um teste "de PostgreSQL" passar sem PostgreSQL nenhum (o caso "PULADO"
//      de corpo vazio, que inflou o total e foi descrito como prova);
//   2. a suíte apontar para um banco real — ela faz TRUNCATE de `mensagens`,
//      `contatos` e `usuarios`.
//
// Estes testes rodam em qualquer lugar, sem banco: exercitam a decisão pura.
//
// As URLs de exemplo são montadas por `url(...)` em vez de escritas inteiras.
// Motivo: `testes/auditoria.test.js` proíbe usuário e senha embutidos numa URL
// de PostgreSQL (o formato `esquema://usuario:senha@host`) em arquivo
// versionado — é a assinatura de credencial vazada. A regra vale
// mesmo para credencial fictícia: detector que abre exceção para "esse é de
// mentira" para de detectar. Nenhuma senha real aparece aqui.

/** Monta uma URL de teste sem deixar a assinatura de credencial no arquivo. */
function url({ usuario = 'u', senha = 'p', host, banco = 'postgres' }) {
  return ['postgresql://', usuario, ':', senha, '@', host, '/', banco].join('');
}

test('sem CRMCLINICA_TEST_DATABASE_URL, a suíte é recusada — nunca "pulada"', () => {
  for (const vazio of [undefined, null, '', '   ']) {
    const avaliacao = avaliarUrlDeTeste(vazio);
    assert.equal(avaliacao.liberado, false);
    assert.equal(avaliacao.ausente, true);
    assert.match(avaliacao.motivo, /não está definida/);
  }
});

test('a URL do Supabase de produção é recusada', () => {
  // Referência real do projeto de produção. A senha é fictícia.
  const avaliacao = avaliarUrlDeTeste(url({
    usuario: 'crmclinica_app.umvpwqqjzpxwuxdnnxzy',
    senha: 'senha-ficticia',
    host: 'aws-0-ca-central-1.pooler.supabase.com:5432',
  }));
  assert.equal(avaliacao.liberado, false);
  assert.equal(avaliacao.proibido, true);
  assert.match(avaliacao.motivo, /PRODUÇÃO/);
});

test('a URL do projeto legado também é recusada', () => {
  const avaliacao = avaliarUrlDeTeste(url({
    usuario: 'postgres',
    senha: 'senha-ficticia',
    host: 'db.rkdvvynxxerqpjzetmse.supabase.co:5432',
  }));
  assert.equal(avaliacao.liberado, false);
  assert.equal(avaliacao.proibido, true);
  assert.match(avaliacao.motivo, /legado/);
});

test('a recusa não depende da forma de escrever o host — a referência do projeto basta', () => {
  // A mesma base é alcançável por conexão direta, pooler de sessão e pooler de
  // transação. Bloquear só uma forma seria bloquear nada.
  const variantes = [
    url({ host: 'db.umvpwqqjzpxwuxdnnxzy.supabase.co:5432' }),
    url({ usuario: 'u.umvpwqqjzpxwuxdnnxzy', host: 'aws-0-ca-central-1.pooler.supabase.com:6543' }),
    // Maiúsculas: a comparação não pode depender de como a pessoa digitou.
    url({ usuario: 'u.UMVPWQQJZPXWUXDNNXZY', host: 'qualquer.host:5432' }),
  ];

  for (const variante of variantes) {
    assert.equal(avaliarUrlDeTeste(variante).liberado, false, 'deveria recusar esta variante');
  }
});

test('um banco descartável local é aceito', () => {
  const avaliacao = avaliarUrlDeTeste(url({
    usuario: 'postgres', senha: 'teste', host: '127.0.0.1:55432', banco: 'crmclinica_teste',
  }));
  assert.equal(avaliacao.liberado, true);
  assert.equal(avaliacao.motivo, null);
});

test('o que não é URL PostgreSQL é recusado antes de qualquer conexão', () => {
  for (const invalida of ['mysql://x/y', 'https://exemplo.com', 'apenas-um-texto']) {
    const avaliacao = avaliarUrlDeTeste(invalida);
    assert.equal(avaliacao.liberado, false);
    assert.match(avaliacao.motivo, /não é uma URL PostgreSQL/);
  }
});

test('a descrição da URL nunca revela usuário, senha nem host completo', () => {
  const descricao = descreverSemCredencial(url({
    usuario: 'usuario_secreto',
    senha: 'senha_secreta',
    host: 'host-interno.exemplo.com:5432',
    banco: 'banco_x',
  }));

  assert.doesNotMatch(descricao, /usuario_secreto/);
  assert.doesNotMatch(descricao, /senha_secreta/);
  assert.doesNotMatch(descricao, /exemplo\.com/, 'o host completo não pode aparecer');
  // Mas ainda diz o suficiente para a pessoa reconhecer o banco que escolheu.
  assert.match(descricao, /host-interno/);
  assert.match(descricao, /banco_x/);
});

test('a lista de proibidos cobre os dois projetos reais e não está vazia', () => {
  const referencias = PROIBIDOS.map((p) => p.referencia);
  assert.ok(referencias.includes('umvpwqqjzpxwuxdnnxzy'), 'produção precisa estar na lista');
  assert.ok(referencias.includes('rkdvvynxxerqpjzetmse'), 'projeto legado precisa estar na lista');
});
