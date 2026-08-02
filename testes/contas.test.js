'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gerarSegredo, gerarCodigo, conferirCodigo, cifrarSegredo, decifrarSegredo, montarUri } = require('../src/seguranca/totp');
const { criarRemetente, limparCabecalho } = require('../src/seguranca/email');
const { criarClienteGoogle } = require('../src/seguranca/google');
const { semearMaster } = require('../src/seguranca/semear-master');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// Segredo sintético de teste. Não corresponde a nenhum ambiente real.
const SEGREDO_APP = 'segredo-sintetico-de-teste-com-mais-de-32-caracteres';

// ---------------------------------------------------------------- TOTP

test('o código gerado é aceito no mesmo instante', () => {
  const segredo = gerarSegredo();
  const agora = Date.now();

  assert.equal(conferirCodigo(segredo, gerarCodigo(segredo, agora), agora), true);
});

test('o segredo tem tamanho e alfabeto de base32', () => {
  const segredo = gerarSegredo();

  assert.match(segredo, /^[A-Z2-7]+$/);
  assert.ok(segredo.length >= 32, `segredo curto demais: ${segredo.length}`);
  assert.notEqual(gerarSegredo(), segredo, 'cada segredo precisa ser único');
});

test('o código muda a cada passo de 30 segundos', () => {
  const segredo = gerarSegredo();
  const agora = Date.now();

  assert.notEqual(gerarCodigo(segredo, agora), gerarCodigo(segredo, agora + 60_000));
});

test('a tolerância aceita relógio um passo adiantado ou atrasado', () => {
  const segredo = gerarSegredo();
  const agora = Date.now();

  // Celular atrasado: código do passo anterior ainda vale.
  assert.equal(conferirCodigo(segredo, gerarCodigo(segredo, agora - 30_000), agora), true);
  assert.equal(conferirCodigo(segredo, gerarCodigo(segredo, agora + 30_000), agora), true);

  // Dois passos já é diferença demais.
  assert.equal(conferirCodigo(segredo, gerarCodigo(segredo, agora - 90_000), agora), false);
});

test('código errado, vazio ou de outro segredo é recusado', () => {
  const segredo = gerarSegredo();
  const agora = Date.now();

  assert.equal(conferirCodigo(segredo, '000000', agora - 10_000_000), false);
  assert.equal(conferirCodigo(segredo, gerarCodigo(gerarSegredo(), agora), agora), false);
  for (const invalido of ['', '12345', '1234567', null, undefined, 'abcdef']) {
    assert.equal(conferirCodigo(segredo, invalido, agora), false);
  }
  assert.equal(conferirCodigo('', '123456', agora), false);
});

test('o segredo é cifrado em repouso e volta com a chave certa', () => {
  const segredo = gerarSegredo();
  const cifrado = cifrarSegredo(segredo, SEGREDO_APP);

  assert.ok(!cifrado.includes(segredo), 'o segredo não pode aparecer no texto cifrado');
  assert.equal(decifrarSegredo(cifrado, SEGREDO_APP), segredo);

  // Cada cifragem tem IV próprio: dois iguais denunciariam o padrão.
  assert.notEqual(cifrarSegredo(segredo, SEGREDO_APP), cifrado);
});

test('cifra com chave errada ou adulterada não devolve segredo', () => {
  const cifrado = cifrarSegredo(gerarSegredo(), SEGREDO_APP);

  assert.equal(decifrarSegredo(cifrado, 'outra-chave-qualquer-com-tamanho'), null);
  assert.equal(decifrarSegredo(`${cifrado}x`, SEGREDO_APP), null);
  for (const invalido of ['', 'v1.a.b', 'nada', null, undefined]) {
    assert.equal(decifrarSegredo(invalido, SEGREDO_APP), null);
  }
});

test('a URI do autenticador leva emissor, conta e segredo', () => {
  const segredo = gerarSegredo();
  const uri = montarUri(segredo, 'pessoa@exemplo.com');

  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${segredo}`));
  assert.ok(uri.includes('issuer=crmclinica'));
  assert.ok(uri.includes(encodeURIComponent('pessoa@exemplo.com')));
});

// ---------------------------------------------------------------- e-mail

test('sem SMTP configurado, o remetente registra em vez de fingir envio', async () => {
  const registros = [];
  const remetente = criarRemetente({}, { registrar: (linha) => registros.push(linha) });

  assert.equal(remetente.disponivel, false);

  const resultado = await remetente.enviar({ para: 'a@b.c', assunto: 'x', texto: 'y' });
  assert.equal(resultado.enviado, false);
  assert.equal(resultado.via, 'log');
  assert.equal(registros.length, 1);
});

test('falha de envio não derruba o pedido de recuperação', async () => {
  const remetente = criarRemetente(
    { host: 'smtp.invalido', remetente: 'a@b.c' },
    { enviarPorSmtp: async () => { throw new Error('conexão recusada'); }, registrar: () => {} },
  );

  const resultado = await remetente.enviar({ para: 'a@b.c', assunto: 'x', texto: 'y' });
  assert.equal(resultado.enviado, false);
  assert.equal(resultado.motivo, 'falha_no_envio');
});

test('quebra de linha em cabeçalho é neutralizada', () => {
  // Sem isto, um "e-mail" com \n permitiria injetar cabeçalhos e destinatários.
  assert.equal(limparCabecalho('a@b.c\r\nBcc: vitima@x.y'), 'a@b.c Bcc: vitima@x.y');
  assert.equal(limparCabecalho('Assunto\nfalso'), 'Assunto falso');
});

// ---------------------------------------------------------------- Google

test('sem credenciais, o cliente Google se declara indisponível', () => {
  assert.equal(criarClienteGoogle({}).disponivel, false);
  assert.equal(criarClienteGoogle({ clienteId: 'x' }).disponivel, false);
  assert.equal(
    criarClienteGoogle({ clienteId: 'x', clienteSegredo: 'y', redirecionamento: 'https://z' }).disponivel,
    true,
  );
});

test('a URL de autorização leva cliente, escopo e state', () => {
  const cliente = criarClienteGoogle({
    clienteId: 'id-sintetico.apps.googleusercontent.com',
    clienteSegredo: 'segredo-sintetico',
    redirecionamento: 'https://crmclinica.exemplo/api/auth/google/retorno',
  });

  const url = new URL(cliente.montarUrlDeAutorizacao('estado-abc'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'id-sintetico.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('state'), 'estado-abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.ok(url.searchParams.get('scope').includes('openid'));
});

test('sem configuração, montar a URL falha com código próprio', () => {
  const cliente = criarClienteGoogle({});
  assert.throws(() => cliente.montarUrlDeAutorizacao('x'), (erro) => erro.codigo === 'google_nao_configurado');
});

test('id_token malformado ou com algoritmo recusado não passa', async () => {
  const cliente = criarClienteGoogle({
    clienteId: 'id-sintetico', clienteSegredo: 's', redirecionamento: 'https://z',
  }, { fetch: async () => ({ ok: true, json: async () => ({ keys: [] }), headers: { get: () => '' } }) });

  for (const invalido of ['', 'a.b', 'nada', null]) {
    await assert.rejects(() => cliente.verificarIdToken(invalido), (erro) => erro.status === 401);
  }

  // "alg: none" — o ataque clássico contra quem confia no cabeçalho do token.
  const cabecalho = Buffer.from(JSON.stringify({ alg: 'none', kid: 'x' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: '1', aud: 'id-sintetico' })).toString('base64url');
  await assert.rejects(
    () => cliente.verificarIdToken(`${cabecalho}.${payload}.`),
    /algoritmo/,
  );
});

test('id_token de outra aplicação é recusado mesmo com assinatura boa', async () => {
  const crypto = require('node:crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });

  const cliente = criarClienteGoogle(
    { clienteId: 'a-aplicacao-certa', clienteSegredo: 's', redirecionamento: 'https://z' },
    {
      fetch: async () => ({
        ok: true,
        headers: { get: () => 'max-age=3600' },
        json: async () => ({ keys: [{ ...jwk, kid: 'chave-de-teste', alg: 'RS256' }] }),
      }),
    },
  );

  function assinarComo(conteudo) {
    const cabecalho = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'chave-de-teste' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(conteudo)).toString('base64url');
    const assinatura = crypto.sign('RSA-SHA256', Buffer.from(`${cabecalho}.${payload}`), privateKey);
    return `${cabecalho}.${payload}.${assinatura.toString('base64url')}`;
  }

  const daqui = Math.floor(Date.now() / 1000) + 600;

  // Token válido para a nossa aplicação: passa.
  const bom = assinarComo({
    sub: '1', aud: 'a-aplicacao-certa', iss: 'https://accounts.google.com', exp: daqui,
    email: 'pessoa@exemplo.com', email_verified: true, name: 'Pessoa',
  });
  assert.equal((await cliente.verificarIdToken(bom)).sub, '1');

  // Mesma assinatura boa, mas emitido para outro site: recusado.
  await assert.rejects(
    () => cliente.verificarIdToken(assinarComo({
      sub: '1', aud: 'outra-aplicacao', iss: 'https://accounts.google.com', exp: daqui,
    })),
    /outra aplicação/,
  );

  // Emissor errado.
  await assert.rejects(
    () => cliente.verificarIdToken(assinarComo({
      sub: '1', aud: 'a-aplicacao-certa', iss: 'https://malicioso.exemplo', exp: daqui,
    })),
    /emissor/,
  );

  // Expirado.
  await assert.rejects(
    () => cliente.verificarIdToken(assinarComo({
      sub: '1', aud: 'a-aplicacao-certa', iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) - 10,
    })),
    /expirado/,
  );

  // E-mail não verificado não identifica ninguém.
  await assert.rejects(
    () => cliente.verificarIdToken(assinarComo({
      sub: '1', aud: 'a-aplicacao-certa', iss: 'https://accounts.google.com', exp: daqui,
      email: 'pessoa@exemplo.com', email_verified: false,
    })),
    /não verificado/,
  );
});

// ---------------------------------------------------------------- admin master

test('o master é criado com troca de senha obrigatória', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const resultado = await semearMaster(repositorio, {
    email: 'master@teste.local', senhaInicial: 'senha-de-teste-123', nome: 'Master',
  });

  assert.equal(resultado.criado, true);

  const master = await repositorio.obterUsuarioPorId(resultado.id);
  assert.equal(master.master, true);
  assert.equal(master.papel, 'admin');
  assert.equal(master.situacao, 'ativo');
  assert.equal(master.precisa_trocar_senha, true, 'senha vinda de configuração é provisória');
});

test('semear de novo não sobrescreve a senha de quem já trocou', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const dados = { email: 'master@teste.local', senhaInicial: 'senha-de-teste-123', nome: 'Master' };

  const primeiro = await semearMaster(repositorio, dados);
  await repositorio.atualizarUsuario(primeiro.id, {
    senhaHash: 'scrypt$16384$8$1$aa$trocada', precisaTrocarSenha: false,
  });

  const segundo = await semearMaster(repositorio, dados);
  assert.equal(segundo.criado, false);

  const usuario = await repositorio.obterUsuarioPorEmail('master@teste.local');
  assert.equal(usuario.senha_hash, 'scrypt$16384$8$1$aa$trocada', 'a senha trocada precisa sobreviver');
});

test('conta existente é promovida a master sem mexer na senha', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const criado = await repositorio.criarUsuario({
    nome: 'Já existia', email: 'master@teste.local', senhaHash: 'scrypt$1$1$1$aa$bb', papel: 'atendente',
  });

  const resultado = await semearMaster(repositorio, {
    email: 'master@teste.local', senhaInicial: 'outra-senha-qualquer', nome: 'Master',
  });

  assert.equal(resultado.promovido, true);
  const usuario = await repositorio.obterUsuarioPorEmail('master@teste.local');
  assert.equal(usuario.master, true);
  assert.equal(usuario.papel, 'admin');
  assert.equal(usuario.senha_hash, 'scrypt$1$1$1$aa$bb', 'a senha existente não pode ser trocada');
  assert.equal(usuario.id, criado.id);
});

test('sem e-mail ou senha configurados, nada é criado', async () => {
  const repositorio = criarRepositorioEmMemoria();

  assert.equal((await semearMaster(repositorio, {})).motivo, 'email_do_master_nao_configurado');
  assert.equal(
    (await semearMaster(repositorio, { email: 'a@b.c' })).motivo,
    'senha_do_master_nao_configurada',
  );
  assert.deepEqual(await repositorio.listarUsuarios(), []);
});
