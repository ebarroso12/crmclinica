'use strict';

const crypto = require('node:crypto');
const { mascararTelefone } = require('../dominio/lembretes');
const {
  criarClienteGateway, carregarOuCriarIdentidade, descreverIdentidade, ErroDeGateway,
} = require('./openclaw-gateway');

// Adaptador de saída de lembretes pelo OpenClaw.
//
// Isolado de propósito: é o único arquivo que sabe **como** um lembrete sai do
// crmclinica. A fila, o worker, a auditoria e os testes não sabem.
//
// ------------------------------------------------------------------ o método
//
// `send`, RPC do gateway WebSocket. Verificado na instalação em produção
// (OpenClaw 2026.7.1-2): é o mesmo método que o comando oficial
// `openclaw message send` usa, registrado em
// `dist/server-methods-*.js` junto com `message.action` e `poll`.
//
// Schema de `SendParamsSchema`, lido do próprio pacote:
//
//   obrigatórios: to, idempotencyKey
//   usados aqui:  message, channel, accountId
//   ignorados:    mediaUrl(s), buffer, filename, contentType, asVoice,
//                 gifPlayback, agentId, replyToId, threadId, forceDocument,
//                 silent, parseMode, sessionKey
//
// `additionalProperties: false` — campo a mais é recusado pelo gateway antes de
// chegar ao canal. É uma barreira a mais contra dado clínico atravessar.
//
// ------------------------------------------------------------------ idempotência
//
// `idempotencyKey` **não é enfeite**: o gateway deduplica por ela. Um `send`
// repetido com a mesma chave devolve a resposta em cache (`cached: true`) em vez
// de mandar de novo. Isso fecha a última janela que a fila sozinha não fecha:
// worker que envia, morre antes de gravar 'enviado', e volta a processar a
// mesma linha. A chave é derivada do lembrete — mesmo lembrete, mesma chave.
//
// ------------------------------------------------------------------ confirmação
//
// `enviado` só depois de o gateway responder `ok` **com identificador de
// mensagem**. Timeout, conexão caída e resposta sem identificador viram falha
// com retry — nunca "enviado". Uma mensagem que talvez tenha saído é tratada
// como não enviada, e a idempotência do gateway impede que o retry duplique.

/**
 * Canais que este adaptador entrega. A lista existe para que um canal novo seja
 * uma decisão, não um efeito colateral de alguém mudar uma variável.
 */
const CANAIS_SUPORTADOS = Object.freeze(['whatsapp']);

class ErroDeEntrega extends Error {
  constructor(mensagem, codigo, { permanente = false } = {}) {
    super(mensagem);
    this.name = 'ErroDeEntrega';
    this.codigo = codigo;
    // Erro permanente não adianta repetir: retry só gasta tentativa.
    this.permanente = permanente;
  }
}

function validarEnvelope(envelope) {
  if (!envelope?.destinatario) {
    throw new ErroDeEntrega('lembrete sem destinatário', 'destinatario_ausente', { permanente: true });
  }
  if (!envelope?.texto) {
    throw new ErroDeEntrega('lembrete sem texto', 'texto_ausente', { permanente: true });
  }
  // Barreira de última hora contra vazamento: se algum dia alguém acrescentar um
  // campo ao envelope, ele para aqui em vez de sair para o WhatsApp.
  const permitidos = new Set(['referencia', 'tipo', 'canal', 'destinatario', 'texto']);
  const intrusos = Object.keys(envelope).filter((campo) => !permitidos.has(campo));
  if (intrusos.length > 0) {
    throw new ErroDeEntrega(
      `envelope com campos não autorizados: ${intrusos.join(', ')}`,
      'envelope_invalido',
      { permanente: true },
    );
  }
}

/**
 * A chave de idempotência do gateway.
 *
 * Determinística e derivada só do que identifica o lembrete: a mesma referência
 * produz a mesma chave em qualquer worker, em qualquer reinício. Se fosse
 * aleatória, o dedupe do gateway nunca reconheceria a repetição — que é
 * exatamente o caso em que ele precisa funcionar.
 */
function chaveDeIdempotencia(envelope) {
  return `crmclinica:${crypto.createHash('sha256')
    .update(`${envelope.referencia}|${envelope.destinatario}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * O identificador que o gateway devolve quando a mensagem realmente saiu.
 *
 * O payload varia por canal (`messageId`, `id`, `guid`, `toJid`…). Sem nenhum
 * deles, não há prova de entrega — e sem prova, a fila não marca 'enviado'.
 */
function extrairIdentificador(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const campo of ['messageId', 'id', 'guid', 'chatId', 'conversationId', 'toJid']) {
    const valor = payload[campo];
    if (typeof valor === 'string' && valor.trim()) return valor.trim();
    if (typeof valor === 'number') return String(valor);
  }
  return null;
}

/**
 * @param {object} configuracao  `configuracao.openclaw` (com `.gateway`) e `modoEntrega`.
 * @param {object} dependencias  `registrar` (log) e `cliente` (injeção nos testes).
 */
function criarAdaptadorDeLembretes(configuracao = {}, dependencias = {}) {
  const registrar = dependencias.registrar
    || ((mensagem, dados) => console.log(`[lembretes] ${mensagem}`, JSON.stringify(dados)));

  const gateway = configuracao.gateway ?? {};
  const canal = gateway.canal || 'whatsapp';
  const modoPedido = String(configuracao.modoEntrega || 'dry_run').toLowerCase();
  const exigiuReal = modoPedido === 'real';

  // Um cliente injetado é a via dos testes: exercita o caminho real inteiro sem
  // abrir socket nenhum. Sem ele, o cliente de verdade só é montado se houver
  // com o que conectar.
  let cliente = dependencias.cliente ?? null;
  let identidade = null;
  let erroDeMontagem = null;

  if (!cliente && gateway.url && (gateway.token || gateway.deviceToken)) {
    try {
      identidade = carregarOuCriarIdentidade(gateway.identidadePath, gateway.chavePrivada);
      cliente = criarClienteGateway({
        url: gateway.url,
        token: gateway.token || null,
        deviceToken: gateway.deviceToken || null,
        identidade,
        timeoutMs: gateway.timeoutMs,
      });
    } catch (erro) {
      erroDeMontagem = erro;
    }
  }

  const canalSuportado = CANAIS_SUPORTADOS.includes(canal);
  const podeEnviar = Boolean(cliente) && canalSuportado;
  const modo = exigiuReal && podeEnviar ? 'real' : 'dry_run';

  function porqueNaoEnviaDeVerdade() {
    if (erroDeMontagem) return erroDeMontagem.message;
    if (!gateway.url) return 'OPENCLAW_GATEWAY_URL não está definida';
    if (!gateway.token && !gateway.deviceToken) {
      return 'faltam OPENCLAW_GATEWAY_TOKEN ou OPENCLAW_DEVICE_TOKEN';
    }
    if (!canalSuportado) return `canal "${canal}" não é suportado por este adaptador`;
    if (!exigiuReal) return 'LEMBRETES_MODO_ENTREGA não está em "real"';
    return null;
  }

  return {
    modo,
    canal,

    /** Retrato para health check e para a rota de resumo. Sem segredo nenhum. */
    descrever() {
      return {
        orquestrador: 'OpenClaw',
        modo,
        canal,
        metodo: 'gateway.send',
        gateway: gateway.url || null,
        // O deviceId é público por natureza — é o hash da chave pública, e é o
        // que a operação precisa para achar o dispositivo em `devices list`.
        dispositivo: identidade ? descreverIdentidade(identidade).deviceId : null,
        significado: modo === 'real'
          ? 'as mensagens saem de verdade pelo canal do OpenClaw'
          : 'nenhuma mensagem sai: a fila roda completa e o envio é simulado',
        ...(modo === 'dry_run' ? { motivo: porqueNaoEnviaDeVerdade() } : {}),
      };
    },

    /** Estado do canal, direto do gateway. Só leitura — não envia nada. */
    async verificarCanal() {
      if (!cliente) return { disponivel: false, motivo: porqueNaoEnviaDeVerdade() };
      try {
        const status = await cliente.chamar('channels.status', {});
        const doCanal = status?.channels?.[canal] ?? null;
        return {
          disponivel: doCanal?.connected === true,
          canal,
          conectado: doCanal?.connected === true,
          vinculado: doCanal?.linked ?? null,
          numero: doCanal?.self?.e164 ?? null,
        };
      } catch (erro) {
        return { disponivel: false, motivo: erro.message, codigo: erro.codigo ?? null };
      }
    },

    /**
     * Entrega um lembrete.
     *
     * Em `real`, devolve `entregue: true` **apenas** com confirmação do gateway
     * e identificador de mensagem. Em `dry_run`, devolve `entregue: false` — e
     * nenhum lugar do sistema afirma que a mensagem chegou a alguém.
     */
    async enviar(envelope) {
      validarEnvelope(envelope);

      if (modo === 'real') {
        const idempotencyKey = chaveDeIdempotencia(envelope);

        let resposta;
        try {
          resposta = await cliente.chamar('send', {
            to: envelope.destinatario,
            message: envelope.texto,
            channel: canal,
            ...(gateway.contaId ? { accountId: gateway.contaId } : {}),
            idempotencyKey,
          });
        } catch (erro) {
          // Timeout e queda de conexão são incerteza, não fracasso conhecido: a
          // mensagem pode ter saído. Vira falha com retry, e a `idempotencyKey`
          // impede que a próxima tentativa duplique.
          const permanente = erro instanceof ErroDeGateway ? erro.permanente === true : false;
          throw new ErroDeEntrega(erro.message, erro.codigo ?? 'gateway_erro', { permanente });
        }

        const identificador = extrairIdentificador(resposta);
        if (!identificador) {
          // Resposta que não prova entrega é tratada como não entregue. Marcar
          // 'enviado' aqui seria inventar uma confirmação que não houve.
          throw new ErroDeEntrega(
            'o gateway respondeu sem identificador de mensagem: entrega não confirmada',
            'entrega_nao_confirmada',
          );
        }

        registrar('entregue pelo OpenClaw', {
          referencia: envelope.referencia,
          tipo: envelope.tipo,
          canal,
          destinatario: mascararTelefone(envelope.destinatario),
          mensagem: identificador,
        });

        return { entregue: true, modo: 'real', referencia: identificador };
      }

      if (exigiuReal) {
        // Pediram envio real e não há como. Falhar aqui é o comportamento certo:
        // o alternativo seria a clínica achar que está lembrando pacientes.
        throw new ErroDeEntrega(
          `envio real indisponível: ${porqueNaoEnviaDeVerdade()}`,
          'openclaw_indisponivel',
          { permanente: true },
        );
      }

      // O log é a prova de que a fila funcionou. Telefone mascarado e texto
      // medido em caracteres: nem em log o conteúdo do paciente é despejado.
      registrar('simulado (dry-run, nada foi enviado)', {
        referencia: envelope.referencia,
        tipo: envelope.tipo,
        destinatario: mascararTelefone(envelope.destinatario),
        caracteres: envelope.texto.length,
      });

      return { entregue: false, modo: 'dry_run', referencia: `dry-run:${envelope.referencia}` };
    },

    async encerrar() {
      await cliente?.encerrar?.();
    },
  };
}

module.exports = {
  criarAdaptadorDeLembretes,
  ErroDeEntrega,
  CANAIS_SUPORTADOS,
  chaveDeIdempotencia,
  extrairIdentificador,
};
