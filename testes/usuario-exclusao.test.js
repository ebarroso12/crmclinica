'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarContas } = require('../src/seguranca/contas');
const { configuracaoDeTeste } = require('./auxiliar');

/** As dependencias que criarContas exige, iguais as de limite-http.test.js. */
const DEPS = () => ({
  configuracao: configuracaoDeTeste(),
  remetente: { disponivel: false, enviar: async () => ({}) },
  google: { disponivel: false },
});

// Excluir conta de usuário (pedido do Dr. Edson, 12/09/2026: "quero deletar e
// auditar também").
//
// Excluir não tem volta, então o que estes testes protegem é o contrário do
// recurso: quem NÃO pode ser excluído, e o que precisa sobrar depois.
//
//   1. só o master exclui;
//   2. conta ativa não é excluída — desativa primeiro. São dois passos para um
//      ato irreversível, e o primeiro já tira o acesso, que é a urgência real;
//   3. o master não se apaga nem apaga outro master: clínica sem administrador
//      não tem como criar o próximo;
//   4. a auditoria é gravada ANTES, com nome e e-mail dentro do detalhe —
//      `audit_log.usuario_id` é ON DELETE SET NULL, então apagar a conta
//      apagaria o autor de todas as ações dela, inclusive desta.

function montar({ alvo } = {}) {
  const auditorias = [];
  const excluidos = [];
  const repositorio = {
    auditorias,
    excluidos,
    async obterUsuarioPorId(id) {
      return Number(id) === Number(alvo?.id) ? { ...alvo } : null;
    },
    async excluirUsuario(id) { excluidos.push(Number(id)); return true; },
    async registrarAuditoria(evento) { auditorias.push(evento); },
  };
  return { repositorio, contas: criarContas({ repositorio, ...DEPS() }) };
}

const MASTER = { id: 1, master: true, papel: 'admin' };
const DESATIVADO = { id: 5, nome: 'Rafael', email: 'rafael@exemplo.com', papel: 'admin', situacao: 'desativado' };

test('o master exclui uma conta desativada', async () => {
  const { contas, repositorio } = montar({ alvo: DESATIVADO });

  const resultado = await contas.excluirUsuario(MASTER, 5, { motivo: 'saiu da equipe' });

  assert.equal(resultado.excluido, true);
  assert.deepEqual(repositorio.excluidos, [5]);
});

test('a auditoria guarda quem era a pessoa — a conta some, o rastro fica', async () => {
  const { contas, repositorio } = montar({ alvo: DESATIVADO });

  await contas.excluirUsuario(MASTER, 5, { motivo: 'saiu da equipe' });

  const evento = repositorio.auditorias.find((a) => a.acao === 'usuario_excluido');
  assert.ok(evento, 'excluir conta tem de deixar rastro');
  assert.equal(evento.usuarioId, 1, 'quem excluiu');
  assert.equal(evento.detalhe.nome, 'Rafael');
  assert.equal(evento.detalhe.email, 'rafael@exemplo.com');
  assert.equal(evento.detalhe.papel, 'admin');
  assert.equal(evento.detalhe.situacao_anterior, 'desativado');
  assert.equal(evento.detalhe.motivo, 'saiu da equipe');
});

test('a auditoria vem ANTES do delete', async () => {
  // Depois não há de quem falar: o usuario_id da auditoria é SET NULL.
  const ordem = [];
  const repositorio = {
    async obterUsuarioPorId() { return { ...DESATIVADO }; },
    async registrarAuditoria() { ordem.push('auditoria'); },
    async excluirUsuario() { ordem.push('delete'); return true; },
  };
  await criarContas({ repositorio, ...DEPS() }).excluirUsuario(MASTER, 5);
  assert.deepEqual(ordem, ['auditoria', 'delete']);
});

// ---------------------------------------------------------------- quem não pode

test('quem não é master não exclui ninguém', async () => {
  const { contas, repositorio } = montar({ alvo: DESATIVADO });
  for (const quem of [{ id: 2, papel: 'admin' }, { id: 3, papel: 'gestor' }, {}, null]) {
    await assert.rejects(
      () => contas.excluirUsuario(quem, 5),
      (erro) => erro.status === 403,
      `${JSON.stringify(quem)} não deveria excluir`,
    );
  }
  assert.deepEqual(repositorio.excluidos, [], 'nada foi excluído');
});

test('conta ATIVA não é excluída: desative primeiro', async () => {
  const ativo = { ...DESATIVADO, situacao: 'ativo' };
  const { contas, repositorio } = montar({ alvo: ativo });

  await assert.rejects(
    () => contas.excluirUsuario(MASTER, 5),
    (erro) => erro.status === 409 && /desative a conta antes/i.test(erro.message),
  );
  assert.deepEqual(repositorio.excluidos, []);
});

test('o master não exclui a própria conta', async () => {
  const { contas } = montar({ alvo: { id: 1, nome: 'Edson', master: true, situacao: 'ativo' } });
  await assert.rejects(
    () => contas.excluirUsuario(MASTER, 1),
    (erro) => erro.status === 409 && /própria conta/i.test(erro.message),
  );
});

test('a conta do master não é excluída nem por outro master', async () => {
  const outroMaster = { id: 9, nome: 'Outro', master: true, situacao: 'desativado' };
  const { contas } = montar({ alvo: outroMaster });
  await assert.rejects(
    () => contas.excluirUsuario(MASTER, 9),
    (erro) => erro.status === 409 && /master/i.test(erro.message),
  );
});

test('conta que não existe devolve 404, não erro interno', async () => {
  const { contas } = montar({ alvo: DESATIVADO });
  await assert.rejects(
    () => contas.excluirUsuario(MASTER, 999),
    (erro) => erro.status === 404,
  );
});

// ---------------------------------------------------------------- o banco recusando

test('registro que não pode ficar sem dono vira mensagem clara, não erro cru', async () => {
  // `serena_voz_sessoes` e `auditoria_exportacoes` apontam para usuarios com
  // RESTRICT/NO ACTION: o Postgres recusa o DELETE com 23503. O banco recusando
  // é proteção — mas quem clicou precisa entender o que aconteceu.
  const repositorio = {
    async obterUsuarioPorId() { return { ...DESATIVADO }; },
    async registrarAuditoria() {},
    async excluirUsuario() {
      const erro = new Error('update or delete on table "usuarios" violates foreign key constraint');
      erro.code = '23503';
      throw erro;
    },
  };

  await assert.rejects(
    () => criarContas({ repositorio, ...DEPS() }).excluirUsuario(MASTER, 5),
    (erro) => erro.status === 409
      && /sessão de voz|exportação de auditoria/i.test(erro.message)
      && /continua desativada/i.test(erro.message),
  );
});

test('erro de banco que não é 23503 sobe como está', async () => {
  const repositorio = {
    async obterUsuarioPorId() { return { ...DESATIVADO }; },
    async registrarAuditoria() {},
    async excluirUsuario() {
      const erro = new Error('conexão perdida');
      erro.code = '08006';
      throw erro;
    },
  };
  await assert.rejects(
    () => criarContas({ repositorio, ...DEPS() }).excluirUsuario(MASTER, 5),
    (erro) => erro.code === '08006',
  );
});

// ---------------------------------------------------------------- tela

test('o botão Excluir não aparece em conta ativa, no master, nem na própria', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.match(app, /const podeExcluir = usuario\.situacao !== 'ativo' && !usuario\.master\s*\n?\s*&& Number\(usuario\.id\) !== Number\(usuarioAtual\?\.id\)/,
    'as três condições precisam estar na tela, não só no servidor');
  assert.match(app, /excluir\.className = 'perigo'/, 'botão destrutivo tem aparência de destrutivo');
});

test('a confirmação exige digitar o nome e explica o que não tem volta', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const funcao = app.slice(app.indexOf('async function excluirUsuario('), app.indexOf('function montarLinhaDeUsuario('));

  assert.match(funcao, /window\.confirm/, 'confirma antes');
  assert.match(funcao, /window\.prompt/, 'e pede o nome digitado');
  assert.match(funcao, /toLowerCase\(\) !== String\(usuario\.nome/, 'o nome tem de conferir');
  assert.match(funcao, /NAO tem volta/i);
  assert.match(funcao, /use Desativar/i, 'oferece a saída reversível');
  assert.match(funcao, /metodo: 'DELETE'/);
});
