'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { descobrirIp, ehProxyConfiavel, normalizar } = require('../src/servidor/ip');

/** Requisição de mentira, só com o que `descobrirIp` lê. */
function requisicao(remoteAddress, encaminhado = null) {
  return {
    socket: { remoteAddress },
    headers: encaminhado ? { 'x-forwarded-for': encaminhado } : {},
  };
}

// ---------------------------------------------------------------- normalização

test('IPv4 mapeado em IPv6 vira a forma simples', () => {
  assert.equal(normalizar('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizar('::FFFF:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizar('10.0.0.1'), '10.0.0.1');
  assert.equal(normalizar('  10.0.0.1  '), '10.0.0.1');
  assert.equal(normalizar('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizar(null), null);
});

// ---------------------------------------------------------------- proxy confiável

test('IP exato e faixa CIDR são reconhecidos', () => {
  assert.equal(ehProxyConfiavel('10.0.0.5', ['10.0.0.5']), true);
  assert.equal(ehProxyConfiavel('10.0.0.5', ['10.0.0.0/8']), true);
  assert.equal(ehProxyConfiavel('10.0.0.5', ['10.0.0.0/24']), true);
  assert.equal(ehProxyConfiavel('10.0.1.5', ['10.0.0.0/24']), false);
  assert.equal(ehProxyConfiavel('172.16.0.1', ['10.0.0.0/8']), false);
});

test('lista vazia não confia em ninguém', () => {
  assert.equal(ehProxyConfiavel('10.0.0.5', []), false);
  assert.equal(ehProxyConfiavel('10.0.0.5'), false);
});

test('faixa malformada não vira permissão', () => {
  assert.equal(ehProxyConfiavel('10.0.0.5', ['10.0.0.0/99']), false);
  assert.equal(ehProxyConfiavel('10.0.0.5', ['nada']), false);
  assert.equal(ehProxyConfiavel('10.0.0.5', ['']), false);
});

// ---------------------------------------------------------------- sem proxy

test('sem proxy declarado, o cabeçalho é ignorado', () => {
  // É o ponto central: confiar no cabeçalho de qualquer origem permitiria
  // forjar o IP escrevendo qualquer coisa e burlar o limite de tentativas.
  const req = requisicao('203.0.113.9', '1.2.3.4');
  assert.equal(descobrirIp(req, []), '203.0.113.9');
});

test('conexão direta devolve o IP da conexão', () => {
  assert.equal(descobrirIp(requisicao('203.0.113.9'), []), '203.0.113.9');
  assert.equal(descobrirIp(requisicao('::ffff:203.0.113.9'), []), '203.0.113.9');
});

test('sem socket, devolve null em vez de quebrar', () => {
  assert.equal(descobrirIp({}, []), null);
  assert.equal(descobrirIp({ socket: {} }, []), null);
  assert.equal(descobrirIp(null, []), null);
});

// ---------------------------------------------------------------- com proxy

test('atrás de proxy confiável, o cliente vem do cabeçalho', () => {
  const req = requisicao('10.0.0.5', '203.0.113.9');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '203.0.113.9');
});

test('cadeia de proxies: o cliente é o primeiro que não é proxy nosso', () => {
  // `X-Forwarded-For: cliente, proxy-de-borda, proxy-interno`
  const req = requisicao('10.0.0.5', '203.0.113.9, 10.0.0.9, 10.0.0.8');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '203.0.113.9');
});

test('o cliente não escolhe o próprio IP escrevendo na frente da lista', () => {
  // Um atacante manda `X-Forwarded-For: 1.2.3.4` de dentro; o proxy acrescenta o
  // IP real dele. Percorrer da direita para a esquerda pega o real, não o forjado.
  const req = requisicao('10.0.0.5', '1.2.3.4, 203.0.113.9');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '203.0.113.9');
});

test('cadeia só de proxies confiáveis cai no IP da conexão', () => {
  const req = requisicao('10.0.0.5', '10.0.0.9, 10.0.0.8');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '10.0.0.5');
});

test('cabeçalho vazio ou com lixo não derruba a descoberta', () => {
  assert.equal(descobrirIp(requisicao('10.0.0.5', ''), ['10.0.0.0/8']), '10.0.0.5');
  assert.equal(descobrirIp(requisicao('10.0.0.5', 'nada, aqui'), ['10.0.0.0/8']), '10.0.0.5');
  assert.equal(descobrirIp(requisicao('10.0.0.5', 'lixo, 203.0.113.9'), ['10.0.0.0/8']), '203.0.113.9');
});

test('proxy não declarado não tem o cabeçalho lido, mesmo parecendo interno', () => {
  // 172.16.0.1 é endereço privado, mas não está na lista: o cabeçalho é ignorado.
  const req = requisicao('172.16.0.1', '203.0.113.9');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '172.16.0.1');
});

test('IPv6 no cabeçalho é aceito', () => {
  const req = requisicao('10.0.0.5', '2001:db8::1');
  assert.equal(descobrirIp(req, ['10.0.0.0/8']), '2001:db8::1');
});
