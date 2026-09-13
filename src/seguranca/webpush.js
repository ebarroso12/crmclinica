'use strict';

const crypto = require('node:crypto');

// Aviso no celular (Web Push), sem dependência nenhuma.
//
// O navegador registra uma "inscrição" (endpoint + chaves) e o servidor manda um
// POST para esse endpoint, assinado com VAPID — um JWT ES256 que prova que quem
// empurra é o dono da chave pública que o navegador recebeu na inscrição.
//
// O empurrão pode ir COM ou SEM conteúdo, e a diferença é importante.
//
// Sem conteúdo, o aviso diz só que há novidade. Com conteúdo, ele diz quem
// falou e o começo da mensagem — como a notificação do Gmail, que foi o pedido
// do Dr. Edson em 12/09/2026 depois de ver a primeira versão muda.
//
// O que isso custa, dito com todas as letras: a notificação aparece na tela de
// bloqueio, à vista de quem estiver por perto do aparelho. "Maria Silva:
// preciso remarcar minha consulta" na tela travada é informação clínica exposta
// a quem passar pelo balcão. Quem decidiu assumir esse risco foi o dono da
// clínica, sabendo dele; o CRM continua sem mandar diagnóstico, CID ou
// resultado de exame na notificação — só quem falou e o começo do que disse.
//
// O conteúdo atravessa o serviço de push (Google, Mozilla, Apple) CIFRADO: o
// intermediário entrega, não lê. Ver cifrarParaAparelho abaixo.

const VALIDADE_DO_JWT_SEGUNDOS = 12 * 60 * 60; // 12h — o teto da especificação é 24h.

// ---------------------------------------------------------------------------
// Conteúdo cifrado (RFC 8291 sobre RFC 8188)
//
// O serviço de push (Google, Mozilla, Apple) entrega o empurrão mas NÃO pode
// ler o que vai dentro: quem cifra é este servidor, quem decifra é o navegador
// do aparelho, e a chave sai de um acordo entre os dois (ECDH) usando as duas
// chaves que o navegador entregou na inscrição — `p256dh` e `auth`.
//
// Isso importa aqui mais do que no site comum: o texto que vai na notificação
// tem nome de paciente. Ele atravessa a Google, e atravessa ilegível.
//
// A implementação segue o RFC à risca e é conferida contra o vetor oficial do
// Apêndice A em testes/webpush.test.js — se um byte sair fora de ordem, o
// navegador descarta a mensagem em silêncio e ninguém descobre por quê.

const TAMANHO_DO_REGISTRO = 4096;

// Cada rótulo da derivação termina em byte ZERO (não espaço, não nada): trocar
// isso daria outra chave, a mensagem chegaria ao aparelho e o navegador a
// descartaria sem dizer nada a ninguém.
const FIM_DO_ROTULO = Buffer.from([0]);

/** base64url de volta para bytes. */
function deBase64url(texto) {
  const normal = String(texto).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normal + '='.repeat((4 - (normal.length % 4)) % 4), 'base64');
}

/**
 * Cifra o texto para UM aparelho.
 *
 * `chaveEfemera` e `sal` são injetáveis só para o teste poder reproduzir o
 * vetor do RFC; em produção nascem aleatórios a cada envio — repetir o par
 * (chave, sal) quebraria a garantia do AES-GCM.
 */
function cifrarParaAparelho(texto, { p256dh, auth, chaveEfemera = null, sal = null }) {
  const chaveDoAparelho = deBase64url(p256dh);
  const segredoDoAparelho = deBase64url(auth);

  const efemera = chaveEfemera ?? crypto.createECDH('prime256v1');
  if (!chaveEfemera) efemera.generateKeys();
  const publicaDoServidor = efemera.getPublicKey();

  // O segredo que só os dois lados conseguem calcular.
  const segredoCompartilhado = efemera.computeSecret(chaveDoAparelho);

  // RFC 8291: o "auth" da inscrição entra como sal desta primeira derivação, e
  // as DUAS chaves públicas entram no info — é isso que amarra a mensagem a
  // este aparelho e a este envio.
  const infoDaChave = Buffer.concat([
    Buffer.concat([Buffer.from('WebPush: info', 'utf8'), FIM_DO_ROTULO]),
    chaveDoAparelho,
    publicaDoServidor,
  ]);
  const ikm = crypto.hkdfSync('sha256', segredoCompartilhado, segredoDoAparelho, infoDaChave, 32);

  const salDoRegistro = sal ?? crypto.randomBytes(16);
  const chaveDeConteudo = crypto.hkdfSync('sha256', ikm, salDoRegistro, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'utf8'), FIM_DO_ROTULO]), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salDoRegistro, Buffer.concat([Buffer.from('Content-Encoding: nonce', 'utf8'), FIM_DO_ROTULO]), 12);

  // 0x02 marca "este é o último registro" (RFC 8188). Sem ele, o navegador
  // espera um próximo pedaço que nunca vem.
  const conteudo = Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([0x02])]);

  const cifrador = crypto.createCipheriv('aes-128-gcm', Buffer.from(chaveDeConteudo), Buffer.from(nonce));
  const cifrado = Buffer.concat([cifrador.update(conteudo), cifrador.final(), cifrador.getAuthTag()]);

  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(TAMANHO_DO_REGISTRO, 0);

  // O cabeçalho vai junto do corpo: sal, tamanho do registro, e a chave pública
  // efêmera que o navegador precisa para refazer o acordo.
  return Buffer.concat([
    salDoRegistro,
    tamanho,
    Buffer.from([publicaDoServidor.length]),
    publicaDoServidor,
    cifrado,
  ]);
}



/** base64url sem padding, que é o alfabeto do JWT e das chaves VAPID. */
function base64url(dados) {
  return Buffer.from(dados).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Gera o par de chaves VAPID. Roda uma vez na vida do sistema; a pública vai
 * para o navegador, a privada fica em variável de ambiente no servidor.
 */
function gerarChavesVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // A pública precisa ir no formato de ponto não comprimido (65 bytes: 0x04 +
  // X + Y), que é o que `applicationServerKey` espera no navegador.
  const publica = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const privada = privateKey.export({ type: 'pkcs8', format: 'der' });

  return { publica: base64url(publica), privada: base64url(privada) };
}

/** Reconstrói a chave privada a partir do formato guardado na variável. */
function lerChavePrivada(privadaBase64url) {
  const der = Buffer.from(String(privadaBase64url).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * O JWT que autoriza o empurrão.
 *
 * `aud` é a origem do serviço de push (Google, Mozilla, Apple — cada navegador
 * tem o seu), `sub` é um contato de quem empurra (a especificação pede mailto:
 * ou https:), e a assinatura é ES256 em formato bruto r||s — não DER, que é o
 * que o Node produz por padrão.
 */
function montarJwtVapid({ audiencia, assunto, chavePrivada, agora = () => new Date() }) {
  const cabecalho = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = base64url(JSON.stringify({
    aud: audiencia,
    exp: Math.floor(agora().getTime() / 1000) + VALIDADE_DO_JWT_SEGUNDOS,
    sub: assunto,
  }));

  const assinatura = crypto.sign(
    'sha256',
    Buffer.from(`${cabecalho}.${corpo}`),
    { key: lerChavePrivada(chavePrivada), dsaEncoding: 'ieee-p1363' },
  );

  return `${cabecalho}.${corpo}.${base64url(assinatura)}`;
}

/** A origem do endpoint — é ela, e não a URL inteira, que vai no `aud`. */
function origemDe(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * Cria o empurrador. `buscar` é injetado para o teste não precisar de rede.
 *
 * Devolve, para cada envio: entregue (204/201), ou o que fazer com a inscrição.
 * 404 e 410 do serviço de push significam "esta inscrição morreu" — o aparelho
 * desinstalou o app, limpou os dados ou revogou a permissão. Insistir nela é
 * gastar requisição para sempre; quem chama deve apagá-la.
 */
function criarWebPush({ chavePublica, chavePrivada, assunto, buscar = fetch, agora = () => new Date() } = {}) {
  // Duas capacidades diferentes, e é importante não confundi-las:
  //
  //   • INSCREVER um aparelho precisa só da chave PÚBLICA — ela é entregue a
  //     todo navegador que se inscreve, não é segredo;
  //   • ENVIAR o empurrão precisa da PRIVADA, que assina o JWT.
  //
  // No crmclinica isso acontece em máquinas diferentes: a inscrição é servida
  // pela Vercel, o envio sai do worker no VPS. Exigir a privada nos dois
  // lugares seria espalhar segredo sem necessidade — a Vercel nunca empurra.
  const podeInscrever = Boolean(chavePublica);
  const configurado = Boolean(chavePublica && chavePrivada && assunto);

  /**
   * @param {object} [opcoes.conteudo] O que mostrar na notificação
   *   (`{ titulo, corpo, url }`). Sem isto, o empurrão vai vazio e o aparelho
   *   mostra um texto genérico.
   * @param {object} [opcoes.aparelho] `{ p256dh, auth }` da inscrição —
   *   obrigatório quando há conteúdo: são as chaves que cifram para ESTE
   *   aparelho.
   */
  async function empurrar(endpoint, {
    urgencia = 'normal', validadeSegundos = 6 * 60 * 60, conteudo = null, aparelho = null,
  } = {}) {
    if (!configurado) return { entregue: false, motivo: 'vapid_nao_configurado', remover: false };

    let audiencia;
    try {
      audiencia = origemDe(endpoint);
    } catch {
      // Endpoint que não é URL não vira requisição nenhuma: some da lista.
      return { entregue: false, motivo: 'endpoint_invalido', remover: true };
    }

    const jwt = montarJwtVapid({ audiencia, assunto, chavePrivada, agora });

    // Conteúdo exige as chaves DAQUELE aparelho: é para ele, e só ele, que a
    // mensagem é cifrada.
    let corpo = null;
    if (conteudo && aparelho?.p256dh && aparelho?.auth) {
      try {
        corpo = cifrarParaAparelho(JSON.stringify(conteudo), aparelho);
      } catch (erro) {
        // Chave malformada na inscrição: não dá para cifrar para este aparelho,
        // e mandar em claro não é opção. A inscrição não presta mais.
        return { entregue: false, motivo: `nao cifrei: ${erro.message}`, remover: true };
      }
    }

    const cabecalhos = {
      ttl: String(validadeSegundos),
      urgency: urgencia,
      authorization: `vapid t=${jwt}, k=${chavePublica}`,
    };
    if (corpo) {
      cabecalhos['content-encoding'] = 'aes128gcm';
      cabecalhos['content-type'] = 'application/octet-stream';
      cabecalhos['content-length'] = String(corpo.length);
    } else {
      cabecalhos['content-length'] = '0';
    }

    let resposta;
    try {
      resposta = await buscar(endpoint, {
        method: 'POST',
        headers: cabecalhos,
        ...(corpo ? { body: corpo } : {}),
      });
    } catch (erro) {
      // Rede fora agora não quer dizer inscrição morta: tenta de novo depois.
      return { entregue: false, motivo: `rede: ${erro.message}`, remover: false };
    }

    if (resposta.status === 201 || resposta.status === 204) {
      return { entregue: true, status: resposta.status, remover: false };
    }
    if (resposta.status === 404 || resposta.status === 410) {
      return { entregue: false, status: resposta.status, motivo: 'inscricao_expirada', remover: true };
    }
    // 413 (payload grande) não acontece sem corpo; 429 é excesso — os dois são
    // do envio, não da inscrição.
    return { entregue: false, status: resposta.status, motivo: `push respondeu ${resposta.status}`, remover: false };
  }

  return {
    empurrar,
    configurado,
    podeInscrever,
    chavePublica: podeInscrever ? chavePublica : null,
  };
}

module.exports = { criarWebPush, gerarChavesVapid, montarJwtVapid, base64url, cifrarParaAparelho };
