'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./auxiliar');
const { CABECALHOS_SEGURANCA } = require('../src/servidor/http');

test('GET /health identifica o produto e responde ok', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/health');
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.equal(corpo.produto, 'crmclinica');
  assert.equal(corpo.status, 'ok');
  assert.match(corpo.instante, /^\d{4}-\d{2}-\d{2}T/);
});

test('respostas trazem os cabeçalhos de segurança', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/health');
  for (const cabecalho of Object.keys(CABECALHOS_SEGURANCA)) {
    assert.equal(resposta.headers.get(cabecalho), CABECALHOS_SEGURANCA[cabecalho], `faltou ${cabecalho}`);
  }
});

test('a interface é servida na raiz e não expõe outros arquivos', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const pagina = await app.pedir('/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers.get('content-type'), /text\/html/);
  assert.match(await pagina.text(), /crmclinica/);

  // Travessia de caminho não alcança nada: só a lista fechada de arquivos é servida.
  for (const alvo of ['/../package.json', '/.env', '/src/config.js', '/api/index.js']) {
    const proibido = await app.pedir(alvo);
    assert.equal(proibido.status, 404, `rota ${alvo} deveria ser 404`);
  }
});

test('rota desconhecida responde 404 e método errado responde 405', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  assert.equal((await app.pedir('/nao-existe')).status, 404);

  const metodoErrado = await app.pedir('/health', { method: 'DELETE' });
  assert.equal(metodoErrado.status, 405);
  assert.equal(metodoErrado.headers.get('allow'), 'GET');
});
