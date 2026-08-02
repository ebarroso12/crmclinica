'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste, SENHA_DE_TESTE } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarLimitador, LIMITES } = require('../src/seguranca/limite');
const { gerarHash } = require('../src/seguranca/senha');

const SENHA_ERRADA = 'senha-errada-de-teste';

/** Sobe o inbox com o limitador ligado e uma conta ativa para testar. */
async function subirComLimite() {
  const repositorio = criarRepositorioEmMemoria();
  const limitador = criarLimitador({ repositorio });

  const app = await subirServidor({
    repositorio,
    limitador,
    configuracao: configuracaoDeTeste(),
    remetente: { disponivel: true, enviar: async () => ({ enviado: true, via: 'teste' }) },
  });

  await repositorio.criarUsuario({
    nome: 'Pessoa',
    email: 'pessoa@teste.local',
    senhaHash: await gerarHash(SENHA_DE_TESTE),
    papel: 'atendente',
    situacao: 'ativo',
  });

  return { app, repositorio, limitador };
}

function entrar(app, corpo) {
  return app.pedirSemAuth('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function postar(app, caminho, corpo) {
  return app.pedirSemAuth(caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- caminho feliz

test('login correto passa e não é afetado pelo limite', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const resposta = await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_DE_TESTE });
    assert.equal(resposta.status, 200, `login ${tentativa + 1} deveria passar`);
  }
});

test('errar e depois acertar limpa o contador da conta', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  // Falha até um passo antes do limite.
  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo - 1; tentativa += 1) {
    assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA })).status, 401);
  }

  assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_DE_TESTE })).status, 200);

  // Quem lembrou da senha não fica de castigo: o contador voltou a zero.
  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo - 1; tentativa += 1) {
    assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA })).status, 401);
  }
  assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_DE_TESTE })).status, 200);
});

// ---------------------------------------------------------------- excesso por conta

test('senha errada em excesso responde 429 com Retry-After', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo; tentativa += 1) {
    assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA })).status, 401);
  }

  const bloqueada = await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  assert.equal(bloqueada.status, 429);

  const espera = Number(bloqueada.headers.get('retry-after'));
  assert.ok(Number.isInteger(espera) && espera > 0, `Retry-After inválido: ${bloqueada.headers.get('retry-after')}`);
  assert.ok(espera <= LIMITES.login.conta.janelaMs / 1000);

  const corpo = await bloqueada.json();
  assert.equal(corpo.tentar_em_segundos, espera);
  assert.ok(!corpo.erro.includes('senha'), 'a mensagem não deve comentar a credencial');
});

test('depois de estourar, nem a senha certa passa até a janela deslizar', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo; tentativa += 1) {
    await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  }

  // O bloqueio vale mesmo com a credencial certa: é o que impede a força bruta
  // de acertar na tentativa seguinte ao limite.
  const comSenhaCerta = await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_DE_TESTE });
  assert.equal(comSenhaCerta.status, 429);
});

test('a conta bloqueada não derruba as outras contas', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  await repositorio.criarUsuario({
    nome: 'Outra', email: 'outra@teste.local',
    senhaHash: await gerarHash(SENHA_DE_TESTE), papel: 'atendente', situacao: 'ativo',
  });

  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo; tentativa += 1) {
    await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  }
  assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA })).status, 429);

  // A recepção inteira não pode parar porque uma conta foi atacada.
  assert.equal((await entrar(app, { email: 'outra@teste.local', senha: SENHA_DE_TESTE })).status, 200);
});

// ---------------------------------------------------------------- excesso por IP

test('varredura de contas do mesmo IP é barrada', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  // Uma tentativa por conta: não estoura o limite por conta, só o do endereço.
  for (let contador = 0; contador < LIMITES.login.ip.maximo; contador += 1) {
    const resposta = await entrar(app, { email: `alvo${contador}@teste.local`, senha: SENHA_ERRADA });
    assert.equal(resposta.status, 401, `tentativa ${contador + 1} deveria ser 401`);
  }

  const bloqueada = await entrar(app, { email: 'maisum@teste.local', senha: SENHA_ERRADA });
  assert.equal(bloqueada.status, 429);
  assert.ok(Number(bloqueada.headers.get('retry-after')) > 0);
});

// ---------------------------------------------------------------- não revelar existência

test('e-mail inexistente é limitado igual — não vira oráculo de existência', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  const respostasExistente = [];
  const respostasInexistente = [];

  for (let tentativa = 0; tentativa <= LIMITES.login.conta.maximo; tentativa += 1) {
    respostasExistente.push((await entrar(app, {
      email: 'pessoa@teste.local', senha: SENHA_ERRADA,
    })).status);
  }
  for (let tentativa = 0; tentativa <= LIMITES.login.conta.maximo; tentativa += 1) {
    respostasInexistente.push((await entrar(app, {
      email: 'ninguem@teste.local', senha: SENHA_ERRADA,
    })).status);
  }

  // Mesma sequência de códigos: 401 até o limite, 429 depois. Se o limite só
  // valesse para conta existente, a diferença entregaria quem tem cadastro.
  assert.deepEqual(respostasInexistente, respostasExistente);
});

test('o corpo do 401 é idêntico para conta existente e inexistente', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  const existente = await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  const inexistente = await entrar(app, { email: 'ninguem@teste.local', senha: SENHA_ERRADA });

  assert.equal(existente.status, 401);
  assert.equal(inexistente.status, 401);
  assert.deepEqual(await inexistente.json(), await existente.json());
});

// ---------------------------------------------------------------- 403 preservado

test('conta pendente continua respondendo 403 com a situação', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  await repositorio.criarUsuario({
    nome: 'Na fila', email: 'fila@teste.local',
    senhaHash: await gerarHash(SENHA_DE_TESTE), papel: 'atendente', situacao: 'pendente',
  });

  const resposta = await entrar(app, { email: 'fila@teste.local', senha: SENHA_DE_TESTE });

  // O limite não pode transformar "espere a liberação" em "tentativas demais":
  // a pessoa precisa saber que o problema não é a senha.
  assert.equal(resposta.status, 403);
  assert.equal((await resposta.json()).situacao, 'pendente');
});

test('acertar a senha de conta pendente não conta como falha', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  await repositorio.criarUsuario({
    nome: 'Na fila', email: 'fila@teste.local',
    senhaHash: await gerarHash(SENHA_DE_TESTE), papel: 'atendente', situacao: 'pendente',
  });

  // Quem está na fila e tenta várias vezes com a senha certa continua vendo 403,
  // não é empurrado para 429 por insistir enquanto espera.
  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo + 2; tentativa += 1) {
    const resposta = await entrar(app, { email: 'fila@teste.local', senha: SENHA_DE_TESTE });
    assert.equal(resposta.status, 403, `tentativa ${tentativa + 1} deveria seguir 403`);
  }
});

// ---------------------------------------------------------------- segundo fator

test('código do segundo fator errado também é limitado', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  const { criarContas } = require('../src/seguranca/contas');
  const contas = criarContas({
    repositorio,
    configuracao: configuracaoDeTeste(),
    remetente: { disponivel: false, enviar: async () => ({}) },
    google: { disponivel: false },
  });

  const usuario = await repositorio.obterUsuarioPorEmail('pessoa@teste.local');
  const { segredo } = await contas.prepararSegundoFator(usuario.id);
  await contas.confirmarSegundoFator(usuario.id, require('../src/seguranca/totp').gerarCodigo(segredo));

  // Sem isto, o segundo fator seria o elo sem limite: só 10^6 combinações,
  // testáveis à vontade por quem já tem a senha.
  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo; tentativa += 1) {
    const resposta = await entrar(app, {
      email: 'pessoa@teste.local', senha: SENHA_DE_TESTE, codigo: '000000',
    });
    assert.equal(resposta.status, 401);
  }

  const bloqueada = await entrar(app, {
    email: 'pessoa@teste.local', senha: SENHA_DE_TESTE, codigo: '000000',
  });
  assert.equal(bloqueada.status, 429);
});

// ---------------------------------------------------------------- recuperação

test('pedido de recuperação em excesso responde 429', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  for (let tentativa = 0; tentativa < LIMITES.recuperacao.conta.maximo; tentativa += 1) {
    assert.equal((await postar(app, '/api/auth/recuperar', { email: 'pessoa@teste.local' })).status, 200);
  }

  const bloqueada = await postar(app, '/api/auth/recuperar', { email: 'pessoa@teste.local' });
  assert.equal(bloqueada.status, 429);
  assert.ok(Number(bloqueada.headers.get('retry-after')) > 0);
});

test('estourar o login não trava a recuperação', async (t) => {
  const { app } = await subirComLimite();
  t.after(() => app.encerrar());

  for (let tentativa = 0; tentativa <= LIMITES.login.conta.maximo; tentativa += 1) {
    await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  }

  // Quem esqueceu a senha e errou várias vezes precisa poder pedir o link.
  assert.equal((await postar(app, '/api/auth/recuperar', { email: 'pessoa@teste.local' })).status, 200);
});

// ---------------------------------------------------------------- auditoria

test('a auditoria registra a recusa sem senha e sem e-mail', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });
  await entrar(app, { email: 'ninguem@teste.local', senha: SENHA_ERRADA });

  const bruto = JSON.stringify(repositorio._auditoria);

  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'login_recusado'));
  assert.ok(!bruto.includes(SENHA_ERRADA), 'senha não pode entrar no registro');
  assert.ok(!bruto.includes('pessoa@teste.local'), 'e-mail não precisa entrar no registro');
  assert.ok(!bruto.includes('ninguem@teste.local'));
});

test('as tentativas guardadas não contêm senha nem e-mail em claro', async (t) => {
  const { app, repositorio } = await subirComLimite();
  t.after(() => app.encerrar());

  await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA });

  const { total } = await repositorio.contarFalhas({
    hashConta: require('../src/seguranca/limite').chaveDaConta('pessoa@teste.local'),
    acao: 'login',
    desde: new Date(0).toISOString(),
  });
  assert.equal(total, 1, 'a tentativa precisa ser encontrável pelo hash da conta');

  // E não pelo e-mail em claro.
  const porEmailEmClaro = await repositorio.contarFalhas({
    hashConta: 'pessoa@teste.local', acao: 'login', desde: new Date(0).toISOString(),
  });
  assert.equal(porEmailEmClaro.total, 0);
});

// ---------------------------------------------------------------- sem limitador

test('sem limitador configurado, o login segue funcionando', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, limitador: null, configuracao: configuracaoDeTeste() });
  t.after(() => app.encerrar());

  await repositorio.criarUsuario({
    nome: 'Pessoa', email: 'pessoa@teste.local',
    senhaHash: await gerarHash(SENHA_DE_TESTE), papel: 'atendente', situacao: 'ativo',
  });

  // Muitas falhas sem limitador: nenhuma vira 429.
  for (let tentativa = 0; tentativa < LIMITES.login.conta.maximo + 3; tentativa += 1) {
    assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_ERRADA })).status, 401);
  }
  assert.equal((await entrar(app, { email: 'pessoa@teste.local', senha: SENHA_DE_TESTE })).status, 200);
});
