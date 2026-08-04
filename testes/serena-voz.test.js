'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { assinaturaDeEvento } = require('../src/dominio/serena-voz');
const { configuracaoDeTeste, subirServidor } = require('./auxiliar');

const SEGREDO_JWT = 'jwt-de-voz-sintetico-com-mais-de-32-caracteres';
const SEGREDO_WEBHOOK = 'webhook-de-voz-sintetico-com-mais-de-32-caracteres';

async function montar(t, { ativa = true } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const prompt = await serena.criarPrompt({ titulo: 'Voz', conteudo: 'Você é Serena e atende com segurança.' });
  await serena.publicarPrompt(prompt.id);
  const configuracao = configuracaoDeTeste({
    SERENA_VOZ_ATIVA: ativa ? 'sim' : 'nao',
    SERENA_VOZ_GATEWAY_URL: 'ws://voz.teste.local/v1/realtime',
    SERENA_VOZ_JWT_SECRET: SEGREDO_JWT,
    SERENA_VOZ_WEBHOOK_SECRET: SEGREDO_WEBHOOK,
  });
  const ambiente = await subirServidor({ repositorio, servicoDaSerena: serena, configuracao });
  t.after(() => ambiente.encerrar());
  return { ambiente, repositorio, serena };
}

test('laboratório nasce fechado e informa por quê', async (t) => {
  const { ambiente } = await montar(t, { ativa: false });
  const status = await (await ambiente.pedir('/api/serena/voz/status')).json();
  assert.equal(status.ativa, false);
  assert.equal(status.pronta, false);

  const tentativa = await ambiente.pedir('/api/serena/voz/sessoes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consentimento: true }),
  });
  assert.equal(tentativa.status, 503);
  assert.equal((await tentativa.json()).codigo, 'voz_desligada');
});

test('consentimento é obrigatório antes de emitir a sessão', async (t) => {
  const { ambiente } = await montar(t);
  const resposta = await ambiente.pedir('/api/serena/voz/sessoes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consentimento: false }),
  });
  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json()).codigo, 'consentimento_obrigatorio');
});

test('sessão curta entrega contexto do CRM e registra evento assinado uma vez', async (t) => {
  const { ambiente, repositorio } = await montar(t);
  const criada = await ambiente.pedir('/api/serena/voz/sessoes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consentimento: true }),
  });
  assert.equal(criada.status, 201);
  const sessao = await criada.json();
  const url = new URL(sessao.websocket_url);
  const token = url.searchParams.get('token');
  assert.ok(token);

  const contexto = await ambiente.pedirSemAuth('/api/serena/voz/contexto', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(contexto.status, 200);
  const contextoJson = await contexto.json();
  assert.equal(contextoJson.session_id, sessao.sessao_id);
  assert.match(contextoJson.instructions, /Você é Serena/);
  assert.equal(contextoJson.policy.persist_raw_audio, false);

  const evento = JSON.stringify({
    event_id: `evt:${crypto.randomUUID()}`,
    session_id: sessao.sessao_id,
    role: 'usuario', transcript: 'Olá, Serena.', occurred_at: new Date().toISOString(),
  });
  const instante = String(Math.floor(Date.now() / 1000));
  const assinatura = assinaturaDeEvento(Buffer.from(evento), instante, SEGREDO_WEBHOOK);
  const enviar = () => ambiente.pedirSemAuth('/api/serena/voz/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-serena-voz-timestamp': instante,
      'x-serena-voz-signature': `sha256=${assinatura}`,
    },
    body: evento,
  });
  assert.equal((await enviar()).status, 202);
  const duplicado = await enviar();
  assert.equal((await duplicado.json()).duplicado, true);
  assert.equal((await repositorio.listarTurnosDeVoz(sessao.sessao_id)).length, 1);

  const encerrada = await ambiente.pedir(`/api/serena/voz/sessoes/${sessao.sessao_id}/encerrar`, { method: 'POST' });
  assert.equal(encerrada.status, 200);
  assert.equal((await encerrada.json()).estado, 'encerrada');
});

test('evento sem assinatura válida nunca entra', async (t) => {
  const { ambiente } = await montar(t);
  const resposta = await ambiente.pedirSemAuth('/api/serena/voz/eventos', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(resposta.status, 401);
});
