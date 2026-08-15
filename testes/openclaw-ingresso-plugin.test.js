'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULO = pathToFileURL(path.join(
  __dirname, '..', 'integracoes', 'openclaw-plugin-crmclinica', 'ponte.js',
)).href;
const MODULO_REGISTRO = pathToFileURL(path.join(
  __dirname, '..', 'integracoes', 'openclaw-plugin-crmclinica', 'registro.js',
)).href;
const SEGREDO = 'segredo-sintetico-da-ponte-com-mais-de-32-caracteres';

async function modulo() {
  return import(MODULO);
}

test('normaliza somente inbound do WhatsApp e preserva identidade nativa', async () => {
  const { normalizarEvento } = await modulo();
  const normalizado = normalizarEvento({
    content: 'Preciso de uma avaliação',
    messageId: 'mensagem-123',
    senderId: '5511999990000@s.whatsapp.net',
    senderName: 'Contato de Teste',
    timestamp: 1786028400000,
  }, { channelId: 'whatsapp', sessionKey: 'agent:serena:whatsapp:direct:teste' });

  assert.equal(normalizado.canal, 'whatsapp');
  assert.equal(normalizado.remetente, '5511999990000');
  assert.equal(normalizado.id_externo, 'whatsapp:5511999990000:mensagem-123');
  assert.equal(normalizado.texto, 'Preciso de uma avaliação');

  assert.equal(normalizarEvento({ ...normalizado, fromMe: true }, { channelId: 'whatsapp' }), null);
  assert.equal(normalizarEvento({ content: 'interno' }, { channelId: 'webchat' }), null);
});

test('sem messageId nem timestamp, reentrega do mesmo conteúdo gera o mesmo id_externo', async () => {
  // Reproduz o cenário real: o gateway não manda identidade nativa nem
  // timestamp para este evento, e o mesmo inbound chega duas vezes (retry,
  // reconexão). Sem isso, cada chamada caía num id_externo diferente — e o
  // paciente via a Serena responder duas vezes à mesma mensagem.
  const { normalizarEvento } = await modulo();
  const evento = { content: 'Oii boa tarde', senderId: '5511999990000' };
  const contexto = { channelId: 'whatsapp' };

  const primeiro = normalizarEvento(evento, contexto);
  const segundo = normalizarEvento(evento, contexto);

  assert.equal(primeiro.id_externo, segundo.id_externo);
});

test('com timestamp real, o id_externo de fallback acompanha o instante informado', async () => {
  const { normalizarEvento } = await modulo();
  const evento = { content: 'Oii boa tarde', senderId: '5511999990000', timestamp: 1786028400000 };
  const contexto = { channelId: 'whatsapp' };

  const primeiro = normalizarEvento(evento, contexto);
  const segundo = normalizarEvento(evento, contexto);

  assert.equal(primeiro.id_externo, segundo.id_externo);
});

test('mensagem de mídia sem legenda também vira registro visível no inbox', async () => {
  const { normalizarEvento } = await modulo();
  const evento = normalizarEvento({
    messageId: 'audio-1',
    senderId: '5511999990000',
    media: [{ kind: 'audio', contentType: 'audio/ogg' }],
  }, { channelId: 'whatsapp' });
  assert.equal(evento.texto, '[Mídia recebida: audio]');
});

test('silencia apenas a sessão WhatsApp antes da chamada ao modelo', async () => {
  const { decisaoDeSilencio } = await modulo();
  assert.deepEqual(
    decisaoDeSilencio({ sessionKey: 'agent:serena:whatsapp:direct:5511999990000' }),
    { handled: true, reason: 'crmclinica_controla_resposta_whatsapp' },
  );
  assert.equal(decisaoDeSilencio({ sessionKey: 'agent:serena:crm' }), undefined);
});

test('configuração incompleta falha fechada: mantém o hook de silêncio registrado', async () => {
  const { registrarPlugin } = await import(MODULO_REGISTRO);
  const hooks = new Map();
  const erros = [];
  const api = {
    rootDir: os.tmpdir(),
    runtime: { state: { resolveStateDir: () => os.tmpdir() } },
    logger: { error: (mensagem) => erros.push(mensagem) },
    on: (nome, handler) => hooks.set(nome, handler),
  };

  const resultado = registrarPlugin(api, {});
  assert.equal(resultado.configurada, false);
  assert.ok(hooks.has('before_agent_reply'));
  assert.ok(!hooks.has('message_received'));
  assert.equal(hooks.get('before_agent_reply')({}, {
    sessionKey: 'agent:serena:whatsapp:direct:5511999990000',
  }).handled, true);
  assert.match(erros[0], /permanece silencioso/);
});

test('persiste antes de entregar, mantém a fila na falha e a remove após sucesso', async (t) => {
  const { criarPonte } = await modulo();
  const pasta = await mkdtemp(path.join(os.tmpdir(), 'crmclinica-ingresso-'));
  t.after(() => rm(pasta, { recursive: true, force: true }));

  const requisicoes = [];
  let falhar = true;
  const ponte = criarPonte({
    endpoint: 'https://crm.exemplo/api/canais/whatsapp/eventos',
    segredo: SEGREDO,
    pasta,
    logger: { warn() {} },
    fetchImpl: async (_url, opcoes) => {
      requisicoes.push(opcoes);
      if (falhar) throw new Error('rede indisponível');
      return { ok: true, status: 202 };
    },
  });

  await ponte.receber({
    content: 'Mensagem que não pode se perder',
    messageId: 'duravel-1',
    senderId: '5511999990000',
  }, { channelId: 'whatsapp' });

  const [arquivo] = await readdir(pasta);
  assert.match(arquivo, /^[0-9a-f]{64}\.json$/);
  // O Windows não implementa os bits POSIX de modo e costuma reportar 0666,
  // mesmo quando o arquivo foi criado com 0600. A garantia é verificável nos
  // sistemas POSIX, inclusive no Linux usado pelo servidor de produção.
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(pasta, arquivo))).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(await readFile(path.join(pasta, arquivo), 'utf8')).id_externo, 'whatsapp:5511999990000:duravel-1');

  falhar = false;
  await ponte.tentarPendentes();
  assert.deepEqual(await readdir(pasta), []);
  assert.match(requisicoes.at(-1).headers['x-whatsapp-assinatura'], /^sha256=[0-9a-f]{64}$/);
});
