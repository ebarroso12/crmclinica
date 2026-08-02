'use strict';

const { mascararTelefone } = require('../dominio/lembretes');

// Adaptador de saída de lembretes pelo OpenClaw.
//
// Isolado de propósito: é o único arquivo que sabe **como** um lembrete sai do
// crmclinica. A fila, o worker, a auditoria e os testes não sabem, e por isso
// nada deles muda quando o protocolo real for conhecido.
//
// ------------------------------------------------------------------ o estado real
//
// O transporte do OpenClaw está confirmado: é um gateway **WebSocket** (o proxy
// aceita upgrade; não existe REST em /api). O que **não** está confirmado é o
// envelope: não se sabe se é JSON-RPC, se os campos vão em `params`, se há `id`,
// nem qual é a sequência do handshake de autenticação. Os detalhes e as
// evidências estão em `docs/OPENCLAW.md`.
//
// Escrever um cliente WebSocket a partir desses fragmentos seria adivinhar o
// protocolo. Um envio "bem-sucedido" contra um envelope inventado não entrega
// mensagem nenhuma — e, pior, a fila marcaria 'enviado' e ninguém descobriria
// até um paciente reclamar que nunca recebeu nada.
//
// Por isso `PROTOCOLO_CONFIRMADO` é `false`, e enquanto for:
//
//   • o adaptador opera em `dry_run`: valida, registra, audita, mas **não envia**;
//   • pedir modo `real` não faz o adaptador improvisar — ele recusa, com o
//     código `openclaw_protocolo_desconhecido`, dizendo o que falta;
//   • a fila registra `modo_entrega = 'dry_run'` em toda linha processada, e
//     esse campo aparece em todo lugar que mostra a fila.
//
// Ligar o envio real quando o protocolo for documentado é: virar a constante
// para `true`, implementar `enviarDeVerdade` e apontar `OPENCLAW_LEMBRETES_MODO`
// para `real`. Nenhum outro arquivo precisa mudar.

const PROTOCOLO_CONFIRMADO = false;

const O_QUE_FALTA = Object.freeze([
  'o envelope das mensagens do gateway WebSocket (formato, campos, se é JSON-RPC)',
  'a sequência do handshake de autenticação (token, senha, id de sessão)',
  'o método que envia mensagem de saída para um número de WhatsApp',
]);

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
 * @param {object} configuracao  `configuracao.openclaw` mais `lembretes`.
 * @param {object} dependencias  `registrar` (log) e `enviarReal` (injeção nos testes).
 */
function criarAdaptadorDeLembretes(configuracao = {}, dependencias = {}) {
  const registrar = dependencias.registrar
    || ((mensagem, dados) => console.log(`[lembretes] ${mensagem}`, JSON.stringify(dados)));

  const modoPedido = String(configuracao.modoEntrega || 'dry_run').toLowerCase();
  const credenciado = Boolean(configuracao.baseUrl && configuracao.token);

  // O modo efetivo nunca é mais ousado que o pedido, e nunca é 'real' sem
  // protocolo confirmado. Quem pede 'real' sem ter como recebe o erro na cara,
  // não uma degradação silenciosa para dry-run.
  const exigiuReal = modoPedido === 'real';
  const podeReal = PROTOCOLO_CONFIRMADO && credenciado && typeof dependencias.enviarReal === 'function';
  const modo = exigiuReal && podeReal ? 'real' : 'dry_run';

  function porqueNaoEnviaDeVerdade() {
    if (!PROTOCOLO_CONFIRMADO) return 'o envelope do protocolo do OpenClaw não está confirmado (docs/OPENCLAW.md)';
    if (!credenciado) return 'faltam OPENCLAW_BASE_URL e OPENCLAW_TOKEN';
    if (typeof dependencias.enviarReal !== 'function') return 'o cliente de envio real não foi implementado';
    return null;
  }

  return {
    modo,
    protocoloConfirmado: PROTOCOLO_CONFIRMADO,
    oQueFalta: O_QUE_FALTA,

    /** Retrato para health check e para a rota de resumo. Sem segredo nenhum. */
    descrever() {
      return {
        orquestrador: 'OpenClaw',
        modo,
        protocolo_confirmado: PROTOCOLO_CONFIRMADO,
        credenciado,
        // Em dry-run isto é o que a operação precisa ler para não se enganar.
        significado: modo === 'real'
          ? 'as mensagens saem de verdade'
          : 'nenhuma mensagem sai: a fila roda completa e o envio é simulado',
        ...(modo === 'dry_run' ? { motivo: porqueNaoEnviaDeVerdade(), falta: O_QUE_FALTA } : {}),
      };
    },

    /**
     * Entrega um lembrete.
     *
     * Em `dry_run` devolve `entregue: false` — a fila registra 'enviado' com
     * `modo_entrega: 'dry_run'`, e nenhum lugar do sistema afirma que a mensagem
     * chegou a alguém.
     */
    async enviar(envelope) {
      validarEnvelope(envelope);

      if (modo === 'real') {
        const resposta = await dependencias.enviarReal(envelope);
        return {
          entregue: true,
          modo: 'real',
          referencia: resposta?.referencia ?? resposta?.id ?? null,
        };
      }

      if (exigiuReal) {
        // Pediram envio real e não há como. Falhar aqui é o comportamento certo:
        // o alternativo seria a clínica achar que está lembrando pacientes.
        throw new ErroDeEntrega(
          `envio real indisponível: ${porqueNaoEnviaDeVerdade()}`,
          'openclaw_protocolo_desconhecido',
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
  };
}

module.exports = {
  criarAdaptadorDeLembretes,
  ErroDeEntrega,
  PROTOCOLO_CONFIRMADO,
  O_QUE_FALTA,
};
