'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Cliente do gateway OpenClaw.
//
// Este arquivo é o único lugar do crmclinica que fala o protocolo do
// orquestrador. Tudo aqui foi lido da instalação oficial em
// `/usr/lib/node_modules/openclaw` (versão 2026.7.1-2) e da documentação em
// docs.openclaw.ai — nada foi suposto. As referências estão em
// `docs/OPENCLAW.md`, com o arquivo e a função de origem de cada regra.
//
// ---------------------------------------------------------------- o protocolo
//
// Transporte: WebSocket. O servidor abre com um desafio, o cliente responde com
// `connect`, e a partir daí é requisição/resposta por id:
//
//   servidor → { type: "event", event: "connect.challenge", payload: { nonce, ts } }
//   cliente  → { type: "req", id, method: "connect", params: { … } }
//   servidor → { type: "res", id, ok: true, payload: { type: "hello-ok", … } }
//
// ---------------------------------------------------------------- a autenticação
//
// O ponto que custou a descobrir, e que é a razão de este arquivo existir:
// **o token compartilhado do gateway não concede escopo nenhum.** Conectar só
// com ele resulta em `scopes: []`, e qualquer método útil responde
// `missing scope: operator.read`.
//
// Escopo vem de **dispositivo pareado**: uma chave Ed25519 que o gateway
// conhece e que um operador aprovou uma vez (`openclaw devices approve`). O
// cliente assina um payload canônico a cada conexão, provando que é o mesmo
// dispositivo. O formato do payload é fixo e posicional (v3):
//
//   v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
//
// Assinatura Ed25519 crua, em base64url. A chave pública viaja como os 32 bytes
// crus em base64url, e o `deviceId` é o SHA-256 hex desses bytes.

const PROTOCOLO = 4;

// Valores do enum do gateway. `gateway-client` + `backend` é o par que descreve
// o que o crmclinica é: um serviço, não uma pessoa numa interface.
const CLIENTE_ID = 'gateway-client';
const CLIENTE_MODO = 'backend';
const PAPEL = 'operator';

// `operator.write` é o que permite enviar; `operator.read`, consultar o estado
// do canal antes. Pedir mais que isso seria pedir poder que o lembrete não usa.
const ESCOPOS = Object.freeze(['operator.read', 'operator.write']);

const PREFIXO_SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

class ErroDeGateway extends Error {
  constructor(mensagem, codigo, { permanente = false, detalhes = null } = {}) {
    super(mensagem);
    this.name = 'ErroDeGateway';
    this.codigo = codigo;
    this.permanente = permanente;
    this.detalhes = detalhes;
  }
}

function base64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

/** Os 32 bytes crus da chave pública, sem o envelope SPKI. */
function chavePublicaCrua(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return spki.length === PREFIXO_SPKI_ED25519.length + 32
    ? spki.subarray(PREFIXO_SPKI_ED25519.length)
    : spki;
}

/** O id do dispositivo é derivado da chave: não é escolhido, é consequência. */
function derivarDeviceId(publicKeyPem) {
  return crypto.createHash('sha256').update(chavePublicaCrua(publicKeyPem)).digest('hex');
}

function gerarIdentidade() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { deviceId: derivarDeviceId(publicKeyPem), publicKeyPem, privateKeyPem };
}

function identidadeDeChavePrivada(privateKeyPem) {
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  return { deviceId: derivarDeviceId(publicKeyPem), publicKeyPem, privateKeyPem };
}

/**
 * Carrega a identidade do dispositivo, ou cria uma na primeira vez.
 *
 * Duas origens, nesta ordem:
 *
 *   1. `chavePrivadaPem` — a chave vinda do ambiente. É o caminho de produção:
 *      na Vercel não há disco gravável entre execuções, e uma identidade que se
 *      recria a cada deploy pediria pareamento novo toda vez.
 *   2. arquivo — o caminho de desenvolvimento e do worker em servidor próprio.
 *
 * O arquivo nasce com permissão 0600. É chave privada: quem a tem, fala pelo
 * crmclinica com o orquestrador.
 */
function carregarOuCriarIdentidade(caminho, chavePrivadaPem = null) {
  if (chavePrivadaPem) {
    try {
      return { ...identidadeDeChavePrivada(chavePrivadaPem), origem: 'ambiente' };
    } catch (erro) {
      throw new ErroDeGateway(
        `OPENCLAW_DEVICE_PRIVATE_KEY não é uma chave Ed25519 válida: ${erro.message}`,
        'identidade_invalida',
        { permanente: true },
      );
    }
  }

  if (caminho && fs.existsSync(caminho)) {
    const guardada = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    const identidade = identidadeDeChavePrivada(guardada.privateKeyPem);
    // O id é sempre rederivado da chave: um arquivo com id trocado à mão não
    // muda quem o dispositivo é, e seguir o campo levaria a uma falha obscura
    // no handshake em vez de aqui.
    return { ...identidade, origem: `arquivo (${path.basename(caminho)})` };
  }

  const identidade = gerarIdentidade();
  if (caminho) {
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, `${JSON.stringify({
      version: 1,
      deviceId: identidade.deviceId,
      publicKeyPem: identidade.publicKeyPem,
      privateKeyPem: identidade.privateKeyPem,
      criadoEm: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
  }
  return { ...identidade, origem: 'gerada agora' };
}

/** Retrato sem a chave privada — o que pode aparecer em log e em resposta. */
function descreverIdentidade(identidade) {
  return {
    deviceId: identidade.deviceId,
    publicKey: base64url(chavePublicaCrua(identidade.publicKeyPem)),
    origem: identidade.origem ?? 'desconhecida',
  };
}

/**
 * O payload canônico que o dispositivo assina.
 *
 * Posicional e sem separador escapável: qualquer campo fora de ordem produz uma
 * assinatura que não confere, e o gateway recusa. Reproduz
 * `buildDeviceAuthPayloadV3` de `packages/gateway-client/src/device-auth.ts`.
 */
function montarPayloadDeAssinatura({
  deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily = '',
}) {
  // O gateway normaliza estes dois para minúsculas antes de conferir. Assinar
  // com a caixa original faria a verificação falhar em máquinas cujo
  // `process.platform` não é minúsculo — "Win32", por exemplo.
  const normalizar = (valor) => String(valor ?? '').trim().toLowerCase();

  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token ?? '',
    nonce,
    normalizar(platform),
    normalizar(deviceFamily),
  ].join('|');
}

function assinar(privateKeyPem, payload) {
  return base64url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
}

/**
 * Cliente do gateway.
 *
 * Uma conexão por processo, reaproveitada entre envios: o handshake custa uma
 * ida e volta com assinatura, e refazê-lo a cada lembrete transformaria um lote
 * de vinte mensagens em vinte handshakes.
 */
function criarClienteGateway({
  url,
  token = null,
  deviceToken = null,
  identidade,
  timeoutMs = 20000,
  WebSocketImpl = globalThis.WebSocket,
  agora = () => Date.now(),
} = {}) {
  if (!url) throw new ErroDeGateway('gateway sem URL', 'gateway_sem_url', { permanente: true });
  if (!identidade) throw new ErroDeGateway('gateway sem identidade de dispositivo', 'gateway_sem_identidade', { permanente: true });

  let socket = null;
  let sessao = null;
  let conectando = null;
  let sequencia = 0;
  const pendentes = new Map();

  function limpar(motivo) {
    socket = null;
    sessao = null;
    conectando = null;
    for (const [, pendente] of pendentes) {
      pendente.rejeitar(new ErroDeGateway(`conexão encerrada: ${motivo}`, 'gateway_desconectado'));
    }
    pendentes.clear();
  }

  function despachar(method, params) {
    return new Promise((resolver, rejeitar) => {
      if (!socket || socket.readyState !== 1) {
        rejeitar(new ErroDeGateway('gateway não conectado', 'gateway_desconectado'));
        return;
      }

      const id = String(++sequencia);
      const relogio = setTimeout(() => {
        if (!pendentes.delete(id)) return;
        // Timeout **nunca** vira sucesso. A mensagem pode ter saído ou não, e
        // quem chamou precisa tratar isso como incerto — não como enviado.
        rejeitar(new ErroDeGateway(`sem resposta do gateway para "${method}"`, 'gateway_timeout'));
      }, timeoutMs);

      pendentes.set(id, {
        resolver: (valor) => { clearTimeout(relogio); resolver(valor); },
        rejeitar: (erro) => { clearTimeout(relogio); rejeitar(erro); },
      });

      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  function tratarQuadro(bruto) {
    let quadro;
    try {
      quadro = JSON.parse(bruto);
    } catch {
      return;
    }

    if (quadro.type === 'res') {
      const pendente = pendentes.get(quadro.id);
      if (!pendente) return;
      pendentes.delete(quadro.id);

      if (quadro.ok) {
        pendente.resolver(quadro.payload);
        return;
      }

      const erro = quadro.error ?? {};
      pendente.rejeitar(new ErroDeGateway(
        erro.message || 'o gateway recusou a requisição',
        erro.code === 'NOT_PAIRED' ? 'openclaw_nao_pareado' : `gateway_${String(erro.code || 'erro').toLowerCase()}`,
        {
          // Erro de pareamento e de escopo não melhoram com repetição: alguém
          // precisa aprovar o dispositivo. Insistir só gasta as tentativas.
          permanente: erro.code === 'NOT_PAIRED' || /missing scope/i.test(erro.message ?? ''),
          detalhes: erro.details ?? null,
        },
      ));
      return;
    }

    if (quadro.type === 'event' && quadro.event === 'connect.challenge') {
      responderDesafio(quadro.payload).catch(() => {});
    }
  }

  async function responderDesafio(desafio) {
    const signedAtMs = agora();
    // O token que entra na assinatura é o mesmo que vai em `auth`, nesta ordem
    // de precedência — é como `resolveSignatureToken` do gateway o escolhe.
    const tokenDaAssinatura = token ?? deviceToken ?? null;
    const platform = process.platform;

    const payload = montarPayloadDeAssinatura({
      deviceId: identidade.deviceId,
      clientId: CLIENTE_ID,
      clientMode: CLIENTE_MODO,
      role: PAPEL,
      scopes: ESCOPOS,
      signedAtMs,
      token: tokenDaAssinatura,
      nonce: desafio.nonce,
      platform,
    });

    try {
      const hello = await despachar('connect', {
        minProtocol: PROTOCOLO,
        maxProtocol: PROTOCOLO,
        client: {
          id: CLIENTE_ID,
          mode: CLIENTE_MODO,
          version: require('../../package.json').version,
          platform,
          displayName: 'crmclinica-lembretes',
        },
        auth: {
          ...(token ? { token } : {}),
          ...(deviceToken ? { deviceToken } : {}),
        },
        role: PAPEL,
        scopes: [...ESCOPOS],
        device: {
          id: identidade.deviceId,
          publicKey: base64url(chavePublicaCrua(identidade.publicKeyPem)),
          signature: assinar(identidade.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce: desafio.nonce,
        },
      });

      sessao = hello;
      conectando?.resolver(hello);
    } catch (erro) {
      if (erro.codigo === 'openclaw_nao_pareado') {
        erro.requestId = erro.detalhes?.requestId ?? null;
      }
      conectando?.rejeitar(erro);
    }
  }

  async function conectar() {
    if (sessao && socket?.readyState === 1) return sessao;
    if (conectando?.promessa) return conectando.promessa;

    let resolver;
    let rejeitar;
    const promessa = new Promise((res, rej) => { resolver = res; rejeitar = rej; });
    conectando = { promessa, resolver, rejeitar };

    const relogio = setTimeout(() => {
      rejeitar(new ErroDeGateway('o gateway não completou o handshake a tempo', 'gateway_timeout'));
    }, timeoutMs);

    try {
      socket = new WebSocketImpl(url);
    } catch (erro) {
      clearTimeout(relogio);
      limpar(erro.message);
      throw new ErroDeGateway(`não foi possível abrir a conexão: ${erro.message}`, 'gateway_indisponivel');
    }

    socket.addEventListener('message', (evento) => tratarQuadro(
      typeof evento.data === 'string' ? evento.data : Buffer.from(evento.data).toString('utf8'),
    ));
    socket.addEventListener('error', () => {
      rejeitar(new ErroDeGateway('falha na conexão com o gateway', 'gateway_indisponivel'));
    });
    socket.addEventListener('close', (evento) => {
      const motivo = evento?.reason || `código ${evento?.code ?? '?'}`;
      rejeitar(new ErroDeGateway(`o gateway fechou a conexão: ${motivo}`, 'gateway_desconectado'));
      limpar(motivo);
    });

    try {
      const hello = await promessa;
      clearTimeout(relogio);
      conectando = null;
      return hello;
    } catch (erro) {
      clearTimeout(relogio);
      conectando = null;
      try { socket?.close(); } catch { /* já fechado */ }
      socket = null;
      throw erro;
    }
  }

  return {
    get sessao() { return sessao; },

    conectar,

    /** Uma chamada RPC, reconectando se a conexão tiver caído. */
    async chamar(metodo, parametros) {
      await conectar();
      return despachar(metodo, parametros);
    },

    async encerrar() {
      try { socket?.close(); } catch { /* já fechado */ }
      limpar('encerrado pela aplicação');
    },
  };
}

module.exports = {
  criarClienteGateway,
  carregarOuCriarIdentidade,
  descreverIdentidade,
  gerarIdentidade,
  montarPayloadDeAssinatura,
  derivarDeviceId,
  chavePublicaCrua,
  base64url,
  ErroDeGateway,
  PROTOCOLO,
  ESCOPOS,
  CLIENTE_ID,
  CLIENTE_MODO,
  PAPEL,
};
