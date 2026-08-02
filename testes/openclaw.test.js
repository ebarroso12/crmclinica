'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarClienteOpenClaw, assinar, assinaturaValida } = require('../src/integracoes/openclaw');
const { validarEvento } = require('../src/contratos/evento');

// Todos os testes usam credenciais sintéticas e um `fetch` falso.
// Nenhuma requisição sai da máquina e nenhum segredo real é lido.
const CONFIGURACAO = Object.freeze({
  baseUrl: 'https://orquestrador.invalido',
  token: 'token-sintetico-de-teste',
  sessao: 'sessao-de-teste',
  tempoLimiteMs: 1000,
});

function fetchFalso(resposta = { ok: true, status: 200, corpo: { recebido: true } }) {
  const chamadas = [];
  const fake = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return {
      ok: resposta.ok,
      status: resposta.status,
      json: async () => resposta.corpo,
    };
  };
  fake.chamadas = chamadas;
  return fake;
}

test('sem base ou token, o cliente se declara indisponível', () => {
  const semNada = criarClienteOpenClaw({ baseUrl: '', token: '', tempoLimiteMs: 1000 });
  assert.equal(semNada.disponivel, false);

  const semToken = criarClienteOpenClaw({ baseUrl: 'https://exemplo', token: '', tempoLimiteMs: 1000 });
  assert.equal(semToken.disponivel, false);
});

test('cliente indisponível recusa despacho com código próprio, sem tocar a rede', async () => {
  const fetch = fetchFalso();
  const cliente = criarClienteOpenClaw({ baseUrl: '', token: '', tempoLimiteMs: 1000 }, { fetch });

  await assert.rejects(
    () => cliente.despacharEvento({ chave_idempotencia: 'x' }),
    (erro) => erro.codigo === 'openclaw_nao_configurado',
  );
  assert.equal(fetch.chamadas.length, 0);
});

test('despacha o evento com credencial no cabeçalho e chave de idempotência no corpo', async () => {
  const fetch = fetchFalso();
  const cliente = criarClienteOpenClaw(CONFIGURACAO, { fetch });

  const evento = validarEvento({
    canal: 'whatsapp',
    id_externo: 'wa:1',
    remetente: '551199999999',
    texto: 'Olá',
  });

  const resultado = await cliente.despacharEvento(evento);
  assert.deepEqual(resultado, { recebido: true });
  assert.equal(fetch.chamadas.length, 1);

  const [chamada] = fetch.chamadas;
  assert.equal(chamada.url, 'https://orquestrador.invalido/eventos');
  assert.equal(chamada.opcoes.method, 'POST');
  assert.equal(chamada.opcoes.headers.authorization, 'Bearer token-sintetico-de-teste');
  assert.equal(chamada.opcoes.headers['x-openclaw-sessao'], 'sessao-de-teste');

  const corpo = JSON.parse(chamada.opcoes.body);
  assert.equal(corpo.chave_idempotencia, evento.chave_idempotencia);
  assert.equal(corpo.evento.canal, 'whatsapp');
});

test('resposta HTTP de erro vira erro identificável', async () => {
  const cliente = criarClienteOpenClaw(CONFIGURACAO, { fetch: fetchFalso({ ok: false, status: 502 }) });

  await assert.rejects(
    () => cliente.despacharEvento({ chave_idempotencia: 'x' }),
    (erro) => erro.codigo === 'openclaw_resposta_invalida' && erro.status === 502,
  );
});

test('verificarSaude traduz os estados sem derrubar o CRM', async () => {
  const naoConfigurado = criarClienteOpenClaw({ baseUrl: '', token: '', tempoLimiteMs: 1000 });
  assert.deepEqual(await naoConfigurado.verificarSaude(), { estado: 'nao_configurado' });

  const saudavel = criarClienteOpenClaw(CONFIGURACAO, { fetch: fetchFalso() });
  assert.deepEqual(await saudavel.verificarSaude(), { estado: 'operacional' });

  const degradado = criarClienteOpenClaw(CONFIGURACAO, { fetch: fetchFalso({ ok: false, status: 500 }) });
  assert.deepEqual(await degradado.verificarSaude(), { estado: 'degradado' });

  // Orquestrador fora do ar não pode propagar exceção para dentro do CRM.
  const foraDoAr = criarClienteOpenClaw(CONFIGURACAO, {
    fetch: async () => { throw new Error('conexão recusada'); },
  });
  assert.deepEqual(await foraDoAr.verificarSaude(), { estado: 'indisponivel' });
});

test('verificação de assinatura aceita a correta e recusa o resto', () => {
  const segredo = 'segredo-sintetico-de-teste-para-hmac';
  const corpo = '{"canal":"whatsapp"}';
  const correta = assinar(corpo, segredo);

  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo }), true);
  // O prefixo sha256= é opcional na recepção.
  assert.equal(
    assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta.replace('sha256=', ''), segredo }),
    true,
  );

  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo: 'outro' }), false);
  assert.equal(assinaturaValida({ corpoBruto: '{"canal":"site"}', assinaturaRecebida: correta, segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: '', segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: 'curta', segredo }), false);
  assert.equal(assinaturaValida({ corpoBruto: corpo, assinaturaRecebida: correta, segredo: '' }), false);
});
