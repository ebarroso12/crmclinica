'use strict';

const crypto = require('node:crypto');

// Aviso no celular (Web Push), sem dependência nenhuma.
//
// O navegador registra uma "inscrição" (endpoint + chaves) e o servidor manda um
// POST para esse endpoint, assinado com VAPID — um JWT ES256 que prova que quem
// empurra é o dono da chave pública que o navegador recebeu na inscrição.
//
// UMA DECISÃO IMPORTANTE: este módulo empurra SEM CONTEÚDO.
//
// O Web Push permite mandar um texto cifrado junto (RFC 8291). Aqui isso é
// deliberadamente evitado — não por preguiça de implementar a criptografia, mas
// porque a notificação aparece na tela de bloqueio do aparelho, à vista de quem
// estiver por perto. "Maria Silva: preciso remarcar minha consulta de
// psiquiatria" na tela travada é um vazamento de dado clínico que o CRM inteiro
// existe para evitar. Sem conteúdo, o aviso diz só que há novidade; o nome do
// paciente aparece quando a pessoa abre o CRM e se identifica.
//
// Efeito colateral bom: sem payload não há ECDH nem AES-GCM para errar.

const VALIDADE_DO_JWT_SEGUNDOS = 12 * 60 * 60; // 12h — o teto da especificação é 24h.

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
  const configurado = Boolean(chavePublica && chavePrivada && assunto);

  async function empurrar(endpoint, { urgencia = 'normal', validadeSegundos = 6 * 60 * 60 } = {}) {
    if (!configurado) return { entregue: false, motivo: 'vapid_nao_configurado', remover: false };

    let audiencia;
    try {
      audiencia = origemDe(endpoint);
    } catch {
      // Endpoint que não é URL não vira requisição nenhuma: some da lista.
      return { entregue: false, motivo: 'endpoint_invalido', remover: true };
    }

    const jwt = montarJwtVapid({ audiencia, assunto, chavePrivada, agora });

    let resposta;
    try {
      resposta = await buscar(endpoint, {
        method: 'POST',
        headers: {
          // Sem corpo: o aviso não carrega dado do paciente (ver o topo).
          'content-length': '0',
          ttl: String(validadeSegundos),
          urgency: urgencia,
          authorization: `vapid t=${jwt}, k=${chavePublica}`,
        },
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

  return { empurrar, configurado, chavePublica: configurado ? chavePublica : null };
}

module.exports = { criarWebPush, gerarChavesVapid, montarJwtVapid, base64url };
