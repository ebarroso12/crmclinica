'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { assinar } = require('../src/integracoes/openclaw');

// Segredo sintético de teste. Não corresponde a nenhum ambiente real.
const SEGREDO_DE_TESTE = 'segredo-apenas-para-teste-com-32-caracteres';

const EVENTO = {
  tipo: 'mensagem.recebida',
  canal: 'whatsapp',
  id_externo: 'wa:teste-1',
  remetente: '551199999999',
  texto: 'Olá, gostaria de agendar uma avaliação',
};

function enviar(app, corpo, cabecalhos = {}) {
  return app.pedir('/api/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: corpo,
  });
}

test('aceita um evento válido e devolve recibo com a chave de idempotência', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, JSON.stringify(EVENTO));
  assert.equal(resposta.status, 202);

  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.duplicado, false);
  assert.equal(recibo.tipo, 'mensagem.recebida');
  assert.match(recibo.chave_idempotencia, /^[0-9a-f]{64}$/);
  // A mensagem virou conversa no inbox — não ficou só registrada em lugar nenhum.
  assert.equal(typeof recibo.conversa_id, 'number');
  // Sem orquestrador configurado, a conversa fica esperando a equipe.
  assert.equal(recibo.decisao, 'sem_orquestrador');
});

test('reenvio do mesmo evento é idempotente e não reprocessa', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const primeira = await (await enviar(app, JSON.stringify(EVENTO))).json();
  const segunda = await enviar(app, JSON.stringify({ ...EVENTO, texto: 'mesma mensagem reenviada' }));

  assert.equal(segunda.status, 200);
  const repetida = await segunda.json();
  assert.equal(repetida.duplicado, true);
  assert.equal(repetida.chave_idempotencia, primeira.chave_idempotencia);
  assert.equal(repetida.recebido_em, primeira.recebido_em);
});

test('evento fora do contrato responde 400 apontando o campo', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, JSON.stringify({ canal: 'whatsapp', texto: 'sem identificação' }));
  assert.equal(resposta.status, 400);

  const erro = await resposta.json();
  assert.equal(erro.campo, 'id_externo');
});

test('corpo que não é JSON responde 400', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  assert.equal((await enviar(app, 'isto não é json')).status, 400);
  assert.equal((await enviar(app, '')).status, 400);
});

test('corpo acima do limite responde 413 antes de ser interpretado', async (t) => {
  const app = await subirServidor({ configuracao: configuracaoDeTeste({ LIMITE_CORPO_BYTES: '512' }) });
  t.after(() => app.encerrar());

  const gigante = JSON.stringify({ ...EVENTO, texto: 'a'.repeat(4000) });
  const resposta = await enviar(app, gigante);
  assert.equal(resposta.status, 413);
  assert.match((await resposta.json()).erro, /limite/);
});

test('com segredo configurado, só assinatura HMAC válida é aceita', async (t) => {
  const configuracao = configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO_DE_TESTE });
  const app = await subirServidor({ configuracao });
  t.after(() => app.encerrar());

  const corpo = JSON.stringify(EVENTO);

  assert.equal((await enviar(app, corpo)).status, 401, 'sem assinatura deveria ser recusado');
  assert.equal((await enviar(app, corpo, { 'x-openclaw-assinatura': 'sha256=0'.padEnd(71, '0') })).status, 401);
  assert.equal(
    (await enviar(app, corpo, { 'x-openclaw-assinatura': assinar(corpo, 'outro-segredo-qualquer') })).status,
    401,
    'assinatura de outro segredo deveria ser recusada',
  );

  const valida = await enviar(app, corpo, { 'x-openclaw-assinatura': assinar(corpo, SEGREDO_DE_TESTE) });
  assert.equal(valida.status, 202);
});

test('assinatura válida de um corpo não vale para outro', async (t) => {
  const configuracao = configuracaoDeTeste({ OPENCLAW_WEBHOOK_SECRET: SEGREDO_DE_TESTE });
  const app = await subirServidor({ configuracao });
  t.after(() => app.encerrar());

  const assinaturaDeOutroCorpo = assinar(JSON.stringify(EVENTO), SEGREDO_DE_TESTE);
  const adulterado = JSON.stringify({ ...EVENTO, remetente: '551188888888' });

  const resposta = await enviar(app, adulterado, { 'x-openclaw-assinatura': assinaturaDeOutroCorpo });
  assert.equal(resposta.status, 401);
});

test('em produção sem segredo, a recepção de eventos fica indisponível', async (t) => {
  const configuracao = configuracaoDeTeste({ NODE_ENV: 'production', OPENCLAW_WEBHOOK_SECRET: '' });
  const app = await subirServidor({ configuracao });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, JSON.stringify(EVENTO));
  assert.equal(resposta.status, 503);
});

test('GET em /api/eventos é recusado', async (t) => {
  const app = await subirServidor();
  t.after(() => app.encerrar());

  const resposta = await app.pedir('/api/eventos');
  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'POST');
});
