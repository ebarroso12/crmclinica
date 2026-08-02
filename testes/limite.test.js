'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarLimitador, chaveDaConta, ErroDeLimite, LIMITES } = require('../src/seguranca/limite');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

/** Relógio controlado: janela deslizante não se testa esperando 15 minutos. */
function montar() {
  let instante = new Date('2026-08-02T10:00:00.000Z');
  const repositorio = criarRepositorioEmMemoria({ agora: () => instante });
  const limitador = criarLimitador({ repositorio, agora: () => instante });

  return {
    repositorio,
    limitador,
    avancar: (segundos) => { instante = new Date(instante.getTime() + segundos * 1000); },
    agora: () => instante,
  };
}

async function falhar(limitador, vezes, dados) {
  for (let contador = 0; contador < vezes; contador += 1) {
    await limitador.registrar({ ...dados, sucesso: false });
  }
}

// ---------------------------------------------------------------- chave da conta

test('a chave da conta normaliza caixa e espaços', () => {
  const referencia = chaveDaConta('Pessoa@Exemplo.COM');

  assert.equal(chaveDaConta('pessoa@exemplo.com'), referencia);
  assert.equal(chaveDaConta('  PESSOA@exemplo.com  '), referencia);
  assert.notEqual(chaveDaConta('outra@exemplo.com'), referencia);
});

test('a chave é um hash, não o e-mail', () => {
  const chave = chaveDaConta('pessoa@exemplo.com');

  assert.match(chave, /^[0-9a-f]{64}$/);
  assert.ok(!chave.includes('pessoa'), 'a tabela não pode virar uma lista de quem tem conta');
  assert.equal(chaveDaConta(''), null);
  assert.equal(chaveDaConta(null), null);
});

// ---------------------------------------------------------------- limite por conta

test('abaixo do limite, a conta passa', async () => {
  const { limitador } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };

  await falhar(limitador, LIMITES.login.conta.maximo - 1, dados);
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite(dados));
});

test('no limite, a conta é barrada com 429 e tempo de espera', async () => {
  const { limitador } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };

  await falhar(limitador, LIMITES.login.conta.maximo, dados);

  await assert.rejects(
    () => limitador.exigirDentroDoLimite(dados),
    (erro) => {
      assert.ok(erro instanceof ErroDeLimite);
      assert.equal(erro.status, 429);
      assert.equal(erro.escopo, 'conta');
      assert.ok(erro.retryAfter > 0 && erro.retryAfter <= LIMITES.login.conta.janelaMs / 1000);
      return true;
    },
  );
});

test('o limite da conta segue a pessoa, não o endereço', async () => {
  const { limitador } = montar();
  const email = 'pessoa@exemplo.com';

  // Trocar de IP a cada tentativa não deve contornar o limite da conta.
  for (let contador = 0; contador < LIMITES.login.conta.maximo; contador += 1) {
    await limitador.registrar({ ip: `10.0.0.${contador}`, email, acao: 'login', sucesso: false });
  }

  await assert.rejects(
    () => limitador.exigirDentroDoLimite({ ip: '10.0.0.200', email, acao: 'login' }),
    (erro) => erro.escopo === 'conta',
  );
});

test('outra conta no mesmo IP continua entrando', async () => {
  const { limitador } = montar();

  await falhar(limitador, LIMITES.login.conta.maximo, {
    ip: '10.0.0.1', email: 'travada@exemplo.com', acao: 'login',
  });

  // O bloqueio é da conta travada, não da recepção inteira.
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite({
    ip: '10.0.0.1', email: 'outra@exemplo.com', acao: 'login',
  }));
});

// ---------------------------------------------------------------- limite por IP

test('no limite, o IP é barrado mesmo variando as contas', async () => {
  const { limitador } = montar();
  const ip = '10.0.0.99';

  // Varredura: uma tentativa em cada conta, para não estourar o limite por conta.
  for (let contador = 0; contador < LIMITES.login.ip.maximo; contador += 1) {
    await limitador.registrar({ ip, email: `pessoa${contador}@exemplo.com`, acao: 'login', sucesso: false });
  }

  await assert.rejects(
    () => limitador.exigirDentroDoLimite({ ip, email: 'maisuma@exemplo.com', acao: 'login' }),
    (erro) => erro.escopo === 'ip' && erro.status === 429,
  );

  // Outro endereço não é afetado.
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite({
    ip: '10.0.0.100', email: 'maisuma@exemplo.com', acao: 'login',
  }));
});

// ---------------------------------------------------------------- janela deslizante

test('a janela desliza: tentativa velha deixa de contar', async () => {
  const { limitador, avancar } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };
  const janelaSegundos = LIMITES.login.conta.janelaMs / 1000;

  await falhar(limitador, LIMITES.login.conta.maximo, dados);
  await assert.rejects(() => limitador.exigirDentroDoLimite(dados));

  // Um segundo antes de a mais antiga sair, ainda está barrado.
  avancar(janelaSegundos - 1);
  await assert.rejects(() => limitador.exigirDentroDoLimite(dados));

  // Passada a janela, tudo saiu e a conta volta a poder tentar.
  avancar(2);
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite(dados));
});

test('o tempo de espera diminui conforme a janela avança', async () => {
  const { limitador, avancar } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };

  await falhar(limitador, LIMITES.login.conta.maximo, dados);

  const primeiro = await limitador.exigirDentroDoLimite(dados).catch((erro) => erro.retryAfter);
  avancar(300);
  const segundo = await limitador.exigirDentroDoLimite(dados).catch((erro) => erro.retryAfter);

  assert.ok(segundo < primeiro, 'a espera precisa encolher com o tempo');
  assert.ok(segundo >= 1, 'nunca prometer liberação imediata');
});

test('a janela desliza de verdade: não zera de uma vez', async () => {
  const { limitador, avancar } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };
  const janelaSegundos = LIMITES.login.conta.janelaMs / 1000;

  // Falhas espalhadas no tempo, não em rajada.
  await falhar(limitador, 3, dados);
  avancar(janelaSegundos - 60);
  await falhar(limitador, 2, dados);

  await assert.rejects(() => limitador.exigirDentroDoLimite(dados), (erro) => erro.status === 429);

  // As três primeiras saem da janela; as duas recentes continuam contando.
  avancar(120);
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite(dados));
});

// ---------------------------------------------------------------- sucesso e limpeza

test('login bem-sucedido zera o contador da conta', async () => {
  const { limitador } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };

  await falhar(limitador, LIMITES.login.conta.maximo - 1, dados);
  await limitador.registrar({ ...dados, sucesso: true });

  // Quem errou e depois lembrou da senha não fica de castigo.
  await falhar(limitador, LIMITES.login.conta.maximo - 1, dados);
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite(dados));
});

test('o sucesso de uma conta não zera o contador do IP', async () => {
  const { limitador } = montar();
  const ip = '10.0.0.99';

  for (let contador = 0; contador < LIMITES.login.ip.maximo; contador += 1) {
    await limitador.registrar({ ip, email: `pessoa${contador}@exemplo.com`, acao: 'login', sucesso: false });
  }
  // Um acerto numa conta própria não pode limpar a varredura feita do mesmo IP.
  await limitador.registrar({ ip, email: 'doatacante@exemplo.com', acao: 'login', sucesso: true });

  await assert.rejects(
    () => limitador.exigirDentroDoLimite({ ip, email: 'outra@exemplo.com', acao: 'login' }),
    (erro) => erro.escopo === 'ip',
  );
});

test('a limpeza remove o que saiu de qualquer janela', async () => {
  const { limitador, repositorio, avancar } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login' };

  await falhar(limitador, 3, dados);
  assert.equal(await limitador.limpar(), 0, 'nada recente deve ser removido');

  avancar(25 * 60 * 60);
  assert.equal(await limitador.limpar(), 3);

  const { total } = await repositorio.contarFalhas({
    hashConta: chaveDaConta(dados.email), acao: 'login', desde: new Date(0).toISOString(),
  });
  assert.equal(total, 0);
});

// ---------------------------------------------------------------- ações separadas

test('cada ação tem contagem própria', async () => {
  const { limitador } = montar();
  const email = 'pessoa@exemplo.com';

  await falhar(limitador, LIMITES.login.conta.maximo, { ip: '10.0.0.1', email, acao: 'login' });

  // Estourar o login não pode travar o pedido de recuperação, e vice-versa.
  await assert.rejects(() => limitador.exigirDentroDoLimite({ ip: '10.0.0.1', email, acao: 'login' }));
  await assert.doesNotReject(() => limitador.exigirDentroDoLimite({
    ip: '10.0.0.1', email, acao: 'recuperacao',
  }));
});

test('recuperação tem teto mais baixo — é flood na caixa de outra pessoa', async () => {
  const { limitador } = montar();
  const dados = { ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'recuperacao' };

  assert.ok(LIMITES.recuperacao.conta.maximo < LIMITES.login.conta.maximo);

  await falhar(limitador, LIMITES.recuperacao.conta.maximo, dados);
  await assert.rejects(() => limitador.exigirDentroDoLimite(dados), (erro) => erro.status === 429);
});

// ---------------------------------------------------------------- casos de borda

test('sem IP e sem e-mail, nada é limitado — e nada quebra', async () => {
  const { limitador } = montar();

  await assert.doesNotReject(() => limitador.exigirDentroDoLimite({ acao: 'login' }));
  await assert.doesNotReject(() => limitador.registrar({ acao: 'login', sucesso: false }));
});

test('ação desconhecida não é limitada nem lança', async () => {
  const { limitador } = montar();

  await assert.doesNotReject(() => limitador.exigirDentroDoLimite({
    ip: '10.0.0.1', email: 'a@b.c', acao: 'inventada',
  }));
});

test('a senha nunca chega ao limitador', async () => {
  const { limitador, repositorio } = montar();

  // A interface do registrar não tem campo de senha; conferir que nada vaza
  // mesmo se alguém passar um objeto a mais.
  await limitador.registrar({
    ip: '10.0.0.1', email: 'pessoa@exemplo.com', acao: 'login', sucesso: false,
    senha: 'nunca-deveria-ser-guardada',
  });

  const bruto = JSON.stringify(await repositorio.contarFalhas({
    hashConta: chaveDaConta('pessoa@exemplo.com'), acao: 'login', desde: new Date(0).toISOString(),
  }));
  assert.ok(!bruto.includes('nunca-deveria-ser-guardada'));
});
