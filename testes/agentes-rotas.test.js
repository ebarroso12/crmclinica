'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { criarRotasDeAgentes } = require('../src/servidor/rotas-agentes');
const { criarDespachoDeAgentes } = require('../src/servidor/despacho-agentes');
const { ErroDeContrato } = require('../src/contratos/erros');
const { podeFazer } = require('../src/seguranca/rbac');

// Roteamento HTTP e permissões das rotas de agentes, num servidor node:http
// mínimo com o MESMO despacho que o http.js vai chamar e um tradutor de erro
// equivalente ao dele (ErroDeContrato → 400; `status` conhecido passa).
//
// O que isto NÃO prova: a ligação real dentro de src/servidor/http.js
// (autenticação por token, transação com identidade, ordem dos tratadores).
// Isso precisa de teste próprio quando o despacho for plugado lá.

test('matriz do RBAC: gestor lê, só admin gerencia, atendente não vê', () => {
  assert.equal(podeFazer('admin', 'agentes:ler'), true);
  assert.equal(podeFazer('admin', 'agentes:gerenciar'), true);
  assert.equal(podeFazer('gestor', 'agentes:ler'), true);
  assert.equal(podeFazer('gestor', 'agentes:gerenciar'), false);
  assert.equal(podeFazer('atendente', 'agentes:ler'), false);
  assert.equal(podeFazer('atendente', 'agentes:gerenciar'), false);
});

function servicoFalso() {
  const chamadas = [];
  const anotar = (nome, ...argumentos) => chamadas.push([nome, ...argumentos]);
  const naoEncontrado = () => { const erro = new Error('agente não encontrado'); erro.status = 404; return erro; };
  return {
    chamadas,
    async listar() { anotar('listar'); return [{ id: 1, nome: 'Agente' }]; },
    async obter(id) {
      anotar('obter', id);
      if (id === 99) throw naoEncontrado();
      return { agente: { id }, treinamentos: [], historico: [] };
    },
    async criar(dados, opcoes) { anotar('criar', dados, opcoes); return { id: 2, ...dados }; },
    async atualizar(id, campos, opcoes) { anotar('atualizar', id, campos, opcoes); return { id, ...campos }; },
    async restaurarComportamento(id, historicoId, opcoes) { anotar('restaurar', id, historicoId, opcoes); return { id }; },
    async adicionarTreinamento(id, dados, opcoes) { anotar('treinar', id, dados, opcoes); return { id: 10, ...dados }; },
    async removerTreinamento(id, treinamentoId, opcoes) { anotar('destreinar', id, treinamentoId, opcoes); return true; },
    async definirInatividade(id, acoes, opcoes) { anotar('inatividade', id, acoes, opcoes); return acoes; },
    async definirCanais(id, canais, opcoes) { anotar('canais', id, canais, opcoes); return canais; },
    async testar(id, entrada) { anotar('testar', id, entrada); return { partes: ['oi'], transferir: false }; },
  };
}

function responderJson(res, status, dados, extras = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extras });
  res.end(JSON.stringify(dados));
}

function lerJson(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (pedaco) => { bruto += pedaco; });
    req.on('end', () => {
      try {
        resolve(bruto ? JSON.parse(bruto) : null);
      } catch {
        reject(new ErroDeContrato('corpo não é JSON válido'));
      }
    });
    req.on('error', reject);
  });
}

async function subir({ gateway } = {}) {
  const servico = servicoFalso();
  const rotas = criarRotasDeAgentes({
    servico,
    gateway: gateway ?? { catalogo: async () => [{ provedor: 'anthropic', disponivel: true, modelos: [] }] },
  });
  const despacho = criarDespachoDeAgentes({ rotas, lerJson, responderJson });

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const papel = req.headers['x-papel-teste'];
    const usuario = papel ? { id: 7, papel } : null;
    try {
      const tratou = await despacho.tratar(req, res, url.pathname, req.method, url, usuario);
      if (!tratou) responderJson(res, 418, { erro: 'fora do despacho' });
    } catch (erro) {
      const conhecido = [401, 403, 404, 409, 422, 503].includes(erro.status);
      const status = erro instanceof ErroDeContrato ? 400 : (conhecido ? erro.status : 500);
      responderJson(res, status, { erro: erro.message });
    }
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const pedir = (caminho, { metodo = 'GET', papel = null, corpo } = {}) => fetch(`${base}${caminho}`, {
    method: metodo,
    headers: {
      ...(papel ? { 'x-papel-teste': papel } : {}),
      ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });

  return {
    servico, despacho, pedir,
    encerrar: () => new Promise((resolve) => servidor.close(resolve)),
  };
}

// Cada rota da tabela "API" de docs/AGENTES.md: quem pode e o status de sucesso.
const ROTAS = [
  { rota: '/api/agentes', metodo: 'GET', ler: true, sucesso: 200 },
  { rota: '/api/agentes', metodo: 'POST', corpo: { slug: 'novo', nome: 'Novo' }, sucesso: 201 },
  { rota: '/api/agentes/1', metodo: 'GET', ler: true, sucesso: 200 },
  { rota: '/api/agentes/1', metodo: 'PUT', corpo: { status: 'ativo' }, sucesso: 200 },
  { rota: '/api/agentes/1/comportamento/3/restaurar', metodo: 'POST', sucesso: 200 },
  { rota: '/api/agentes/1/treinamentos', metodo: 'POST', corpo: { tipo: 'texto', conteudo: 'x' }, sucesso: 201 },
  { rota: '/api/agentes/1/treinamentos/4', metodo: 'DELETE', sucesso: 200 },
  { rota: '/api/agentes/1/inatividade', metodo: 'PUT', corpo: { acoes: [] }, sucesso: 200 },
  { rota: '/api/agentes/1/canais', metodo: 'PUT', corpo: { canais: [] }, sucesso: 200 },
  { rota: '/api/agentes/1/teste', metodo: 'POST', corpo: { mensagens: [{ autor: 'cliente', texto: 'oi' }] }, sucesso: 200 },
];

test('sem sessão, toda rota responde 401 — inclusive com id inválido', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  for (const caso of ROTAS) {
    const resposta = await app.pedir(caso.rota, { metodo: caso.metodo, corpo: caso.corpo });
    assert.equal(resposta.status, 401, `${caso.metodo} ${caso.rota}`);
  }
  assert.equal((await app.pedir('/api/agentes/abc')).status, 401, 'sem sessão não se confirma a forma da rota');
  assert.equal(app.servico.chamadas.length, 0, 'nada chega ao serviço sem sessão');
});

test('cada papel recebe exatamente o que a matriz permite', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  for (const caso of ROTAS) {
    for (const papel of ['atendente', 'gestor', 'admin']) {
      const resposta = await app.pedir(caso.rota, { metodo: caso.metodo, papel, corpo: caso.corpo });
      const pode = papel === 'admin' || (papel === 'gestor' && caso.ler === true);
      const esperado = pode ? caso.sucesso : 403;
      assert.equal(resposta.status, esperado, `${papel} em ${caso.metodo} ${caso.rota}`);
      assert.equal(resposta.headers.get('cache-control'), pode ? 'no-store' : null);
    }
  }
});

test('o despacho entrega ids numéricos, corpo e o usuário ao serviço', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  await app.pedir('/api/agentes/5', { metodo: 'PUT', papel: 'admin', corpo: { nome: 'Novo nome' } });
  await app.pedir('/api/agentes/5/treinamentos/8', { metodo: 'DELETE', papel: 'admin' });
  await app.pedir('/api/agentes/5/comportamento/2/restaurar', { metodo: 'POST', papel: 'admin' });
  await app.pedir('/api/agentes/5/teste', { metodo: 'POST', papel: 'admin', corpo: { mensagens: [{ autor: 'cliente', texto: 'oi' }] } });

  assert.deepEqual(app.servico.chamadas, [
    ['atualizar', 5, { nome: 'Novo nome' }, { usuarioId: 7 }],
    ['destreinar', 5, 8, { usuarioId: 7 }],
    ['restaurar', 5, 2, { usuarioId: 7 }],
    ['testar', 5, { mensagens: [{ autor: 'cliente', texto: 'oi' }] }],
  ]);
});

test('listar traz catálogo e pode_gerenciar; catálogo quebrado não derruba a tela', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  const comoGestor = await (await app.pedir('/api/agentes', { papel: 'gestor' })).json();
  assert.equal(comoGestor.pode_gerenciar, false);
  assert.equal(comoGestor.catalogo[0].provedor, 'anthropic');
  assert.equal((await (await app.pedir('/api/agentes', { papel: 'admin' })).json()).pode_gerenciar, true);

  const quebrado = await subir({ gateway: { catalogo: async () => { throw new Error('banco piscou'); } } });
  t.after(() => quebrado.encerrar());
  const resposta = await quebrado.pedir('/api/agentes', { papel: 'admin' });
  assert.equal(resposta.status, 200);
  assert.deepEqual((await resposta.json()).catalogo, []);
});

test('id inválido é 400; agente inexistente é 404', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  for (const [rota, metodo] of [
    ['/api/agentes/abc', 'GET'], ['/api/agentes/0', 'GET'], ['/api/agentes/-1', 'PUT'],
    ['/api/agentes/1/treinamentos/xyz', 'DELETE'], ['/api/agentes/1/comportamento/0/restaurar', 'POST'],
  ]) {
    const resposta = await app.pedir(rota, { metodo, papel: 'admin', corpo: metodo === 'PUT' ? { nome: 'x' } : undefined });
    assert.equal(resposta.status, 400, `${metodo} ${rota}`);
  }
  assert.equal((await app.pedir('/api/agentes/99', { papel: 'gestor' })).status, 404);
});

test('método errado num caminho que existe é 405 com allow; caminho desconhecido é 404', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  for (const [rota, metodo, allow] of [
    ['/api/agentes', 'PUT', 'GET, POST'],
    ['/api/agentes/1', 'DELETE', 'GET, PUT'],
    ['/api/agentes/1/treinamentos', 'GET', 'POST'],
    ['/api/agentes/1/inatividade', 'POST', 'PUT'],
    ['/api/agentes/1/canais', 'GET', 'PUT'],
    ['/api/agentes/1/teste', 'GET', 'POST'],
    ['/api/agentes/1/treinamentos/2', 'PUT', 'DELETE'],
    ['/api/agentes/1/comportamento/2/restaurar', 'GET', 'POST'],
  ]) {
    const resposta = await app.pedir(rota, { metodo, papel: 'admin' });
    assert.equal(resposta.status, 405, `${metodo} ${rota}`);
    assert.equal(resposta.headers.get('allow'), allow);
  }

  for (const rota of ['/api/agentes/1/nada', '/api/agentes/1/comportamento/2/apagar', '/api/agentes/1/a/b/c/d']) {
    assert.equal((await app.pedir(rota, { papel: 'admin' })).status, 404, rota);
  }
});

test('o despacho só reivindica o próprio prefixo e sabe quais rotas são lentas', async (t) => {
  const app = await subir();
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/api/agentesx', { papel: 'admin' })).status, 418);
  assert.equal((await app.pedir('/api/serena', { papel: 'admin' })).status, 418);

  const { despacho } = app;
  assert.equal(despacho.ehRotaDeTeste('/api/agentes/5/teste', 'POST'), true);
  assert.equal(despacho.ehRotaDeTeste('/api/agentes/5/teste', 'GET'), false);
  assert.equal(despacho.ehRotaDeTeste('/api/agentes/5', 'POST'), false);
  assert.equal(despacho.ehRotaLenta('/api/agentes/5/treinamentos', 'POST'), true);
  assert.equal(despacho.ehRotaLenta('/api/agentes/5/treinamentos/3', 'DELETE'), false);
  assert.equal(despacho.ehRotaLenta('/api/agentes/5/teste', 'POST'), true);
});
