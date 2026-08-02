'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRegistroEmMemoria } = require('../src/armazenamento/idempotencia');

test('a primeira chave é desconhecida e a segunda consulta devolve o resultado', () => {
  const registro = criarRegistroEmMemoria();

  assert.equal(registro.consultar('chave-a'), null);
  registro.registrar('chave-a', { aceito: true });
  assert.deepEqual(registro.consultar('chave-a'), { aceito: true });
});

test('registrar a mesma chave duas vezes preserva o primeiro resultado', () => {
  const registro = criarRegistroEmMemoria();

  registro.registrar('chave-a', { ordem: 'primeiro' });
  const devolvido = registro.registrar('chave-a', { ordem: 'segundo' });

  assert.deepEqual(devolvido, { ordem: 'primeiro' });
  assert.deepEqual(registro.consultar('chave-a'), { ordem: 'primeiro' });
});

test('a chave expira depois da janela', () => {
  let agora = 1_000_000;
  const registro = criarRegistroEmMemoria({ janelaMs: 1000, agora: () => agora });

  registro.registrar('chave-a', { aceito: true });
  agora += 999;
  assert.deepEqual(registro.consultar('chave-a'), { aceito: true });

  agora += 2;
  assert.equal(registro.consultar('chave-a'), null, 'a chave deveria ter expirado');
});

test('o registro respeita a capacidade máxima', () => {
  const registro = criarRegistroEmMemoria({ capacidade: 3 });

  for (let indice = 0; indice < 10; indice += 1) registro.registrar(`chave-${indice}`, { indice });

  assert.ok(registro.tamanho() <= 3, `tamanho inesperado: ${registro.tamanho()}`);
  assert.deepEqual(registro.consultar('chave-9'), { indice: 9 }, 'a chave mais recente deve sobreviver');
});
