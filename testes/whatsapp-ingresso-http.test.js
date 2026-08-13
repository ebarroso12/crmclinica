'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { assinar } = require('../src/integracoes/openclaw');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

const SEGREDO = 'segredo-sintetico-da-ponte-whatsapp-com-mais-de-32-caracteres';
const EVENTO = Object.freeze({
  tipo: 'mensagem.recebida',
  canal: 'whatsapp',
  id_externo: 'openclaw:mensagem-sintetica-1',
  remetente: '5511999990000',
  nome: 'Contato de Teste',
  texto: 'Olá, gostaria de informações',
  origem: 'openclaw_plugin',
  ocorrido_em: '2026-08-06T12:00:00.000Z',
});

async function subirIngresso(sobrescritas = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: null });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO, ...sobrescritas });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  return { app, repositorio };
}

function enviar(app, corpo, segredo = SEGREDO) {
  const bruto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return app.pedirSemAuth('/api/canais/whatsapp/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(segredo ? { 'x-whatsapp-assinatura': assinar(bruto, segredo) } : {}),
    },
    body: bruto,
  });
}

test('a ponte registra o inbound em Conversas e a rota carimba crm_despacha', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.estrategia_ia, 'crm_despacha');
  assert.equal(typeof recibo.conversa_id, 'number');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  const mensagens = await repositorio.listarMensagens(conversas[0].id);
  assert.equal(mensagens[0].direcao, 'entrada');
  assert.equal(mensagens[0].conteudo, EVENTO.texto);
  assert.equal(mensagens[0].autor_tipo, 'contato');
});

test('a assinatura da ponte é obrigatória e não aceita o segredo do webhook genérico', async (t) => {
  const { app } = await subirIngresso();
  t.after(() => app.encerrar());

  assert.equal((await enviar(app, EVENTO, null)).status, 401);
  assert.equal((await enviar(app, EVENTO, 'outro-segredo-com-tamanho-suficiente-para-o-teste')).status, 401);
});

test('a mesma mensagem é idempotente e não cria segunda linha', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  assert.equal((await enviar(app, EVENTO)).status, 202);
  const repetida = await enviar(app, { ...EVENTO, texto: 'texto alterado na reentrega' });
  assert.equal(repetida.status, 200);
  assert.equal((await repetida.json()).duplicado, true);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1);
});

test('payload não consegue transferir a resposta ao agente direto nem trocar de canal', async (t) => {
  const { app, repositorio } = await subirIngresso();
  t.after(() => app.encerrar());

  const agenteDireto = await enviar(app, { ...EVENTO, estrategia_ia: 'openclaw_gerencia' });
  assert.equal(agenteDireto.status, 422);

  const outroCanal = await enviar(app, { ...EVENTO, canal: 'site', id_externo: 'site:1' });
  assert.equal(outroCanal.status, 422);
  assert.equal((await repositorio.listarConversas({})).length, 0);
});

// Comando 3: o `setImmediate` que rodava a IA depois do aceite foi removido —
// não é mais durabilidade "por acidente" de um processo que continua vivo
// depois do 202. O que a porta de ingresso garante agora é mais modesto e
// mais forte ao mesmo tempo: a mensagem E o trabalho da outbox são
// persistidos ANTES do 202, e NADA mais acontece dentro da requisição. Quem
// processa o trabalho é o worker — testado em
// testes/automacao-outbox-servico.test.js e testes/automacao-outbox-http.test.js.

test('o aceite volta na hora e não despacha a IA dentro da requisição — o trabalho fica na outbox', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: {
      disponivel: true,
      // Se isto for chamado durante o POST, o teste tem que estourar: a
      // garantia do Comando 3 é que NADA depois da gravação roda dentro da
      // requisição — nem para o caminho feliz, nem para o lento.
      async despacharEvento() { throw new Error('a IA não pode ser despachada dentro da requisição HTTP'); },
    },
  });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.decisao, 'aceita_para_despacho');

  // A mensagem do paciente já está gravada no aceite, sem depender da IA.
  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0].direcao, 'entrada');

  // E o trabalho de responder está na outbox, pendente — não processado, não
  // perdido, esperando o worker.
  const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
  assert.equal(fila.pendente, 1);
  assert.equal(fila.processando, 0);
  assert.equal(fila.concluido, 0);
});

test('a mensagem e o trabalho da outbox nascem juntos, atomicamente', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  await enviar(app, EVENTO);

  const [conversa] = await repositorio.listarConversas({});
  const [mensagemDeEntrada] = await repositorio.listarMensagens(conversa.id);
  const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
  assert.equal(fila.pendente, 1, 'precisa existir um trabalho pendente correspondente à mensagem gravada');

  // O trabalho referencia exatamente esta conversa e esta mensagem — não é
  // um trabalho qualquer, é O trabalho desta mensagem.
  const trabalho = await repositorio.obterTrabalhoDeOutbox(1);
  assert.equal(trabalho.conversa_id, conversa.id);
  assert.equal(trabalho.mensagem_entrada_id, mensagemDeEntrada.id);
});

test('GET na porta de ingresso é recusado', async (t) => {
  const { app } = await subirIngresso();
  t.after(() => app.encerrar());

  const resposta = await app.pedirSemAuth('/api/canais/whatsapp/eventos');
  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'POST');
});

// --- segunda porta: token da Evolution API, sem HMAC (ela não sabe gerar) ---

const TOKEN_EVOLUTION = 'token-sintetico-da-evolution-com-32-ou-mais-caracteres';
const MENSAGEM_EVOLUTION = Object.freeze({
  event: 'messages.upsert',
  instance: 'clinica',
  data: {
    key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: '3EB0EVO1' },
    pushName: 'Paciente Evolution',
    message: { conversation: 'Mensagem vinda direto da Evolution' },
    messageTimestamp: 1723500000,
  },
});

function enviarSemAssinatura(app, corpo, query = '') {
  return app.pedirSemAuth(`/api/canais/whatsapp/eventos${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

test('a Evolution entra com token na querystring e o payload nativo é traduzido', async (t) => {
  const { app, repositorio } = await (async () => {
    const repositorio = criarRepositorioEmMemoria();
    const atendimento = criarAtendimento({ repositorio, orquestrador: null });
    const configuracao = configuracaoDeTeste({
      WHATSAPP_WEBHOOK_SECRET: SEGREDO,
      EVOLUTION_WEBHOOK_TOKEN: TOKEN_EVOLUTION,
    });
    const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
    return { app, repositorio };
  })();
  t.after(() => app.encerrar());

  const resposta = await enviarSemAssinatura(app, MENSAGEM_EVOLUTION, `?token=${TOKEN_EVOLUTION}`);
  assert.equal(resposta.status, 202);
  const recibo = await resposta.json();
  assert.equal(recibo.aceito, true);
  assert.equal(recibo.estrategia_ia, 'crm_despacha');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  const mensagens = await repositorio.listarMensagens(conversas[0].id);
  assert.equal(mensagens[0].conteudo, 'Mensagem vinda direto da Evolution');
});

test('token errado ou ausente continua recusado com 401, mesmo com EVOLUTION_WEBHOOK_TOKEN configurado', async (t) => {
  const configuracao = configuracaoDeTeste({
    WHATSAPP_WEBHOOK_SECRET: SEGREDO,
    EVOLUTION_WEBHOOK_TOKEN: TOKEN_EVOLUTION,
  });
  const app = await subirServidor({
    repositorio: criarRepositorioEmMemoria(),
    atendimento: criarAtendimento({ repositorio: criarRepositorioEmMemoria(), orquestrador: null }),
    configuracao,
    autenticar: false,
  });
  t.after(() => app.encerrar());

  assert.equal((await enviarSemAssinatura(app, MENSAGEM_EVOLUTION, '?token=token-errado-com-tamanho-parecido')).status, 401);
  assert.equal((await enviarSemAssinatura(app, MENSAGEM_EVOLUTION)).status, 401);
});

test('sem EVOLUTION_WEBHOOK_TOKEN configurado, a segunda porta não existe — só HMAC vale', async (t) => {
  const { app } = await subirIngresso(); // configuracaoDeTeste sem EVOLUTION_WEBHOOK_TOKEN
  t.after(() => app.encerrar());

  assert.equal((await enviarSemAssinatura(app, MENSAGEM_EVOLUTION, `?token=${TOKEN_EVOLUTION}`)).status, 401);
});

test('evento da Evolution que não é mensagem de paciente é aceito e ignorado (200), não vira conversa', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: null });
  const configuracao = configuracaoDeTeste({
    WHATSAPP_WEBHOOK_SECRET: SEGREDO,
    EVOLUTION_WEBHOOK_TOKEN: TOKEN_EVOLUTION,
  });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const conexao = await enviarSemAssinatura(app, { event: 'connection.update', data: { state: 'open' } }, `?token=${TOKEN_EVOLUTION}`);
  assert.equal(conexao.status, 200);
  assert.equal((await conexao.json()).ignorado, true);

  const eco = await enviarSemAssinatura(app, {
    ...MENSAGEM_EVOLUTION,
    data: { ...MENSAGEM_EVOLUTION.data, key: { ...MENSAGEM_EVOLUTION.data.key, fromMe: true } },
  }, `?token=${TOKEN_EVOLUTION}`);
  assert.equal(eco.status, 200);
  assert.equal((await eco.json()).ignorado, true);

  assert.equal((await repositorio.listarConversas({})).length, 0);
});

test('a assinatura HMAC do OpenClaw continua valendo normalmente com EVOLUTION_WEBHOOK_TOKEN configurado', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: null });
  const configuracao = configuracaoDeTeste({
    WHATSAPP_WEBHOOK_SECRET: SEGREDO,
    EVOLUTION_WEBHOOK_TOKEN: TOKEN_EVOLUTION,
  });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO); // assinado por HMAC, como sempre
  assert.equal(resposta.status, 202);
  assert.equal((await resposta.json()).aceito, true);
});
