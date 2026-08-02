'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gerarHash, conferir } = require('../src/seguranca/senha');
const { emitir, verificar } = require('../src/seguranca/jwt');
const { PAPEIS, podeFazer, permissoesDoPapel, exigirPermissao, ErroDeAutorizacao } = require('../src/seguranca/rbac');

// Segredo sintético de teste. Não corresponde a nenhum ambiente real.
const SEGREDO = 'segredo-sintetico-de-teste-com-mais-de-32-caracteres';

// ---------------------------------------------------------------- senha

test('o hash confere a senha certa e recusa a errada', async () => {
  const hash = await gerarHash('senha-de-teste-123');

  assert.equal(await conferir('senha-de-teste-123', hash), true);
  assert.equal(await conferir('senha-de-teste-124', hash), false);
  assert.equal(await conferir('', hash), false);
});

test('o mesmo texto gera hashes diferentes — o sal é por senha', async () => {
  const primeiro = await gerarHash('senha-de-teste-123');
  const segundo = await gerarHash('senha-de-teste-123');

  assert.notEqual(primeiro, segundo, 'sem sal por senha, hashes iguais denunciam senhas iguais');
  assert.equal(await conferir('senha-de-teste-123', primeiro), true);
  assert.equal(await conferir('senha-de-teste-123', segundo), true);
});

test('o hash carrega os parâmetros de custo para poder envelhecer', async () => {
  const hash = await gerarHash('senha-de-teste-123');
  const [algoritmo, N, r, p, sal, derivada] = hash.split('$');

  assert.equal(algoritmo, 'scrypt');
  assert.ok(Number(N) >= 16384, 'custo baixo demais não resiste a força bruta');
  assert.ok(Number(r) > 0 && Number(p) > 0);
  assert.ok(sal.length >= 32 && derivada.length >= 64);
});

test('senha curta é recusada na criação', async () => {
  await assert.rejects(() => gerarHash('curta'), /8 caracteres/);
});

test('hash corrompido devolve false em vez de explodir', async () => {
  for (const invalido of ['', 'nada', 'scrypt$x$y$z', 'md5$1$1$1$aa$bb', null, undefined]) {
    assert.equal(await conferir('senha-de-teste-123', invalido), false);
  }
});

// ---------------------------------------------------------------- JWT

test('o token emitido é verificável e carrega as reivindicações', () => {
  const token = emitir({ sub: '7', nome: 'Recepção', papel: 'atendente' }, SEGREDO, 60);
  const { valido, conteudo } = verificar(token, SEGREDO);

  assert.equal(valido, true);
  assert.equal(conteudo.sub, '7');
  assert.equal(conteudo.papel, 'atendente');
  assert.ok(conteudo.exp > conteudo.iat);
});

test('token assinado com outro segredo é recusado', () => {
  const token = emitir({ sub: '7' }, SEGREDO, 60);
  const resultado = verificar(token, 'outro-segredo-qualquer-com-tamanho-suficiente');

  assert.equal(resultado.valido, false);
  assert.equal(resultado.motivo, 'assinatura');
});

test('token com payload adulterado é recusado', () => {
  const token = emitir({ sub: '7', papel: 'atendente' }, SEGREDO, 60);
  const [cabecalho, , assinatura] = token.split('.');

  // Tentativa clássica: trocar o papel por admin mantendo a assinatura.
  const forjado = Buffer.from(JSON.stringify({
    sub: '7', papel: 'admin', iat: 1, exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');

  assert.equal(verificar(`${cabecalho}.${forjado}.${assinatura}`, SEGREDO).valido, false);
});

test('token expirado é recusado', () => {
  const expirado = emitir({ sub: '7' }, SEGREDO, -10);
  const resultado = verificar(expirado, SEGREDO);

  assert.equal(resultado.valido, false);
  assert.equal(resultado.motivo, 'expirado');
});

test('o algoritmo vem do nosso lado, não do cabeçalho do token', () => {
  // "alg: none" com assinatura vazia — o ataque que derruba quem confia no cabeçalho.
  const cabecalho = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: '7', papel: 'admin', exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');

  assert.equal(verificar(`${cabecalho}.${payload}.`, SEGREDO).valido, false);
  assert.equal(verificar(`${cabecalho}.${payload}.x`, SEGREDO).valido, false);
});

test('entradas malformadas não passam nem lançam', () => {
  for (const invalido of ['', 'a.b', 'a.b.c.d', null, undefined, 42, {}]) {
    assert.equal(verificar(invalido, SEGREDO).valido, false);
  }
  assert.equal(verificar(emitir({ sub: '1' }, SEGREDO, 60), '').valido, false);
});

test('emitir sem segredo é erro de programação, não silêncio', () => {
  assert.throws(() => emitir({ sub: '1' }, '', 60), /segredo/);
});

// ---------------------------------------------------------------- RBAC

test('os três papéis estão declarados', () => {
  assert.deepEqual(PAPEIS, ['admin', 'gestor', 'atendente']);
});

test('atendente atende, mas não prioriza nem edita ficha nem gerencia usuários', () => {
  assert.equal(podeFazer('atendente', 'conversas:ler'), true);
  assert.equal(podeFazer('atendente', 'conversas:responder'), true);
  assert.equal(podeFazer('atendente', 'conversas:assumir'), true);
  assert.equal(podeFazer('atendente', 'conversas:etiquetar'), true);

  assert.equal(podeFazer('atendente', 'conversas:priorizar'), false);
  assert.equal(podeFazer('atendente', 'contatos:editar'), false);
  assert.equal(podeFazer('atendente', 'usuarios:gerenciar'), false);
  assert.equal(podeFazer('atendente', 'auditoria:ler'), false);
});

test('gestor faz tudo do atendimento, menos gerenciar usuários', () => {
  assert.equal(podeFazer('gestor', 'conversas:priorizar'), true);
  assert.equal(podeFazer('gestor', 'contatos:editar'), true);
  assert.equal(podeFazer('gestor', 'auditoria:ler'), true);
  assert.equal(podeFazer('gestor', 'usuarios:gerenciar'), false);
});

test('admin pode tudo que está declarado', () => {
  for (const permissao of permissoesDoPapel('admin')) {
    assert.equal(podeFazer('admin', permissao), true);
  }
  assert.equal(podeFazer('admin', 'usuarios:gerenciar'), true);
});

test('papel desconhecido não recebe nada — a falta de regra nega', () => {
  assert.equal(podeFazer('estagiario', 'conversas:ler'), false);
  assert.equal(podeFazer(undefined, 'conversas:ler'), false);
  assert.deepEqual(permissoesDoPapel('estagiario'), []);
});

test('permissão inexistente é negada em vez de liberada', () => {
  assert.equal(podeFazer('admin', 'permissao:inventada'), false);
});

test('exigirPermissao separa 401 de 403', () => {
  // Sem usuário: não sei quem você é.
  assert.throws(() => exigirPermissao(null, 'conversas:ler'), (erro) => erro.status === 401);

  // Com usuário sem direito: sei, e você não pode.
  assert.throws(
    () => exigirPermissao({ papel: 'atendente' }, 'usuarios:gerenciar'),
    (erro) => erro instanceof ErroDeAutorizacao && erro.status === 403,
  );

  // Com direito: passa em silêncio.
  assert.doesNotThrow(() => exigirPermissao({ papel: 'atendente' }, 'conversas:ler'));
});
