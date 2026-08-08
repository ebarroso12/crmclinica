'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// O Centro operacional vivia quebrado sem ninguém notar: `GET /api/diagnostico`
// estava no mapa de rotas da Serena, mas o guarda de prefixo (`/api/serena`)
// abortava antes de chegar ao mapa — 404 em produção, com o botão "Verificar
// agora" da tela apontando exatamente para cá. Este arquivo garante que a rota
// responde por HTTP, não só no domínio.

test('GET /api/diagnostico responde 200 para admin, com as quatro sondas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico');
    assert.equal(resposta.status, 200, 'a rota precisa existir por HTTP, não só no mapa');

    const corpo = await resposta.json();
    assert.ok(['ok', 'atencao', 'falha', 'critico'].includes(corpo.nivel), 'a varredura devolve um nível');
    assert.equal(typeof corpo.saudavel, 'boolean');
    assert.ok(Array.isArray(corpo.achados));
    assert.ok(typeof corpo.resumo === 'string' && corpo.resumo.length > 0);
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico recusa quem não gerencia usuários', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'atendente' });
  try {
    const resposta = await ambiente.pedir('/api/diagnostico');
    assert.equal(resposta.status, 403, 'a varredura expõe infraestrutura; atendente não vê');
  } finally {
    await ambiente.encerrar();
  }
});

test('GET /api/diagnostico sem sessão é recusado', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const resposta = await ambiente.pedirSemAuth('/api/diagnostico');
    assert.equal(resposta.status, 401);
  } finally {
    await ambiente.encerrar();
  }
});
