'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  criarClienteGateway, carregarOuCriarIdentidade, descreverIdentidade, gerarIdentidade,
  montarPayloadDeAssinatura, derivarDeviceId, chavePublicaCrua, base64url,
  PROTOCOLO, ESCOPOS, CLIENTE_ID, CLIENTE_MODO, PAPEL,
} = require('../src/integracoes/openclaw-gateway');

// O protocolo do gateway OpenClaw, sem rede.
//
// Um WebSocket falso responde o desafio e confere o que o cliente manda. É o
// mesmo tráfego que sai contra o gateway real — e é aqui que se prova que a
// assinatura do dispositivo está no formato exato que o servidor verifica.
// Um byte fora de ordem no payload assinado resulta em `NOT_PAIRED` em
// produção, e nenhum log diz por quê.

/** WebSocket falso: registra o que o cliente envia e responde como o gateway. */
function socketFalso({ respostas = {}, aoEnviar = null } = {}) {
  const enviados = [];
  const ouvintes = new Map();

  const socket = {
    readyState: 1,
    enviados,
    addEventListener(evento, fn) {
      if (!ouvintes.has(evento)) ouvintes.set(evento, []);
      ouvintes.get(evento).push(fn);
    },
    emitir(evento, dados) {
      for (const fn of ouvintes.get(evento) ?? []) fn(dados);
    },
    send(bruto) {
      const quadro = JSON.parse(bruto);
      enviados.push(quadro);
      aoEnviar?.(quadro, socket);

      const resposta = respostas[quadro.method];
      if (resposta === undefined) return;

      queueMicrotask(() => {
        const valor = typeof resposta === 'function' ? resposta(quadro) : resposta;
        socket.emitir('message', {
          data: JSON.stringify(
            valor?.erro
              ? { type: 'res', id: quadro.id, ok: false, error: valor.erro }
              : { type: 'res', id: quadro.id, ok: true, payload: valor },
          ),
        });
      });
    },
    close() { socket.readyState = 3; },
  };

  return socket;
}

/** Monta o cliente com o socket falso e dispara o desafio, como o gateway faz. */
function montarCliente({ socket, ...opcoes }) {
  const identidade = opcoes.identidade ?? gerarIdentidade();
  const cliente = criarClienteGateway({
    url: 'wss://gateway.teste/ws',
    token: 'token-de-teste',
    identidade,
    timeoutMs: 2000,
    WebSocketImpl: function FalsoWebSocket() { return socket; },
    ...opcoes,
  });
  return { cliente, identidade };
}

function dispararDesafio(socket, nonce = 'nonce-de-teste') {
  queueMicrotask(() => socket.emitir('message', {
    data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce, ts: Date.now() } }),
  }));
}

const HELLO = { type: 'hello-ok', protocol: 4, auth: { role: 'operator', scopes: [...ESCOPOS], deviceToken: 'dt-1' } };

// ---------------------------------------------------------------- identidade

test('o deviceId é derivado da chave pública — não é escolhido', () => {
  const identidade = gerarIdentidade();
  assert.equal(identidade.deviceId, derivarDeviceId(identidade.publicKeyPem));
  assert.match(identidade.deviceId, /^[0-9a-f]{64}$/);

  // Outra chave, outro dispositivo.
  assert.notEqual(identidade.deviceId, gerarIdentidade().deviceId);
});

test('a chave pública sai como os 32 bytes crus, sem o envelope SPKI', () => {
  const identidade = gerarIdentidade();
  assert.equal(chavePublicaCrua(identidade.publicKeyPem).length, 32);
  assert.equal(descreverIdentidade(identidade).publicKey, base64url(chavePublicaCrua(identidade.publicKeyPem)));
});

test('a identidade em arquivo é criada uma vez e reaproveitada', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crmclinica-identidade-'));
  const arquivo = path.join(pasta, 'device.json');

  const primeira = carregarOuCriarIdentidade(arquivo);
  assert.equal(primeira.origem, 'gerada agora');
  assert.ok(fs.existsSync(arquivo));

  const segunda = carregarOuCriarIdentidade(arquivo);
  assert.equal(segunda.deviceId, primeira.deviceId, 'parear de novo a cada reinício seria inaceitável');
  assert.match(segunda.origem, /^arquivo/);

  fs.rmSync(pasta, { recursive: true, force: true });
});

test('a chave vinda do ambiente vence o arquivo — é o caminho de produção', () => {
  const identidade = gerarIdentidade();
  const doAmbiente = carregarOuCriarIdentidade('/caminho/que/nao/existe.json', identidade.privateKeyPem);

  assert.equal(doAmbiente.deviceId, identidade.deviceId);
  assert.equal(doAmbiente.origem, 'ambiente');
});

test('a descrição da identidade não carrega a chave privada', () => {
  const retrato = descreverIdentidade(gerarIdentidade());
  assert.deepEqual(Object.keys(retrato).sort(), ['deviceId', 'origem', 'publicKey']);
  assert.doesNotMatch(JSON.stringify(retrato), /PRIVATE KEY/);
});

// ---------------------------------------------------------------- assinatura

test('o payload assinado é posicional e na ordem exata do gateway', () => {
  // Formato v3 lido de `buildDeviceAuthPayloadV3` na instalação oficial. Um
  // campo fora de ordem produz assinatura que não confere, e o gateway responde
  // NOT_PAIRED sem dizer por quê.
  const payload = montarPayloadDeAssinatura({
    deviceId: 'dev1', clientId: 'gateway-client', clientMode: 'backend',
    role: 'operator', scopes: ['operator.read', 'operator.write'],
    signedAtMs: 1700000000000, token: 'tok', nonce: 'n1', platform: 'Win32',
  });

  assert.equal(
    payload,
    'v3|dev1|gateway-client|backend|operator|operator.read,operator.write|1700000000000|tok|n1|win32|',
  );
});

test('plataforma e família de dispositivo vão em minúsculas', () => {
  // O gateway normaliza os dois antes de conferir. Assinar com "Win32" faria a
  // verificação falhar em toda máquina Windows — e só lá.
  const payload = montarPayloadDeAssinatura({
    deviceId: 'd', clientId: 'c', clientMode: 'backend', role: 'operator',
    scopes: [], signedAtMs: 1, token: null, nonce: 'n', platform: 'DARWIN', deviceFamily: 'Mac',
  });
  assert.ok(payload.endsWith('|darwin|mac'));
  // Token ausente vira string vazia, não "null".
  assert.ok(payload.includes('|1||n|'));
});

test('a assinatura enviada confere com a chave pública declarada', async () => {
  const socket = socketFalso({ respostas: { connect: HELLO } });
  const { cliente, identidade } = montarCliente({ socket });

  dispararDesafio(socket, 'nonce-abc');
  await cliente.conectar();

  const connect = socket.enviados.find((q) => q.method === 'connect');
  const { device, client, role, scopes } = connect.params;

  assert.equal(connect.params.minProtocol, PROTOCOLO);
  assert.equal(client.id, CLIENTE_ID);
  assert.equal(client.mode, CLIENTE_MODO);
  assert.equal(role, PAPEL);
  assert.deepEqual(scopes, [...ESCOPOS]);
  assert.equal(device.id, identidade.deviceId);
  assert.equal(device.nonce, 'nonce-abc');

  // A verificação que o gateway faz, feita aqui: mesma reconstrução, mesma chave.
  const payload = montarPayloadDeAssinatura({
    deviceId: identidade.deviceId,
    clientId: CLIENTE_ID,
    clientMode: CLIENTE_MODO,
    role: PAPEL,
    scopes: [...ESCOPOS],
    signedAtMs: device.signedAt,
    token: 'token-de-teste',
    nonce: 'nonce-abc',
    platform: process.platform,
  });

  const deBase64Url = (valor) => Buffer.from(valor.replaceAll('-', '+').replaceAll('_', '/'), 'base64');

  const assinaturaOk = crypto.verify(
    null,
    Buffer.from(payload, 'utf8'),
    crypto.createPublicKey(identidade.publicKeyPem),
    deBase64Url(device.signature),
  );
  assert.ok(assinaturaOk, 'o gateway precisa conseguir verificar esta assinatura');

  // A chave declarada é a mesma que assinou: o gateway confere as duas coisas.
  assert.deepEqual(deBase64Url(device.publicKey), chavePublicaCrua(identidade.publicKeyPem));

  await cliente.encerrar();
});

test('o token da assinatura acompanha o de autenticação, com deviceToken como alternativa', async () => {
  const socket = socketFalso({ respostas: { connect: HELLO } });
  const { cliente } = montarCliente({ socket, token: null, deviceToken: 'dt-guardado' });

  dispararDesafio(socket);
  await cliente.conectar();

  const connect = socket.enviados.find((q) => q.method === 'connect');
  assert.deepEqual(connect.params.auth, { deviceToken: 'dt-guardado' });
  await cliente.encerrar();
});

// ---------------------------------------------------------------- chamadas

test('a conexão é reaproveitada entre chamadas', async () => {
  const socket = socketFalso({ respostas: { connect: HELLO, 'channels.status': { channels: {} } } });
  const { cliente } = montarCliente({ socket });

  dispararDesafio(socket);
  await cliente.chamar('channels.status', {});
  await cliente.chamar('channels.status', {});

  // Um handshake só: refazê-lo a cada lembrete transformaria um lote de vinte
  // mensagens em vinte handshakes com assinatura.
  assert.equal(socket.enviados.filter((q) => q.method === 'connect').length, 1);
  assert.equal(socket.enviados.filter((q) => q.method === 'channels.status').length, 2);
  await cliente.encerrar();
});

test('erro do gateway vira erro nomeado, com o código preservado', async () => {
  const socket = socketFalso({
    respostas: {
      connect: HELLO,
      send: { erro: { code: 'UNAVAILABLE', message: 'canal fora do ar' } },
    },
  });
  const { cliente } = montarCliente({ socket });

  dispararDesafio(socket);
  await assert.rejects(() => cliente.chamar('send', {}), (erro) => {
    assert.equal(erro.codigo, 'gateway_unavailable');
    assert.equal(erro.permanente, false, 'indisponibilidade passa — vale tentar de novo');
    return true;
  });
  await cliente.encerrar();
});

test('dispositivo não pareado é reconhecido e marcado como permanente', async () => {
  const socket = socketFalso({
    respostas: {
      connect: {
        erro: {
          code: 'NOT_PAIRED',
          message: 'pairing required: device is not approved yet',
          details: { requestId: 'req-42' },
        },
      },
    },
  });
  const { cliente } = montarCliente({ socket });

  dispararDesafio(socket);
  await assert.rejects(() => cliente.conectar(), (erro) => {
    assert.equal(erro.codigo, 'openclaw_nao_pareado');
    // Insistir não aprova ninguém: alguém precisa rodar `devices approve`.
    assert.equal(erro.permanente, true);
    assert.equal(erro.requestId, 'req-42');
    return true;
  });
});

test('falta de escopo é permanente — pedir de novo não concede', async () => {
  const socket = socketFalso({
    respostas: {
      connect: HELLO,
      send: { erro: { code: 'INVALID_REQUEST', message: 'missing scope: operator.write' } },
    },
  });
  const { cliente } = montarCliente({ socket });

  dispararDesafio(socket);
  await assert.rejects(() => cliente.chamar('send', {}), (erro) => {
    assert.equal(erro.permanente, true);
    return true;
  });
  await cliente.encerrar();
});

test('sem resposta, a chamada estoura por timeout — e timeout não é sucesso', async () => {
  // O gateway aceita a requisição e nunca responde. Quem chamou precisa tratar
  // isso como incerto; dizer "enviado" aqui seria inventar uma confirmação.
  const socket = socketFalso({ respostas: { connect: HELLO } });
  const { cliente } = montarCliente({ socket, timeoutMs: 120 });

  dispararDesafio(socket);
  await cliente.conectar();

  await assert.rejects(() => cliente.chamar('send', {}), (erro) => {
    assert.equal(erro.codigo, 'gateway_timeout');
    return true;
  });
  await cliente.encerrar();
});

test('conexão fechada no meio rejeita o que estava pendente', async () => {
  const socket = socketFalso({ respostas: { connect: HELLO } });
  const { cliente } = montarCliente({ socket });

  dispararDesafio(socket);
  await cliente.conectar();

  const pendente = cliente.chamar('send', {});
  socket.emitir('close', { code: 1006, reason: 'queda' });

  await assert.rejects(() => pendente, (erro) => {
    assert.equal(erro.codigo, 'gateway_desconectado');
    return true;
  });
});

test('sem URL ou sem identidade, o cliente nem é montado', () => {
  assert.throws(() => criarClienteGateway({ identidade: gerarIdentidade() }), /URL/);
  assert.throws(() => criarClienteGateway({ url: 'wss://x/ws' }), /identidade/);
});
