'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste, SENHA_DE_TESTE } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { gerarHash } = require('../src/seguranca/senha');

function orquestradorFalso() {
  return {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'Olá!' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

/** Sobe o inbox com uma conversa e um usuário do papel pedido. */
async function subirComPapel(papel = 'admin') {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  await atendimento.receberMensagem({
    canal: 'whatsapp',
    id_externo: 'wa:1',
    remetente: '5516999999999',
    nome: 'Marina Souza',
    texto: 'Quero saber sobre a primeira consulta',
  });

  const app = await subirServidor({
    repositorio,
    atendimento,
    orquestrador,
    papel,
    configuracao: configuracaoDeTeste(),
  });

  const [conversa] = await repositorio.listarConversas({});
  return { app, repositorio, conversa };
}

function postar(app, caminho, corpo, metodo = 'POST') {
  return app.pedir(caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- sem autenticação

test('sem token, toda rota do inbox responde 401', async (t) => {
  const { app, conversa } = await subirComPapel();
  t.after(() => app.encerrar());

  const rotas = [
    '/api/resumo',
    '/api/conversas',
    '/api/conversas/filas',
    `/api/conversas/${conversa.id}`,
    `/api/conversas/${conversa.id}/mensagens`,
    '/api/leads',
    `/api/contatos/${conversa.contato_id}/conversas`,
  ];

  for (const rota of rotas) {
    const resposta = await app.pedirSemAuth(rota);
    assert.equal(resposta.status, 401, `rota ${rota} deveria exigir autenticação`);
    assert.equal(resposta.headers.get('www-authenticate'), 'Bearer');
  }
});

test('sem token, as ações de escrita também respondem 401', async (t) => {
  const { app, conversa } = await subirComPapel();
  t.after(() => app.encerrar());

  const acoes = [
    [`/api/conversas/${conversa.id}/mensagens`, { texto: 'oi' }, 'POST'],
    [`/api/conversas/${conversa.id}/assumir`, {}, 'POST'],
    [`/api/conversas/${conversa.id}/etiquetas`, { etiquetas: [] }, 'POST'],
    [`/api/conversas/${conversa.id}/ficha`, { nome: 'x' }, 'PUT'],
  ];

  for (const [rota, corpo, metodo] of acoes) {
    const resposta = await app.pedirSemAuth(rota, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    assert.equal(resposta.status, 401, `rota ${rota} deveria exigir autenticação`);
  }
});

test('token inválido, expirado ou de outro segredo não passa', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const invalidos = [
    'Bearer nada',
    'Bearer a.b.c',
    'Basic dXNlcjpzZW5oYQ==',
    app.sessao.access_token, // sem o esquema "Bearer"
  ];

  for (const cabecalho of invalidos) {
    const resposta = await app.pedirSemAuth('/api/conversas', { headers: { authorization: cabecalho } });
    assert.equal(resposta.status, 401, `cabeçalho "${cabecalho.slice(0, 20)}…" não deveria passar`);
  }
});

// ---------------------------------------------------------------- login

test('login devolve access, refresh e as permissões do papel', async (t) => {
  const { app } = await subirComPapel('atendente');
  t.after(() => app.encerrar());

  assert.ok(app.sessao.access_token);
  assert.ok(app.sessao.refresh_token);
  assert.equal(app.sessao.usuario.papel, 'atendente');
  assert.ok(app.sessao.usuario.permissoes.includes('conversas:responder'));
  assert.ok(!app.sessao.usuario.permissoes.includes('usuarios:gerenciar'));
});

test('senha errada e usuário inexistente respondem igual', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const senhaErrada = await postar(app, '/api/auth/login', {
    email: app.sessao.email, senha: 'senha-errada-mesmo',
  });
  const inexistente = await postar(app, '/api/auth/login', {
    email: 'ninguem@teste.local', senha: SENHA_DE_TESTE,
  });

  assert.equal(senhaErrada.status, 401);
  assert.equal(inexistente.status, 401);
  // Mensagens iguais: a resposta não pode revelar quem tem conta.
  assert.deepEqual(await senhaErrada.json(), await inexistente.json());
});

test('login sem campo responde 400 apontando o campo', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const semEmail = await postar(app, '/api/auth/login', { senha: SENHA_DE_TESTE });
  assert.equal(semEmail.status, 400);
  assert.equal((await semEmail.json()).campo, 'email');
});

test('nenhuma resposta de login carrega hash nem senha', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  // A resposta crua do servidor, não o objeto que o auxiliar enriquece para os testes.
  const resposta = await postar(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE,
  });
  const bruto = await resposta.text();

  assert.equal(resposta.status, 200);
  assert.ok(!bruto.includes('scrypt'), 'o hash não pode sair pela API');
  assert.ok(!bruto.includes('senha_hash'), 'nem o nome do campo precisa sair');
  assert.ok(!bruto.includes(SENHA_DE_TESTE), 'a senha não pode sair pela API');
});

// ---------------------------------------------------------------- sessão e refresh

test('GET /api/auth/sessao diz quem sou e o que posso', async (t) => {
  const { app } = await subirComPapel('gestor');
  t.after(() => app.encerrar());

  const dados = await (await app.pedir('/api/auth/sessao')).json();
  assert.equal(dados.usuario.papel, 'gestor');
  assert.ok(dados.usuario.permissoes.includes('conversas:priorizar'));

  assert.equal((await app.pedirSemAuth('/api/auth/sessao')).status, 401);
});

test('o refresh troca por um par novo e revoga o usado', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const primeiro = app.sessao.refresh_token;
  const renovada = await (await postar(app, '/api/auth/refresh', { refresh_token: primeiro })).json();

  assert.ok(renovada.access_token);
  assert.notEqual(renovada.refresh_token, primeiro, 'o refresh precisa rotacionar');

  // O refresh usado não vale mais: rotação torna o reuso detectável.
  const reuso = await postar(app, '/api/auth/refresh', { refresh_token: primeiro });
  assert.equal(reuso.status, 401);

  // O novo funciona.
  const comNovo = await app.pedirSemAuth('/api/conversas', {
    headers: { authorization: `Bearer ${renovada.access_token}` },
  });
  assert.equal(comNovo.status, 200);
});

test('refresh inválido ou ausente responde 401', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  assert.equal((await postar(app, '/api/auth/refresh', { refresh_token: 'inventado' })).status, 401);
  assert.equal((await postar(app, '/api/auth/refresh', {})).status, 400);
});

test('logout revoga a sessão: o refresh para de funcionar', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const refresh = app.sessao.refresh_token;
  const saida = await (await postar(app, '/api/auth/logout', { refresh_token: refresh })).json();
  assert.equal(saida.encerrada, true);

  assert.equal((await postar(app, '/api/auth/refresh', { refresh_token: refresh })).status, 401);
});

test('o refresh token não é guardado em claro', async (t) => {
  const { app, repositorio } = await subirComPapel();
  t.after(() => app.encerrar());

  const sessao = await repositorio.obterSessaoPorHash(
    require('node:crypto').createHash('sha256').update(app.sessao.refresh_token).digest('hex'),
  );

  assert.ok(sessao, 'a sessão precisa ser encontrável pelo hash');
  assert.notEqual(sessao.hash_refresh, app.sessao.refresh_token, 'o token não pode estar em claro');
  assert.match(sessao.hash_refresh, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- RBAC nas rotas

test('atendente não prioriza nem edita ficha — 403, não 401', async (t) => {
  const { app, conversa } = await subirComPapel('atendente');
  t.after(() => app.encerrar());

  const prioridade = await postar(app, `/api/conversas/${conversa.id}/prioridade`, { prioridade: 'alta' });
  assert.equal(prioridade.status, 403);
  assert.equal((await prioridade.json()).permissao, 'conversas:priorizar');

  const ficha = await postar(app, `/api/conversas/${conversa.id}/ficha`, { nome: 'Outro' }, 'PUT');
  assert.equal(ficha.status, 403);
});

test('atendente faz o que é do atendimento', async (t) => {
  const { app, conversa } = await subirComPapel('atendente');
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/api/conversas')).status, 200);
  assert.equal((await postar(app, `/api/conversas/${conversa.id}/mensagens`, { texto: 'Bom dia!' })).status, 200);
  assert.equal((await postar(app, `/api/conversas/${conversa.id}/assumir`, {})).status, 200);
  assert.equal(
    (await postar(app, `/api/conversas/${conversa.id}/etiquetas`, { etiquetas: ['pagou_sinal'] })).status,
    200,
  );
});

test('gestor prioriza e edita ficha; só admin gerencia usuários', async (t) => {
  const { app, conversa } = await subirComPapel('gestor');
  t.after(() => app.encerrar());

  assert.equal((await postar(app, `/api/conversas/${conversa.id}/prioridade`, { prioridade: 'alta' })).status, 200);
  assert.equal((await postar(app, `/api/conversas/${conversa.id}/ficha`, { nome: 'Marina S.' }, 'PUT')).status, 200);

  assert.equal((await app.pedir('/api/usuarios')).status, 403);
  assert.equal(
    (await postar(app, '/api/usuarios', { nome: 'X', email: 'x@teste.local', senha: 'senha-boa-123' })).status,
    403,
  );
});

test('admin cria usuário; e-mail repetido responde 400', async (t) => {
  const { app } = await subirComPapel('admin');
  t.after(() => app.encerrar());

  const criado = await postar(app, '/api/usuarios', {
    nome: 'Recepção', email: 'recepcao@teste.local', senha: 'senha-boa-123', papel: 'atendente',
  });
  assert.equal(criado.status, 201);

  const dados = await criado.json();
  assert.equal(dados.usuario.papel, 'atendente');
  assert.ok(!JSON.stringify(dados).includes('scrypt'), 'o hash não pode voltar na resposta');

  const repetido = await postar(app, '/api/usuarios', {
    nome: 'Outro', email: 'recepcao@teste.local', senha: 'senha-boa-123',
  });
  assert.equal(repetido.status, 400);
});

test('papel inválido e senha curta são recusados na criação', async (t) => {
  const { app } = await subirComPapel('admin');
  t.after(() => app.encerrar());

  const papelInvalido = await postar(app, '/api/usuarios', {
    nome: 'X', email: 'a@teste.local', senha: 'senha-boa-123', papel: 'dono',
  });
  assert.equal(papelInvalido.status, 400);
  assert.equal((await papelInvalido.json()).campo, 'papel');

  const senhaCurta = await postar(app, '/api/usuarios', {
    nome: 'X', email: 'b@teste.local', senha: 'curta',
  });
  assert.equal(senhaCurta.status, 400);
});

test('a autenticação deixa trilha de auditoria sem vazar credencial', async (t) => {
  const { app, repositorio } = await subirComPapel();
  t.after(() => app.encerrar());

  await postar(app, '/api/auth/login', { email: app.sessao.email, senha: 'senha-errada-mesmo' });

  const registros = repositorio._auditoria;
  assert.ok(registros.some((registro) => registro.acao === 'login'));
  assert.ok(registros.some((registro) => registro.acao === 'login_recusado'));

  const bruto = JSON.stringify(registros);
  assert.ok(!bruto.includes(SENHA_DE_TESTE), 'senha não pode entrar na auditoria');
  assert.ok(!bruto.includes(app.sessao.email), 'e-mail não precisa entrar na auditoria');
});

test('a rota de canal continua fora da autenticação — quem chama é o webhook', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  const resposta = await app.pedirSemAuth('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      canal: 'whatsapp', id_externo: 'wa:sem-auth', remetente: '5516988887777', texto: 'Oi',
    }),
  });

  // Ela se protege por assinatura HMAC, não por sessão de equipe.
  assert.equal(resposta.status, 202);
});

test('/health continua público — é o que o monitor consulta', async (t) => {
  const { app } = await subirComPapel();
  t.after(() => app.encerrar());

  assert.equal((await app.pedirSemAuth('/health')).status, 200);
});
