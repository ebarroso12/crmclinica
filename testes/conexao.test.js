'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  conferirConexao, descreverConexao, exigirConexaoSegura,
} = require('../src/dados/conferir-conexao');

// Com quem a aplicação conectou.
//
// Conectar como dono das tabelas não gera erro nenhum: tudo funciona igual, as
// consultas respondem, os testes passam — e o RLS simplesmente não é avaliado,
// porque dono tem BYPASSRLS. É uma falha sem sintoma, e é por isso que ela
// precisa de uma verificação explícita no arranque.

function poolFalso({ usuario = 'crmclinica_app', ignoraRls = false, superusuario = false, tabelas = 0 }) {
  return {
    async query() {
      return {
        rows: [{
          usuario,
          ignora_rls: ignoraRls,
          superusuario,
          tabelas_proprias: tabelas,
        }],
      };
    },
  };
}

test('a role da aplicação é considerada segura', async () => {
  const diagnostico = await conferirConexao(poolFalso({ usuario: 'crmclinica_app' }));

  assert.equal(diagnostico.seguro, true);
  assert.equal(diagnostico.usuario, 'crmclinica_app');
  assert.match(descreverConexao(diagnostico), /o RLS vale para esta conexão/);
});

test('BYPASSRLS reprova, mesmo sem ser dono de nada', async () => {
  const diagnostico = await conferirConexao(poolFalso({ usuario: 'postgres', ignoraRls: true }));

  assert.equal(diagnostico.seguro, false);
  assert.match(descreverConexao(diagnostico), /BYPASSRLS/);
});

test('ser dono das tabelas reprova, mesmo sem BYPASSRLS', async () => {
  // Dono ignora RLS por ser dono, independentemente do atributo.
  const diagnostico = await conferirConexao(poolFalso({ usuario: 'dono', tabelas: 18 }));

  assert.equal(diagnostico.seguro, false);
  assert.match(descreverConexao(diagnostico), /dono de 18 tabela/);
});

test('superusuário reprova', async () => {
  const diagnostico = await conferirConexao(poolFalso({ usuario: 'postgres', superusuario: true }));

  assert.equal(diagnostico.seguro, false);
  assert.match(descreverConexao(diagnostico), /é superusuário/);
});

test('em produção, conexão privilegiada impede a subida', async () => {
  // Publicar acreditando que o RLS protege, quando ele nem roda, é pior do que
  // publicar sabendo que não há RLS.
  await assert.rejects(
    () => exigirConexaoSegura(poolFalso({ usuario: 'postgres', ignoraRls: true }), { producao: true }),
    (erro) => {
      assert.equal(erro.codigo, 'conexao_privilegiada');
      assert.match(erro.message, /não é avaliado/);
      return true;
    },
  );
});

test('fora de produção, apenas avisa', async (t) => {
  // Quem desenvolve costuma ter só a URL do dono à mão. Travar o ambiente local
  // empurraria a pessoa a desligar a verificação em vez de arrumar a conexão.
  const avisos = [];
  t.mock.method(console, 'warn', (mensagem) => avisos.push(String(mensagem)));

  const diagnostico = await exigirConexaoSegura(
    poolFalso({ usuario: 'postgres', ignoraRls: true }),
    { producao: false },
  );

  assert.equal(diagnostico.seguro, false);
  assert.ok(avisos.some((linha) => /AVISO/.test(linha)));
  assert.ok(avisos.some((linha) => /crmclinica_app/.test(linha)));
});

test('conexão segura em produção passa sem reclamar', async (t) => {
  const avisos = [];
  t.mock.method(console, 'warn', (mensagem) => avisos.push(String(mensagem)));
  t.mock.method(console, 'log', () => {});

  const diagnostico = await exigirConexaoSegura(poolFalso({}), { producao: true });

  assert.equal(diagnostico.seguro, true);
  assert.deepEqual(avisos, []);
});
