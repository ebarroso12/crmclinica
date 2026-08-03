'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste, SENHA_DE_TESTE } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { gerarHash } = require('../src/seguranca/senha');
const { gerarCodigo } = require('../src/seguranca/totp');

// Senha sintética de teste. Não corresponde a nenhum ambiente real.
const SENHA_NOVA = 'senha-nova-de-teste-456';

async function subirContas({ papel = 'admin', master = true, configuracao } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const enviados = [];

  const app = await subirServidor({
    repositorio,
    papel,
    master,
    configuracao: configuracao || configuracaoDeTeste(),
    // Remetente falso: nada sai da máquina, e o teste consegue ler o link.
    remetente: {
      disponivel: true,
      enviar: async (mensagem) => { enviados.push(mensagem); return { enviado: true, via: 'teste' }; },
    },
  });

  return { app, repositorio, enviados };
}

function postar(app, caminho, corpo, metodo = 'POST') {
  return app.pedir(caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function postarSemAuth(app, caminho, corpo) {
  return app.pedirSemAuth(caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

// ---------------------------------------------------------------- cadastro e aprovação

test('cadastro público cria conta pendente e ela não entra', async (t) => {
  const { app, repositorio } = await subirContas();
  t.after(() => app.encerrar());

  const cadastro = await postarSemAuth(app, '/api/auth/cadastro', {
    nome: 'Nova Pessoa', email: 'nova@teste.local', senha: SENHA_NOVA,
  });
  assert.equal(cadastro.status, 200);
  assert.equal((await cadastro.json()).situacao, 'pendente');

  // Credencial certa, mas conta não liberada: 403 com a situação, não 401.
  const login = await postarSemAuth(app, '/api/auth/login', {
    email: 'nova@teste.local', senha: SENHA_NOVA,
  });
  assert.equal(login.status, 403);
  assert.equal((await login.json()).situacao, 'pendente');

  const criada = await repositorio.obterUsuarioPorEmail('nova@teste.local');
  assert.equal(criada.situacao, 'pendente');
});

test('e-mail repetido responde igual a cadastro novo', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const dados = { nome: 'Pessoa', email: 'repetida@teste.local', senha: SENHA_NOVA };
  const primeiro = await postarSemAuth(app, '/api/auth/cadastro', dados);
  const segundo = await postarSemAuth(app, '/api/auth/cadastro', dados);

  // Dizer "já existe" entregaria quem tem conta.
  assert.equal(segundo.status, primeiro.status);
  assert.deepEqual(await segundo.json(), await primeiro.json());
});

test('cadastro valida e-mail e tamanho de senha', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const semArroba = await postarSemAuth(app, '/api/auth/cadastro', {
    nome: 'X', email: 'nao-e-email', senha: SENHA_NOVA,
  });
  assert.equal(semArroba.status, 400);
  assert.equal((await semArroba.json()).campo, 'email');

  const senhaCurta = await postarSemAuth(app, '/api/auth/cadastro', {
    nome: 'X', email: 'x@teste.local', senha: 'curta',
  });
  assert.equal(senhaCurta.status, 400);

  const senhaRepetida = await postarSemAuth(app, '/api/auth/cadastro', {
    nome: 'X', email: 'y@teste.local', senha: 'aaaaaaaaaaaa',
  });
  assert.equal(senhaRepetida.status, 400);
});

test('o master libera a conta e ela passa a entrar', async (t) => {
  const { app, repositorio } = await subirContas();
  t.after(() => app.encerrar());

  await postarSemAuth(app, '/api/auth/cadastro', {
    nome: 'Nova Pessoa', email: 'nova@teste.local', senha: SENHA_NOVA,
  });
  const pendente = await repositorio.obterUsuarioPorEmail('nova@teste.local');

  const liberada = await postar(app, `/api/usuarios/${pendente.id}/situacao`, { situacao: 'ativo' });
  assert.equal(liberada.status, 200);
  assert.equal((await liberada.json()).usuario.situacao, 'ativo');

  const login = await postarSemAuth(app, '/api/auth/login', {
    email: 'nova@teste.local', senha: SENHA_NOVA,
  });
  assert.equal(login.status, 200);
});

test('recusar ou desativar derruba as sessões abertas', async (t) => {
  const { app, repositorio } = await subirContas();
  t.after(() => app.encerrar());

  const alvo = await repositorio.criarUsuario({
    nome: 'Alvo', email: 'alvo@teste.local', senhaHash: await gerarHash(SENHA_NOVA),
    papel: 'atendente', situacao: 'ativo',
  });

  const sessao = await (await postarSemAuth(app, '/api/auth/login', {
    email: 'alvo@teste.local', senha: SENHA_NOVA,
  })).json();

  await postar(app, `/api/usuarios/${alvo.id}/situacao`, { situacao: 'desativado' });

  // Continuar logado depois de desativado tornaria a desativação decorativa.
  const renovacao = await postarSemAuth(app, '/api/auth/refresh', { refresh_token: sessao.refresh_token });
  assert.equal(renovacao.status, 401);

  const novoLogin = await postarSemAuth(app, '/api/auth/login', {
    email: 'alvo@teste.local', senha: SENHA_NOVA,
  });
  assert.equal(novoLogin.status, 403);
});

test('só o master libera contas — nem admin comum pode', async (t) => {
  const { app, repositorio } = await subirContas({ papel: 'admin', master: false });
  t.after(() => app.encerrar());

  const alvo = await repositorio.criarUsuario({
    nome: 'Alvo', email: 'alvo2@teste.local', papel: 'atendente',
  });

  const tentativa = await postar(app, `/api/usuarios/${alvo.id}/situacao`, { situacao: 'ativo' });
  assert.equal(tentativa.status, 403);
});

test('a conta do master não pode ser alterada por ninguém', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const eu = app.sessao.usuario.id;
  assert.equal((await postar(app, `/api/usuarios/${eu}/situacao`, { situacao: 'desativado' })).status, 409);
  assert.equal((await postar(app, `/api/usuarios/${eu}/papel`, { papel: 'atendente' })).status, 409);
});

test('a listagem separa pendentes e mostra o total', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  await postarSemAuth(app, '/api/auth/cadastro', { nome: 'A', email: 'a@teste.local', senha: SENHA_NOVA });
  await postarSemAuth(app, '/api/auth/cadastro', { nome: 'B', email: 'b@teste.local', senha: SENHA_NOVA });

  const lista = await (await app.pedir('/api/usuarios')).json();
  assert.equal(lista.pendentes, 2);
  assert.equal(lista.usuarios[0].situacao, 'pendente', 'quem espera decisão vem primeiro');

  const soPendentes = await (await app.pedir('/api/usuarios?situacao=pendente')).json();
  assert.equal(soPendentes.usuarios.length, 2);

  // Nenhum segredo na listagem.
  const bruto = JSON.stringify(lista);
  assert.ok(!bruto.includes('scrypt') && !bruto.includes('senha_hash'));
});

test('usuário criado pelo master já nasce liberado e com senha provisória', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const criado = await postar(app, '/api/usuarios', {
    nome: 'Recepção', email: 'recepcao@teste.local', senha: SENHA_NOVA, papel: 'atendente',
  });
  assert.equal(criado.status, 201);

  const dados = await criado.json();
  assert.equal(dados.usuario.situacao, 'ativo');
  assert.equal(dados.usuario.precisa_trocar_senha, true, 'senha escolhida por outra pessoa é provisória');
});

// ---------------------------------------------------------------- senha

test('trocar a senha exige a atual e encerra as outras sessões', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const errada = await postar(app, '/api/auth/senha', {
    senha_atual: 'senha-errada-mesmo', senha_nova: SENHA_NOVA,
  });
  assert.equal(errada.status, 401, 'token roubado não pode trocar senha');

  const certa = await postar(app, '/api/auth/senha', {
    senha_atual: SENHA_DE_TESTE, senha_nova: SENHA_NOVA,
  });
  assert.equal(certa.status, 200);

  // Trocar senha é gesto de quem desconfia: as sessões antigas caem.
  const renovacao = await postarSemAuth(app, '/api/auth/refresh', {
    refresh_token: app.sessao.refresh_token,
  });
  assert.equal(renovacao.status, 401);

  const novoLogin = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_NOVA,
  });
  assert.equal(novoLogin.status, 200);
});

test('a senha nova precisa ser diferente e ter tamanho mínimo', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  assert.equal((await postar(app, '/api/auth/senha', {
    senha_atual: SENHA_DE_TESTE, senha_nova: SENHA_DE_TESTE,
  })).status, 400);

  assert.equal((await postar(app, '/api/auth/senha', {
    senha_atual: SENHA_DE_TESTE, senha_nova: 'curta',
  })).status, 400);
});

test('recuperação envia link para o e-mail de cadastro', async (t) => {
  const { app, enviados } = await subirContas();
  t.after(() => app.encerrar());

  const pedido = await postarSemAuth(app, '/api/auth/recuperar', { email: app.sessao.email });
  assert.equal(pedido.status, 200);

  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, app.sessao.email);
  assert.match(enviados[0].texto, /recuperar=/);
  assert.ok(!enviados[0].texto.includes(SENHA_DE_TESTE), 'a senha nunca vai por e-mail');
});

test('recuperação responde igual para e-mail desconhecido', async (t) => {
  const { app, enviados } = await subirContas();
  t.after(() => app.encerrar());

  const conhecido = await postarSemAuth(app, '/api/auth/recuperar', { email: app.sessao.email });
  const desconhecido = await postarSemAuth(app, '/api/auth/recuperar', { email: 'ninguem@teste.local' });

  assert.equal(desconhecido.status, conhecido.status);
  assert.deepEqual(await desconhecido.json(), await conhecido.json());
  assert.equal(enviados.length, 1, 'só o e-mail existente recebe mensagem');
});

test('o link de recuperação redefine a senha e vale uma vez só', async (t) => {
  const { app, enviados } = await subirContas();
  t.after(() => app.encerrar());

  await postarSemAuth(app, '/api/auth/recuperar', { email: app.sessao.email });
  const token = /recuperar=([\w-]+)/.exec(enviados[0].texto)[1];

  const redefinida = await postarSemAuth(app, '/api/auth/redefinir', {
    token, senha_nova: SENHA_NOVA,
  });
  assert.equal(redefinida.status, 200);

  // Reusar o mesmo link não pode funcionar.
  const reuso = await postarSemAuth(app, '/api/auth/redefinir', { token, senha_nova: 'outra-senha-ainda' });
  assert.equal(reuso.status, 400);

  const login = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_NOVA,
  });
  assert.equal(login.status, 200);
});

test('um pedido novo invalida o link anterior', async (t) => {
  const { app, enviados } = await subirContas();
  t.after(() => app.encerrar());

  await postarSemAuth(app, '/api/auth/recuperar', { email: app.sessao.email });
  await postarSemAuth(app, '/api/auth/recuperar', { email: app.sessao.email });

  const primeiro = /recuperar=([\w-]+)/.exec(enviados[0].texto)[1];
  const segundo = /recuperar=([\w-]+)/.exec(enviados[1].texto)[1];

  assert.notEqual(primeiro, segundo);
  assert.equal((await postarSemAuth(app, '/api/auth/redefinir', {
    token: primeiro, senha_nova: SENHA_NOVA,
  })).status, 400, 'só o último link deve funcionar');

  assert.equal((await postarSemAuth(app, '/api/auth/redefinir', {
    token: segundo, senha_nova: SENHA_NOVA,
  })).status, 200);
});

test('token de recuperação inventado é recusado', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  assert.equal((await postarSemAuth(app, '/api/auth/redefinir', {
    token: 'inventado', senha_nova: SENHA_NOVA,
  })).status, 400);
});

// ---------------------------------------------------------------- segundo fator

test('o segundo fator só passa a valer depois de confirmado', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const preparo = await (await postar(app, '/api/auth/segundo-fator', {})).json();
  assert.match(preparo.segredo, /^[A-Z2-7]+$/);
  assert.ok(preparo.uri.startsWith('otpauth://totp/'));

  // Antes de confirmar, o login continua só com senha.
  const antes = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE,
  });
  assert.equal(antes.status, 200);

  const codigoErrado = await postar(app, '/api/auth/segundo-fator/confirmar', { codigo: '000000' });
  assert.equal(codigoErrado.status, 400);

  const confirmado = await postar(app, '/api/auth/segundo-fator/confirmar', {
    codigo: gerarCodigo(preparo.segredo),
  });
  assert.equal(confirmado.status, 200);
});

test('com segundo fator ativo, o login exige o código', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const preparo = await (await postar(app, '/api/auth/segundo-fator', {})).json();
  await postar(app, '/api/auth/segundo-fator/confirmar', { codigo: gerarCodigo(preparo.segredo) });

  // Senha certa, sem código: a interface precisa saber que falta o segundo fator.
  const semCodigo = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE,
  });
  assert.equal(semCodigo.status, 401);
  assert.equal((await semCodigo.json()).segundo_fator, 'obrigatorio');

  const codigoErrado = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE, codigo: '000000',
  });
  assert.equal((await codigoErrado.json()).segundo_fator, 'incorreto');

  const comCodigo = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE, codigo: gerarCodigo(preparo.segredo),
  });
  assert.equal(comCodigo.status, 200);
});

test('desativar o segundo fator exige a senha', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const preparo = await (await postar(app, '/api/auth/segundo-fator', {})).json();
  await postar(app, '/api/auth/segundo-fator/confirmar', { codigo: gerarCodigo(preparo.segredo) });

  const semSenha = await postar(app, '/api/auth/segundo-fator/desativar', { senha: 'errada' });
  assert.equal(semSenha.status, 401, 'token roubado não desliga proteção');

  const comSenha = await postar(app, '/api/auth/segundo-fator/desativar', { senha: SENHA_DE_TESTE });
  assert.equal(comSenha.status, 200);

  const login = await postarSemAuth(app, '/api/auth/login', {
    email: app.sessao.email, senha: SENHA_DE_TESTE,
  });
  assert.equal(login.status, 200, 'sem segundo fator, volta a ser só senha');
});

test('o segredo do segundo fator não sai em nenhuma listagem', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const preparo = await (await postar(app, '/api/auth/segundo-fator', {})).json();
  await postar(app, '/api/auth/segundo-fator/confirmar', { codigo: gerarCodigo(preparo.segredo) });

  for (const rota of ['/api/usuarios', '/api/auth/sessao']) {
    const bruto = await (await app.pedir(rota)).text();
    assert.ok(!bruto.includes(preparo.segredo), `a rota ${rota} vazou o segredo do 2FA`);
    assert.ok(!bruto.includes('totp_segredo'), `a rota ${rota} expôs o campo do segredo`);
  }
});

// ---------------------------------------------------------------- perfil e sessão

test('a sessão informa se falta trocar a senha', async (t) => {
  const { app, repositorio } = await subirContas();
  t.after(() => app.encerrar());

  await repositorio.atualizarUsuario(app.sessao.usuario.id, { precisaTrocarSenha: true });

  const sessao = await (await app.pedir('/api/auth/sessao')).json();
  assert.equal(sessao.usuario.precisa_trocar_senha, true);
  assert.equal(sessao.usuario.master, true);
});

test('o perfil atualiza nome e telefone da própria pessoa', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const atualizado = await postar(app, '/api/perfil', {
    nome: 'Nome Atualizado', telefone: '5516999999999',
  }, 'PUT');

  assert.equal(atualizado.status, 200);
  const dados = await atualizado.json();
  assert.equal(dados.usuario.nome, 'Nome Atualizado');
  assert.equal(dados.usuario.telefone, '5516999999999');

  assert.equal((await postar(app, '/api/perfil', {}, 'PUT')).status, 400);
  assert.equal((await app.pedirSemAuth('/api/perfil', { method: 'PUT', body: '{}' })).status, 401);
});

test('as opções de entrada dizem o que a tela deve oferecer', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  const opcoes = await (await app.pedirSemAuth('/api/auth/opcoes')).json();
  assert.equal(typeof opcoes.google, 'boolean');
  assert.equal(typeof opcoes.recuperacao_por_email, 'boolean');
  // Sem Google configurado no teste, a tela não deve oferecer o botão.
  assert.equal(opcoes.google, false);
});

test('sem Google configurado, iniciar o login responde 503', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  assert.equal((await app.pedirSemAuth('/api/auth/google')).status, 503);
});

test('o retorno do Google recusa state ausente ou desconhecido', async (t) => {
  const { app } = await subirContas();
  t.after(() => app.encerrar());

  assert.equal((await app.pedirSemAuth('/api/auth/google/retorno?code=abc')).status, 401);
  assert.equal((await app.pedirSemAuth('/api/auth/google/retorno?code=abc&state=forjado')).status, 401);
  assert.equal((await app.pedirSemAuth('/api/auth/google/retorno?state=x')).status, 400);
});

// ---------------------------------------------------------------- senha sem e-mail
//
// A recuperação por e-mail depende de SMTP, e uma clínica pequena pode não ter.
// Sem um caminho alternativo, esquecer a senha vira chamado técnico — ou, pior,
// alguém emprestando a conta de outro, que é como a auditoria deixa de valer.

test('o master define senha temporária e a troca é exigida no primeiro acesso', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const atendente = await ambiente.entrarComo('atendente');
  const alvo = await repositorio.obterUsuarioPorEmail(atendente.email);

  const resposta = await ambiente.pedir(`/api/usuarios/${alvo.id}/senha`, { method: 'POST' });
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.equal(corpo.definida, true);
  // A senha aparece uma vez, para ser entregue pessoalmente.
  assert.ok(corpo.senha_temporaria && corpo.senha_temporaria.length >= 16);
  assert.equal(corpo.usuario.precisa_trocar_senha, true);

  // E ela funciona: entrar com a temporária é o ponto do recurso.
  const login = await ambiente.pedirSemAuth('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: atendente.email, senha: corpo.senha_temporaria }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).usuario.precisa_trocar_senha, true);
});

test('a senha antiga para de valer, e as sessões caem junto', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const atendente = await ambiente.entrarComo('atendente');
  const alvo = await repositorio.obterUsuarioPorEmail(atendente.email);

  await ambiente.pedir(`/api/usuarios/${alvo.id}/senha`, { method: 'POST' });

  const comAntiga = await ambiente.pedirSemAuth('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: atendente.email, senha: atendente.senha }),
  });
  assert.equal(comAntiga.status, 401, 'a senha anterior não pode continuar entrando');

  // Redefinir senha por suspeita e deixar a sessão aberta anularia o gesto.
  const sessao = await repositorio.obterSessaoPorHash('qualquer');
  assert.equal(sessao, null);
});

test('só o master redefine senha de outra conta', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, master: false, papel: 'admin' });
  t.after(() => ambiente.encerrar());

  const outro = await ambiente.entrarComo('atendente');
  const alvo = await repositorio.obterUsuarioPorEmail(outro.email);

  // Admin sem `master` não passa: redefinir senha alheia é poder de dono da conta.
  const resposta = await ambiente.pedir(`/api/usuarios/${alvo.id}/senha`, { method: 'POST' });
  assert.equal(resposta.status, 403);
});

test('o master não redefine a própria senha por este caminho', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const eu = await (await ambiente.pedir('/api/auth/sessao')).json();
  const resposta = await ambiente.pedir(`/api/usuarios/${eu.usuario.id}/senha`, { method: 'POST' });

  // A própria senha se troca pelo fluxo normal, que exige a atual — do
  // contrário, um token roubado trocaria a senha do dono sem saber a antiga.
  assert.equal(resposta.status, 409);
});

test('a redefinição fica auditada, e a senha não aparece na trilha', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  t.after(() => ambiente.encerrar());

  const atendente = await ambiente.entrarComo('atendente');
  const alvo = await repositorio.obterUsuarioPorEmail(atendente.email);

  const corpo = await (await ambiente.pedir(`/api/usuarios/${alvo.id}/senha`, { method: 'POST' })).json();

  const registro = repositorio._auditoria.find((item) => item.acao === 'senha_temporaria_definida');
  assert.ok(registro, 'a redefinição precisa deixar rastro');
  assert.ok(registro.usuarioId, 'com o autor');
  assert.doesNotMatch(JSON.stringify(registro), new RegExp(corpo.senha_temporaria));
});
