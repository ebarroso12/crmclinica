import crypto from 'node:crypto';
import path from 'node:path';
import {
  chmod, mkdir, open, readFile, readdir, rename, rm,
} from 'node:fs/promises';

const INTERVALO_PADRAO_MS = 15_000;
const TIMEOUT_PADRAO_MS = 10_000;
const LIMITE_TEXTO = 8_000;

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function primeiroTexto(...valores) {
  return valores.map(texto).find(Boolean) || '';
}

export function ehWhatsapp(evento = {}, contexto = {}) {
  const candidato = primeiroTexto(
    contexto.channelId,
    contexto.provider,
    contexto.surface,
    evento.channelId,
    evento.provider,
    evento.surface,
    evento.metadata?.provider,
    evento.metadata?.surface,
  ).toLowerCase();
  return candidato === 'whatsapp' || /(^|:)whatsapp(:|$)/.test(texto(contexto.sessionKey).toLowerCase());
}

export function ehSessaoWhatsapp(contexto = {}) {
  return /(^|:)whatsapp(:|$)/.test(texto(contexto.sessionKey).toLowerCase());
}

export function decisaoDeSilencio(contexto = {}) {
  if (!ehSessaoWhatsapp(contexto)) return undefined;
  return { handled: true, reason: 'crmclinica_controla_resposta_whatsapp' };
}

function normalizarTelefone(valor) {
  const bruto = texto(valor);
  if (!bruto || /@g\.us|-\d{6,}/i.test(bruto)) return null;
  const antesDoJid = bruto.replace(/^whatsapp:/i, '').split('@')[0];
  const digitos = antesDoJid.replace(/\D/g, '');
  return /^\d{10,15}$/.test(digitos) ? digitos : null;
}

function instanteIso(valor) {
  if (valor === undefined || valor === null || valor === '') return new Date().toISOString();
  let candidato = valor;
  if (typeof candidato === 'string' && /^\d+$/.test(candidato)) candidato = Number(candidato);
  if (typeof candidato === 'number' && candidato > 0 && candidato < 10_000_000_000) candidato *= 1000;
  const data = new Date(candidato);
  return Number.isNaN(data.getTime()) ? new Date().toISOString() : data.toISOString();
}

function descricaoDasMidias(evento) {
  const midias = Array.isArray(evento.media) ? evento.media : [];
  const tipos = [...new Set(midias.map((midia) => primeiroTexto(midia?.kind, midia?.contentType, 'arquivo')))];
  if (tipos.length === 0) return '';
  return `[Mídia recebida: ${tipos.join(', ')}]`;
}

export function normalizarEvento(evento = {}, contexto = {}) {
  if (!ehWhatsapp(evento, contexto)) return null;
  if (evento.fromMe === true || evento.isFromMe === true || evento.direction === 'outbound') return null;

  const remetente = normalizarTelefone(primeiroTexto(
    evento.senderId,
    contexto.senderId,
    evento.metadata?.senderId,
    evento.metadata?.from,
    evento.from,
  ));
  if (!remetente) return null;

  const conteudo = primeiroTexto(evento.content, evento.body, evento.text);
  const midia = descricaoDasMidias(evento);
  const corpo = [conteudo, midia && !conteudo.includes(midia) ? midia : ''].filter(Boolean).join('\n');
  if (!corpo) return null;

  const ocorridoEm = instanteIso(evento.timestamp ?? contexto.timestamp);
  const idNativo = primeiroTexto(evento.messageId, contexto.messageId, evento.id);
  const idFallback = crypto.createHash('sha256')
    .update(`${remetente}|${ocorridoEm}|${corpo}`, 'utf8')
    .digest('hex');

  return {
    tipo: 'mensagem.recebida',
    canal: 'whatsapp',
    id_externo: `openclaw:${idNativo || idFallback}`.slice(0, 200),
    remetente,
    nome: primeiroTexto(evento.senderName, evento.metadata?.senderName, evento.metadata?.pushName).slice(0, 160) || null,
    texto: corpo.slice(0, LIMITE_TEXTO),
    origem: 'openclaw_plugin',
    ocorrido_em: ocorridoEm,
  };
}

function nomeDoArquivo(evento) {
  return `${crypto.createHash('sha256').update(evento.id_externo, 'utf8').digest('hex')}.json`;
}

async function gravarAtomico(arquivo, conteudo) {
  const temporario = `${arquivo}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const manipulador = await open(temporario, 'wx', 0o600);
  try {
    await manipulador.writeFile(conteudo, 'utf8');
    await manipulador.sync();
  } finally {
    await manipulador.close();
  }

  try {
    await rename(temporario, arquivo);
  } catch (erro) {
    await rm(temporario, { force: true });
    if (erro.code !== 'EEXIST') throw erro;
  }
  await chmod(arquivo, 0o600).catch(() => {});
}

export function criarPonte({
  endpoint,
  segredo,
  pasta,
  fetchImpl = globalThis.fetch,
  logger = console,
  intervaloMs = INTERVALO_PADRAO_MS,
  timeoutMs = TIMEOUT_PADRAO_MS,
} = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CRMCLINICA_INGRESS_URL deve usar HTTP ou HTTPS');
  if (typeof segredo !== 'string' || segredo.length < 32) {
    throw new Error('WHATSAPP_WEBHOOK_SECRET deve ter ao menos 32 caracteres');
  }
  if (!pasta) throw new Error('pasta durável da ponte não configurada');
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

  let relogio = null;
  let parando = false;
  let varredura = Promise.resolve();

  async function prepararPasta() {
    await mkdir(pasta, { recursive: true, mode: 0o700 });
    await chmod(pasta, 0o700).catch(() => {});
  }

  async function entregarArquivo(arquivo) {
    const corpo = await readFile(arquivo, 'utf8');
    const assinatura = `sha256=${crypto.createHmac('sha256', segredo).update(corpo).digest('hex')}`;
    const resposta = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-whatsapp-assinatura': assinatura,
      },
      body: corpo,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resposta.ok) throw new Error(`CRM respondeu HTTP ${resposta.status}`);
    await rm(arquivo, { force: true });
  }

  async function tentarPendentes() {
    if (parando) return;
    await prepararPasta();
    const arquivos = (await readdir(pasta))
      .filter((nome) => /^[0-9a-f]{64}\.json$/.test(nome))
      .sort();
    for (const nome of arquivos) {
      if (parando) return;
      try {
        await entregarArquivo(path.join(pasta, nome));
      } catch (erro) {
        logger.warn?.(`[crmclinica-ingresso] entrega pendente; nova tentativa agendada (${erro.message})`);
        return;
      }
    }
  }

  function solicitarVarredura() {
    varredura = varredura.then(tentarPendentes, tentarPendentes);
    return varredura;
  }

  return {
    async receber(evento, contexto) {
      const normalizado = normalizarEvento(evento, contexto);
      if (!normalizado) return { ignorado: true };
      await prepararPasta();
      const arquivo = path.join(pasta, nomeDoArquivo(normalizado));
      await gravarAtomico(arquivo, JSON.stringify(normalizado));
      await solicitarVarredura();
      return { persistido: true };
    },

    async iniciar() {
      parando = false;
      await prepararPasta();
      await solicitarVarredura();
      if (!relogio) {
        relogio = setInterval(solicitarVarredura, intervaloMs);
        relogio.unref?.();
      }
    },

    async parar() {
      parando = true;
      if (relogio) clearInterval(relogio);
      relogio = null;
      await varredura.catch(() => {});
    },

    tentarPendentes: solicitarVarredura,
  };
}
