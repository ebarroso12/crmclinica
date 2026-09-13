'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { criarWebPush, gerarChavesVapid, cifrarParaAparelho } = require('../src/seguranca/webpush');

// O conteúdo da notificação, cifrado (RFC 8291 sobre RFC 8188).
//
// Aqui não há como "olhar e ver se está certo": se um byte sair fora de ordem,
// o navegador DESCARTA a mensagem em silêncio — sem erro no servidor, sem erro
// no aparelho, sem nada no log. O celular simplesmente não toca, e ninguém
// descobre por quê.
//
// Por isso a prova é dupla: o vetor oficial do RFC, e a ida e volta com um
// aparelho aleatório (cifrar aqui, decifrar como o navegador faria).

const deBase64url = (texto) => {
  const normal = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normal + '='.repeat((4 - (normal.length % 4)) % 4), 'base64');
};
const paraBase64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// O separador é o byte ZERO, não um espaço: a especificação termina cada
// rótulo com NUL.
const NUL = Buffer.from([0]);
const INFO_CEK = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'utf8'), NUL]);
const INFO_NONCE = Buffer.concat([Buffer.from('Content-Encoding: nonce', 'utf8'), NUL]);
const INFO_CHAVE = Buffer.concat([Buffer.from('WebPush: info', 'utf8'), NUL]);

/** Exatamente o que o navegador faz ao receber o empurrão. */
function decifrarComoNavegador(corpo, { privadaDoAparelho, publicaDoAparelho, auth }) {
  const sal = corpo.subarray(0, 16);
  const tamanhoDaChave = corpo[20];
  const publicaDoServidor = corpo.subarray(21, 21 + tamanhoDaChave);
  const cifrado = corpo.subarray(21 + tamanhoDaChave);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(deBase64url(privadaDoAparelho));
  const segredo = ecdh.computeSecret(publicaDoServidor);

  const infoDaChave = Buffer.concat([INFO_CHAVE, deBase64url(publicaDoAparelho), publicaDoServidor]);
  const ikm = crypto.hkdfSync('sha256', segredo, deBase64url(auth), infoDaChave, 32);
  const cek = crypto.hkdfSync('sha256', ikm, sal, INFO_CEK, 16);
  const nonce = crypto.hkdfSync('sha256', ikm, sal, INFO_NONCE, 12);

  const decifrador = crypto.createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  decifrador.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const aberto = Buffer.concat([
    decifrador.update(cifrado.subarray(0, cifrado.length - 16)),
    decifrador.final(),
  ]);
  // O último byte é o 0x02 que marca "último registro" (RFC 8188).
  assert.equal(aberto[aberto.length - 1], 0x02, 'falta o marcador de último registro');
  return aberto.subarray(0, aberto.length - 1).toString('utf8');
}

// Apêndice A do RFC 8291.
const VETOR = {
  texto: 'When I grow up, I want to be a watermelon',
  asPrivada: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublica: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivada: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  sal: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

test('o vetor oficial do RFC 8291 decifra de volta ao texto original', () => {
  const efemera = crypto.createECDH('prime256v1');
  efemera.setPrivateKey(deBase64url(VETOR.asPrivada));

  const corpo = cifrarParaAparelho(VETOR.texto, {
    p256dh: VETOR.uaPublica,
    auth: VETOR.auth,
    chaveEfemera: efemera,
    sal: deBase64url(VETOR.sal),
  });

  // O cabeçalho tem forma fixa: sal(16) + tamanho(4) + 1 + chave(65).
  assert.equal(corpo.subarray(0, 16).toString('hex'), deBase64url(VETOR.sal).toString('hex'));
  assert.equal(corpo.readUInt32BE(16), 4096, 'tamanho do registro');
  assert.equal(corpo[20], 65, 'a chave pública efêmera tem 65 bytes');

  assert.equal(
    decifrarComoNavegador(corpo, {
      privadaDoAparelho: VETOR.uaPrivada,
      publicaDoAparelho: VETOR.uaPublica,
      auth: VETOR.auth,
    }),
    VETOR.texto,
  );
});

test('ida e volta com um aparelho novo, texto com acento', () => {
  const aparelho = crypto.createECDH('prime256v1');
  aparelho.generateKeys();
  const auth = paraBase64url(crypto.randomBytes(16));

  const conteudo = JSON.stringify({
    titulo: 'Maria das Dores',
    corpo: 'Preciso remarcar minha consulta — é urgente?',
    url: '/?conversa=42',
  });

  const corpo = cifrarParaAparelho(conteudo, {
    p256dh: paraBase64url(aparelho.getPublicKey()),
    auth,
  });

  const voltou = decifrarComoNavegador(corpo, {
    privadaDoAparelho: paraBase64url(aparelho.getPrivateKey()),
    publicaDoAparelho: paraBase64url(aparelho.getPublicKey()),
    auth,
  });
  assert.equal(voltou, conteudo);
  assert.equal(JSON.parse(voltou).titulo, 'Maria das Dores');
});

test('cada envio usa chave e sal novos — repetir quebraria o AES-GCM', () => {
  const aparelho = crypto.createECDH('prime256v1');
  aparelho.generateKeys();
  const chaves = {
    p256dh: paraBase64url(aparelho.getPublicKey()),
    auth: paraBase64url(crypto.randomBytes(16)),
  };

  const um = cifrarParaAparelho('mesmo texto', chaves);
  const outro = cifrarParaAparelho('mesmo texto', chaves);

  assert.notEqual(um.subarray(0, 16).toString('hex'), outro.subarray(0, 16).toString('hex'), 'sal precisa ser novo');
  assert.notEqual(um.subarray(21, 86).toString('hex'), outro.subarray(21, 86).toString('hex'), 'chave efêmera precisa ser nova');
  assert.notEqual(um.toString('hex'), outro.toString('hex'));
});

test('o empurrão com conteúdo vai como aes128gcm, com corpo e tamanho certos', async () => {
  const { publica, privada } = gerarChavesVapid();
  const aparelho = crypto.createECDH('prime256v1');
  aparelho.generateKeys();

  const feitas = [];
  const push = criarWebPush({
    chavePublica: publica,
    chavePrivada: privada,
    assunto: 'mailto:x@y.z',
    buscar: async (url, opcoes) => { feitas.push({ url, opcoes }); return { status: 201 }; },
  });

  const resultado = await push.empurrar('https://fcm.googleapis.com/fcm/send/abc', {
    conteudo: { titulo: 'Fulana', corpo: 'oi', url: '/' },
    aparelho: {
      p256dh: paraBase64url(aparelho.getPublicKey()),
      auth: paraBase64url(crypto.randomBytes(16)),
    },
  });

  assert.equal(resultado.entregue, true);
  const { headers, body } = feitas[0].opcoes;
  assert.equal(headers['content-encoding'], 'aes128gcm', 'sem este cabeçalho o navegador não sabe decifrar');
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.ok(Buffer.isBuffer(body));
  assert.equal(headers['content-length'], String(body.length));
  // Cabeçalho + pelo menos a tag do GCM.
  assert.ok(body.length > 16 + 4 + 1 + 65 + 16);
});

test('chave malformada na inscrição não vira mensagem em claro: a inscrição é descartada', async () => {
  const { publica, privada } = gerarChavesVapid();
  const push = criarWebPush({
    chavePublica: publica,
    chavePrivada: privada,
    assunto: 'mailto:x@y.z',
    buscar: async () => { throw new Error('não deveria chegar à rede'); },
  });

  const resultado = await push.empurrar('https://push.exemplo/abc', {
    conteudo: { titulo: 'x', corpo: 'y' },
    aparelho: { p256dh: 'isto-nao-e-chave', auth: 'nem-isto' },
  });

  assert.equal(resultado.entregue, false);
  assert.equal(resultado.remover, true, 'inscrição que não dá para cifrar não serve mais');
  assert.match(resultado.motivo, /nao cifrei/);
});

test('sem conteúdo, o empurrão continua indo vazio (compatível com o envio antigo)', async () => {
  const { publica, privada } = gerarChavesVapid();
  const feitas = [];
  const push = criarWebPush({
    chavePublica: publica,
    chavePrivada: privada,
    assunto: 'mailto:x@y.z',
    buscar: async (url, opcoes) => { feitas.push(opcoes); return { status: 201 }; },
  });

  await push.empurrar('https://push.exemplo/abc');
  assert.equal(feitas[0].body, undefined);
  assert.equal(feitas[0].headers['content-length'], '0');
  assert.equal(feitas[0].headers['content-encoding'], undefined);
});
