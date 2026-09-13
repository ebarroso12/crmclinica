'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { criarWebPush, gerarChavesVapid, montarJwtVapid, base64url } = require('../src/seguranca/webpush');

// Aviso no celular (Web Push) — a parte que não dá para conferir olhando.
//
// O JWT VAPID é a credencial do empurrão: se a assinatura sair no formato
// errado, ou o `aud` não for a origem exata do endpoint, o serviço de push
// responde 401 e NENHUMA notificação chega — sem erro visível em lugar nenhum,
// porque o push é assíncrono e ninguém fica olhando o retorno.

function lerParte(jwt, indice) {
  const parte = jwt.split('.')[indice];
  return JSON.parse(Buffer.from(parte.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test('as chaves VAPID saem no formato que o navegador aceita', () => {
  const { publica, privada } = gerarChavesVapid();

  // applicationServerKey precisa ser o ponto não comprimido: 65 bytes, 0x04 na frente.
  const bytes = Buffer.from(publica.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(bytes.length, 65, 'a chave pública tem de ter 65 bytes');
  assert.equal(bytes[0], 0x04, 'ponto não comprimido começa com 0x04');

  // base64url não pode ter +, / nem =: eles quebram tanto o JWT quanto o
  // applicationServerKey.
  for (const chave of [publica, privada]) {
    assert.ok(!/[+/=]/.test(chave), `${chave.slice(0, 8)}… não pode ter +, / ou =`);
  }
});

test('o JWT é ES256 de verdade, e a assinatura confere com a chave pública', () => {
  const { publica, privada } = gerarChavesVapid();
  const jwt = montarJwtVapid({
    audiencia: 'https://fcm.googleapis.com',
    assunto: 'mailto:contato@exemplo',
    chavePrivada: privada,
  });

  assert.deepEqual(lerParte(jwt, 0), { typ: 'JWT', alg: 'ES256' });
  const corpo = lerParte(jwt, 1);
  assert.equal(corpo.aud, 'https://fcm.googleapis.com');
  assert.equal(corpo.sub, 'mailto:contato@exemplo');
  assert.ok(corpo.exp > Math.floor(Date.now() / 1000), 'o JWT não pode nascer expirado');
  // Teto da especificação: 24h.
  assert.ok(corpo.exp < Math.floor(Date.now() / 1000) + 24 * 60 * 60);

  // A verificação é o ponto: assinatura em formato bruto (r||s), não DER.
  const [cabecalho, corpoB64, assinatura] = jwt.split('.');
  const bytesPublica = Buffer.from(publica.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const chave = crypto.createPublicKey({
    key: Buffer.concat([
      // Prefixo SPKI de uma chave P-256, para remontar o DER a partir do ponto.
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      bytesPublica,
    ]),
    format: 'der',
    type: 'spki',
  });

  const confere = crypto.verify(
    'sha256',
    Buffer.from(`${cabecalho}.${corpoB64}`),
    { key: chave, dsaEncoding: 'ieee-p1363' },
    Buffer.from(assinatura.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  );
  assert.ok(confere, 'a assinatura precisa conferir com a chave pública enviada ao navegador');
});

test('o `aud` é a origem do endpoint, não a URL inteira', async () => {
  // Mandar a URL completa no `aud` é o erro clássico: o serviço responde 401 e
  // nenhuma notificação chega, sem erro visível em lugar nenhum.
  const { publica, privada } = gerarChavesVapid();
  const feitas = [];
  const push = criarWebPush({
    chavePublica: publica,
    chavePrivada: privada,
    assunto: 'mailto:x@y.z',
    buscar: async (url, opcoes) => { feitas.push({ url, opcoes }); return { status: 201 }; },
  });

  await push.empurrar('https://fcm.googleapis.com/fcm/send/abc123?x=1');

  const jwt = feitas[0].opcoes.headers.authorization.match(/t=([^,]+)/)[1];
  assert.equal(lerParte(jwt, 1).aud, 'https://fcm.googleapis.com');
  // E o POST vai para a URL completa, não para a origem.
  assert.equal(feitas[0].url, 'https://fcm.googleapis.com/fcm/send/abc123?x=1');
});

test('o empurrão não leva corpo: dado de paciente não vai para a tela de bloqueio', async () => {
  const { publica, privada } = gerarChavesVapid();
  const feitas = [];
  const push = criarWebPush({
    chavePublica: publica,
    chavePrivada: privada,
    assunto: 'mailto:x@y.z',
    buscar: async (url, opcoes) => { feitas.push({ url, opcoes }); return { status: 201 }; },
  });

  const resultado = await push.empurrar('https://updates.push.services.mozilla.com/wpush/v2/abc');

  assert.equal(resultado.entregue, true);
  assert.equal(feitas[0].opcoes.body, undefined, 'sem corpo — o aviso não carrega conteúdo');
  assert.equal(feitas[0].opcoes.headers['content-length'], '0');
  assert.match(feitas[0].opcoes.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.ok(feitas[0].opcoes.headers.ttl, 'TTL é obrigatório no Web Push');
});

test('404 e 410 mandam apagar a inscrição; o resto, não', async () => {
  const { publica, privada } = gerarChavesVapid();
  const comStatus = (status) => criarWebPush({
    chavePublica: publica, chavePrivada: privada, assunto: 'mailto:x@y.z',
    buscar: async () => ({ status }),
  });

  // Aparelho que desinstalou o app ou revogou a permissão: insistir é gastar
  // requisição para sempre.
  for (const status of [404, 410]) {
    const r = await comStatus(status).empurrar('https://push.exemplo/abc');
    assert.equal(r.remover, true, `${status} significa inscrição morta`);
  }
  // Excesso de envio ou erro do serviço: a inscrição continua boa.
  for (const status of [429, 500, 503]) {
    const r = await comStatus(status).empurrar('https://push.exemplo/abc');
    assert.equal(r.remover, false, `${status} não pode apagar a inscrição de ninguém`);
    assert.equal(r.entregue, false);
  }
});

test('rede fora não apaga inscrição, e sem VAPID configurado nada é enviado', async () => {
  const { publica, privada } = gerarChavesVapid();
  const caiu = criarWebPush({
    chavePublica: publica, chavePrivada: privada, assunto: 'mailto:x@y.z',
    buscar: async () => { throw new Error('ECONNRESET'); },
  });
  const r = await caiu.empurrar('https://push.exemplo/abc');
  assert.equal(r.entregue, false);
  assert.equal(r.remover, false, 'rede fora agora não quer dizer inscrição morta');

  const semChave = criarWebPush({});
  assert.equal(semChave.configurado, false);
  const semEnvio = await semChave.empurrar('https://push.exemplo/abc');
  assert.equal(semEnvio.motivo, 'vapid_nao_configurado');
});

test('endpoint que não é URL é descartado em vez de virar requisição', async () => {
  const { publica, privada } = gerarChavesVapid();
  const push = criarWebPush({
    chavePublica: publica, chavePrivada: privada, assunto: 'mailto:x@y.z',
    buscar: async () => { throw new Error('não deveria chegar aqui'); },
  });
  const r = await push.empurrar('isto-nao-e-url');
  assert.equal(r.remover, true);
  assert.equal(r.motivo, 'endpoint_invalido');
});

test('base64url não devolve o alfabeto padrão', () => {
  // Um único "+" ou "/" quebra o JWT no serviço de push.
  const bytes = Buffer.from([251, 255, 190, 254, 0, 1, 2, 3]);
  assert.ok(!/[+/=]/.test(base64url(bytes)));
});

test('inscrever precisa só da chave pública; enviar precisa da privada', async () => {
  // No crmclinica isso acontece em máquinas diferentes: a inscrição é servida
  // pela Vercel, o empurrão sai do worker no VPS. Exigir a privada nos dois
  // lugares seria espalhar segredo sem necessidade.
  const { publica } = gerarChavesVapid();

  const soPublica = criarWebPush({ chavePublica: publica });
  assert.equal(soPublica.podeInscrever, true, 'com a pública, dá para inscrever aparelho');
  assert.equal(soPublica.configurado, false, 'sem a privada, não dá para empurrar');
  assert.equal(soPublica.chavePublica, publica, 'a tela precisa receber a chave para inscrever');

  const naoEnvia = await soPublica.empurrar('https://push.exemplo/abc');
  assert.equal(naoEnvia.entregue, false);
  assert.equal(naoEnvia.motivo, 'vapid_nao_configurado');
  assert.equal(naoEnvia.remover, false, 'falta de chave aqui não pode apagar a inscrição de ninguém');

  const vazio = criarWebPush({});
  assert.equal(vazio.podeInscrever, false);
  assert.equal(vazio.chavePublica, null);
});
