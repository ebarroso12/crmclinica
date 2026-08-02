'use strict';

const crypto = require('node:crypto');

// Login com conta Google (OAuth 2.0 + OpenID Connect).
//
// O ponto delicado é a verificação do `id_token`: aceitar o token sem conferir a
// assinatura, o público (`aud`) e o emissor (`iss`) permitiria que qualquer pessoa
// forjasse um login. Aqui as três coisas são verificadas de verdade, contra as
// chaves públicas que o Google publica.

const EMISSORES_VALIDOS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const URL_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const URL_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';

function base64urlParaJson(parte) {
  return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8'));
}

function criarClienteGoogle(configuracao = {}, dependencias = {}) {
  const requisicao = dependencias.fetch || globalThis.fetch;
  const { clienteId, clienteSegredo, redirecionamento } = configuracao;
  const agora = dependencias.agora || (() => Date.now());

  const disponivel = Boolean(clienteId && clienteSegredo && redirecionamento);

  // As chaves do Google giram; guardar em cache respeitando o cabeçalho evita
  // uma ida à rede por login sem correr o risco de usar chave revogada.
  let cacheJwks = { chaves: null, validoAte: 0 };

  async function obterChaves() {
    if (cacheJwks.chaves && cacheJwks.validoAte > agora()) return cacheJwks.chaves;

    const resposta = await requisicao(URL_JWKS);
    if (!resposta.ok) {
      const erro = new Error('não foi possível obter as chaves públicas do Google');
      erro.codigo = 'google_jwks_indisponivel';
      throw erro;
    }

    const { keys } = await resposta.json();
    const cabecalho = resposta.headers?.get?.('cache-control') || '';
    const idade = /max-age=(\d+)/.exec(cabecalho);
    const validade = idade ? Number(idade[1]) * 1000 : 3600_000;

    cacheJwks = { chaves: keys, validoAte: agora() + validade };
    return keys;
  }

  /**
   * Verifica o `id_token` e devolve a identidade confirmada.
   * @throws quando assinatura, público, emissor ou validade não conferem.
   */
  async function verificarIdToken(idToken) {
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
      const erro = new Error('id_token malformado');
      erro.status = 401;
      throw erro;
    }

    const [cabecalhoBruto, payloadBruto, assinaturaBruta] = idToken.split('.');

    let cabecalho;
    let conteudo;
    try {
      cabecalho = base64urlParaJson(cabecalhoBruto);
      conteudo = base64urlParaJson(payloadBruto);
    } catch {
      const erro = new Error('id_token ilegível');
      erro.status = 401;
      throw erro;
    }

    // Só RS256: aceitar o algoritmo que o token pede é o que abre `alg: none`.
    if (cabecalho.alg !== 'RS256') {
      const erro = new Error('algoritmo do id_token não aceito');
      erro.status = 401;
      throw erro;
    }

    const chaves = await obterChaves();
    const chave = chaves.find((candidata) => candidata.kid === cabecalho.kid);
    if (!chave) {
      const erro = new Error('chave do id_token desconhecida');
      erro.status = 401;
      throw erro;
    }

    const publica = crypto.createPublicKey({ key: chave, format: 'jwk' });
    const assinaturaConfere = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${cabecalhoBruto}.${payloadBruto}`, 'utf8'),
      publica,
      Buffer.from(assinaturaBruta, 'base64url'),
    );
    if (!assinaturaConfere) {
      const erro = new Error('assinatura do id_token inválida');
      erro.status = 401;
      throw erro;
    }

    // `aud` amarra o token a **esta** aplicação: sem isso, um token emitido para
    // qualquer outro site do Google serviria para entrar aqui.
    if (conteudo.aud !== clienteId) {
      const erro = new Error('id_token emitido para outra aplicação');
      erro.status = 401;
      throw erro;
    }
    if (!EMISSORES_VALIDOS.has(conteudo.iss)) {
      const erro = new Error('emissor do id_token não reconhecido');
      erro.status = 401;
      throw erro;
    }
    if (typeof conteudo.exp !== 'number' || conteudo.exp * 1000 <= agora()) {
      const erro = new Error('id_token expirado');
      erro.status = 401;
      throw erro;
    }
    // E-mail não verificado não identifica ninguém: qualquer um cadastra o e-mail
    // de outra pessoa numa conta Google sem confirmar.
    if (conteudo.email && conteudo.email_verified === false) {
      const erro = new Error('e-mail da conta Google não verificado');
      erro.status = 401;
      throw erro;
    }

    return {
      sub: conteudo.sub,
      email: conteudo.email ?? null,
      nome: conteudo.name ?? null,
      avatar: conteudo.picture ?? null,
    };
  }

  return {
    disponivel,
    clienteId: clienteId || null,

    /** URL para onde mandar a pessoa começar o login. */
    montarUrlDeAutorizacao(estado) {
      if (!disponivel) {
        const erro = new Error('login com Google não está configurado');
        erro.codigo = 'google_nao_configurado';
        throw erro;
      }

      const parametros = new URLSearchParams({
        client_id: clienteId,
        redirect_uri: redirecionamento,
        response_type: 'code',
        scope: 'openid email profile',
        // `state` amarra o retorno à requisição que o originou — é a defesa contra CSRF.
        state: estado,
        prompt: 'select_account',
      });
      return `${URL_AUTORIZACAO}?${parametros}`;
    },

    /** Troca o código de autorização pelo id_token e devolve a identidade verificada. */
    async trocarCodigo(codigo) {
      if (!disponivel) {
        const erro = new Error('login com Google não está configurado');
        erro.codigo = 'google_nao_configurado';
        throw erro;
      }

      const resposta = await requisicao(URL_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: codigo,
          client_id: clienteId,
          client_secret: clienteSegredo,
          redirect_uri: redirecionamento,
          grant_type: 'authorization_code',
        }),
      });

      if (!resposta.ok) {
        const erro = new Error('o Google recusou a troca do código');
        erro.status = 401;
        throw erro;
      }

      const { id_token: idToken } = await resposta.json();
      return verificarIdToken(idToken);
    },

    verificarIdToken,
  };
}

module.exports = { criarClienteGoogle, EMISSORES_VALIDOS };
