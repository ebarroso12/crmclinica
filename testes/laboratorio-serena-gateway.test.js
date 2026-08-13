'use strict';

// Comando 5, frente 10 — o laboratório "Testar Serena" tinha um único ponto
// de falha: sem o gateway da CLÍNICA configurado, `abrirTeste`/`enviarNoTeste`
// lançavam 503 (canal_nao_configurado), mesmo com o gateway de COMANDO
// (o que o atendimento real usa) disponível.
//
// Achado da investigação: a Evolution API não serve de reserva aqui — ela só
// transporta WhatsApp, não gera texto. Quem gera a resposta da Serena é
// sempre uma sessão OpenClaw. `escolherConfiguracaoDoLaboratorio` aplica o
// MESMO padrão de canal-conversas.js (principal, depois reserva) aos dois
// gateways de sessão que já existem no sistema.

const test = require('node:test');
const assert = require('node:assert/strict');
const { escolherConfiguracaoDoLaboratorio } = require('../src/integracoes/openclaw-conversa');

const CANAL_CLINICA = Object.freeze({ url: 'wss://openclaw.exemplo/ws', token: 'token-clinica' });
const COMANDO = Object.freeze({ url: 'wss://openclaw.exemplo/ws', deviceToken: 'device-comando' });

test('só o gateway da clínica configurado: usa a clínica (comportamento existente)', () => {
  const escolhido = escolherConfiguracaoDoLaboratorio({ canalClinica: CANAL_CLINICA, comando: {} });
  assert.equal(escolhido, CANAL_CLINICA);
});

test('só o gateway de comando configurado: cai para ele — não é mais 503 por padrão', () => {
  const escolhido = escolherConfiguracaoDoLaboratorio({ canalClinica: {}, comando: COMANDO });
  assert.equal(escolhido, COMANDO);
});

test('os dois configurados: a clínica é o principal', () => {
  const escolhido = escolherConfiguracaoDoLaboratorio({ canalClinica: CANAL_CLINICA, comando: COMANDO });
  assert.equal(escolhido, CANAL_CLINICA);
});

test('nenhum configurado: null — o 503 continua sendo a resposta correta', () => {
  assert.equal(escolherConfiguracaoDoLaboratorio({ canalClinica: {}, comando: {} }), null);
  assert.equal(escolherConfiguracaoDoLaboratorio({}), null);
  assert.equal(escolherConfiguracaoDoLaboratorio(), null);
});

test('"configurado" exige url — token sozinho não basta', () => {
  const escolhido = escolherConfiguracaoDoLaboratorio({
    canalClinica: { token: 'sem-url' }, comando: { deviceToken: 'sem-url-tambem' },
  });
  assert.equal(escolhido, null);
});
