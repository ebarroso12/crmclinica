'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

// A porta assinada processava UM evento por requisição. A Meta empacota mais
// de um `entry`/`messaging` na mesma chamada, e o resto era descartado com
// HTTP 200 — e ela não reentrega o que já foi aceito, então a mensagem do
// paciente sumia sem rastro nenhum.

const SEGREDO = 'segredo-sintetico-do-app-do-instagram-com-mais-de-32-caracteres';

function mensagem({ remetente, texto, mid, timestamp = 1757000000000 }) {
  return { sender: { id: remetente }, timestamp, message: { mid, text: texto } };
}

function payload(...gruposDeMensagens) {
  return {
    object: 'instagram',
    entry: gruposDeMensagens.map((messaging, i) => ({
      id: `conta-${i}`, time: 1757000000, messaging,
    })),
  };
}

async function subir() {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ INSTAGRAM_APP_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio, configuracao, autenticar: false });
  return { app, repositorio };
}

function enviar(app, corpo) {
  const bruto = JSON.stringify(corpo);
  return app.pedirSemAuth('/api/canais/instagram/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SEGREDO).update(bruto).digest('hex')}`,
    },
    body: bruto,
  });
}

test('uma mensagem só: a resposta continua exatamente a de antes', async (t) => {
  // Nada do que já integra com esta porta pode enxergar diferença.
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, payload([
    mensagem({ remetente: 'psid-ana', texto: 'oi, quero marcar', mid: 'mid-1' }),
  ]));

  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.duplicado, false);
  assert.equal(recibo.canal, 'instagram');
  assert.equal(typeof recibo.chave_idempotencia, 'string');
  assert.equal(typeof recibo.conversa_id, 'number');
  assert.equal(recibo.eventos, undefined, 'resposta de um evento não ganha campo novo');

  assert.equal((await repositorio.listarConversas({})).length, 1);
});

test('duas mensagens na mesma chamada viram duas conversas — nenhuma se perde', async (t) => {
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, payload([
    mensagem({ remetente: 'psid-ana', texto: 'quero marcar', mid: 'mid-1' }),
    mensagem({ remetente: 'psid-bruno', texto: 'qual o horario?', mid: 'mid-2' }),
  ]));

  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.eventos, 2);
  assert.equal(recibo.recibos.length, 2);
  assert.ok(recibo.recibos.every((r) => r.aceito === true));

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 2);
});

test('o lote atravessa mais de um `entry`, não só o primeiro', async (t) => {
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, payload(
    [mensagem({ remetente: 'psid-ana', texto: 'oi', mid: 'mid-1' })],
    [mensagem({ remetente: 'psid-bruno', texto: 'boa tarde', mid: 'mid-2' })],
  ));

  assert.equal((await resposta.json()).eventos, 2);
  assert.equal((await repositorio.listarConversas({})).length, 2);
});

test('eco e recibo de leitura no meio do lote são descartados, o resto passa', async (t) => {
  // Lote misto é o caso real: a Meta manda entrega, leitura e mensagem juntos.
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, payload([
    { sender: { id: 'psid-ana' }, timestamp: 1757000000000, read: { mid: 'mid-0' } },
    { sender: { id: 'conta-da-clinica' }, timestamp: 1757000000000, message: { mid: 'mid-eco', text: 'ja respondi', is_echo: true } },
    mensagem({ remetente: 'psid-ana', texto: 'quero agendar', mid: 'mid-1' }),
  ]));

  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.duplicado, false, 'sobrou uma mensagem só: resposta no formato de sempre');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  const mensagens = await repositorio.listarMensagens(conversas[0].id);
  assert.equal(mensagens[0].conteudo, 'quero agendar');
});

test('lote sem nenhuma mensagem de paciente é aceito e ignorado, não vira erro', async (t) => {
  // Erro faria a Meta reter e martelar retry num evento que nunca vai virar
  // conversa.
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, payload([
    { sender: { id: 'psid-ana' }, timestamp: 1757000000000, delivery: { mids: ['mid-0'] } },
  ]));

  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { aceito: true, ignorado: true });
  assert.equal((await repositorio.listarConversas({})).length, 0);
});

test('reentrega do mesmo lote não duplica nada', async (t) => {
  // A idempotência é por evento (`chave_idempotencia`), não por requisição:
  // é ela que torna seguro deixar uma falha de infraestrutura subir e a Meta
  // remandar o lote inteiro.
  const { app, repositorio } = await subir();
  t.after(() => app.encerrar());

  const lote = payload([
    mensagem({ remetente: 'psid-ana', texto: 'quero marcar', mid: 'mid-1' }),
    mensagem({ remetente: 'psid-bruno', texto: 'qual o horario?', mid: 'mid-2' }),
  ]);

  await enviar(app, lote);
  const segunda = await enviar(app, lote);

  const recibo = await segunda.json();
  assert.equal(recibo.eventos, 2);
  assert.ok(recibo.recibos.every((r) => r.duplicado === true), 'reentrega volta como duplicada');

  assert.equal((await repositorio.listarConversas({})).length, 2, 'nenhuma conversa a mais');
});
