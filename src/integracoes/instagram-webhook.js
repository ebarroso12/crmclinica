'use strict';

// Adaptador do webhook de Instagram Messaging da Meta (Graph API) — mesmo
// papel que src/integracoes/evolution-webhook.js cumpre para o WhatsApp:
// só traduz o payload nativo do provedor (formato `entry[].messaging[]`)
// para o mesmo contrato interno que `normalizarEventoEvolution` produz
// (ver src/contratos/evento.js), sem nenhum efeito colateral.
//
// LIMITAÇÃO CONHECIDA E ACEITA (registrada aqui, não escondida): o formato
// exato de `entry[].messaging[]` usado abaixo é conhecimento de plataforma
// — documentação pública do Instagram Messaging / Messenger Platform da
// Meta — e NÃO foi verificado ainda contra um payload real capturado deste
// projeto, porque não existe integração de Instagram em produção aqui até
// este passo. Isto será validado contra payload real antes de ligar o
// webhook de verdade; qualquer divergência encontrada nessa validação deve
// ser corrigida então, não adivinhada agora.
//
// A Meta pode empacotar mais de um `entry`/`messaging` numa única chamada
// de webhook (batching). No mesmo espírito de `normalizarEventoEvolution`
// (que também traduz um único evento por chamada, `payload.data`), esta
// função processa apenas `entry[0].messaging[0]` — quem despachar o
// webhook de verdade é responsável por chamar esta função uma vez para
// cada item de `entry[].messaging[]`, não uma vez só para o payload
// inteiro.

const LIMITE_TEXTO = 8_000;

function texto(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

// `messaging.timestamp` do Instagram Messaging é epoch em MILISSEGUNDOS
// (diferente do `messageTimestamp` em segundos da Evolution) — sem
// heurística de conversão aqui, só interpretação direta do que a
// documentação promete.
function instanteIso(epochMs) {
  if (epochMs === undefined || epochMs === null || epochMs === '') return null;
  const numero = typeof epochMs === 'string' && /^\d+$/.test(epochMs) ? Number(epochMs) : epochMs;
  if (typeof numero !== 'number' || !Number.isFinite(numero) || numero <= 0) return null;
  const data = new Date(numero);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * Traduz um evento `messaging` do webhook de Instagram Messaging da Meta
 * para o contrato interno do CRM. Devolve `null` (nunca lança exceção)
 * quando o payload não é uma mensagem de paciente a processar:
 *
 *   - eco do próprio envio da clínica (`message.is_echo === true`) — mesmo
 *     raciocínio do `fromMe` da Evolution: não é entrada, é o que a própria
 *     clínica mandou;
 *   - evento de leitura ou entrega (`messaging.read`/`messaging.delivery`
 *     presentes em vez de `messaging.message`) — a Meta manda esses
 *     eventos no mesmo formato de `messaging[]`, sem corpo de mensagem;
 *   - payload malformado, incompleto, ou sem os campos mínimos
 *     (remetente, texto, id nativo da mensagem).
 *
 * Payload de provedor externo nunca deve derrubar o processo que o chama —
 * por isso "não sei processar isto" sempre vira `null`, nunca uma exceção.
 */
function normalizarEventoInstagram(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const entradas = Array.isArray(payload.entry) ? payload.entry : [];
  const primeiraEntrada = entradas[0];
  if (!primeiraEntrada || typeof primeiraEntrada !== 'object' || Array.isArray(primeiraEntrada)) return null;

  const eventosDeMensagem = Array.isArray(primeiraEntrada.messaging) ? primeiraEntrada.messaging : [];
  const evento = eventosDeMensagem[0];
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) return null;

  // Leitura/entrega não é mensagem: `messaging.read`/`messaging.delivery`
  // chegam SEM `messaging.message`. Ignorar aqui, como não-evento — não
  // como erro.
  if (!evento.message || typeof evento.message !== 'object' || Array.isArray(evento.message)) return null;

  // Eco do próprio envio da clínica pelo Instagram — não é entrada de
  // paciente.
  if (evento.message.is_echo === true) return null;

  const remetente = texto(evento.sender?.id);
  if (!remetente) return null;

  const conteudo = texto(evento.message.text);
  if (!conteudo) return null;

  const idNativo = texto(evento.message.mid);
  // Sem id nativo não há como formar `id_externo` no formato acordado
  // (`instagram:<remetente>:<id>`) — não existe fallback documentado para
  // este canal (diferente da Evolution, que tem um fallback próprio, ver
  // evolution-webhook.js), então inventar um formato alternativo aqui
  // seria arriscar colisão/duplicata silenciosa. Melhor recusar.
  if (!idNativo) return null;

  return {
    tipo: 'mensagem.recebida',
    canal: 'instagram',
    // PREFIXO NEUTRO, mesmo raciocínio de `normalizarEventoEvolution` (ver
    // o comentário lá): evita colisão de `id_externo` entre portas de
    // ingresso diferentes, se um dia existir mais de uma para este canal.
    id_externo: `instagram:${remetente}:${idNativo}`.slice(0, 200),
    remetente,
    // A Meta não manda nome de perfil no payload de `messaging` — buscar
    // via chamada extra à Graph API é decisão de escopo futuro, não
    // inventada aqui.
    nome: null,
    texto: conteudo.slice(0, LIMITE_TEXTO),
    origem: 'instagram_webhook',
    ocorrido_em: instanteIso(evento.timestamp),
  };
}

// `entry[].time` do webhook de comentários é epoch em SEGUNDOS (diferente de
// `messaging.timestamp`, em milissegundos, tratado por `instanteIso` acima) —
// mesma ressalva de conhecimento de plataforma não verificado feita no
// cabeçalho do arquivo: a documentação pública promete segundos aqui, mas
// isto não foi conferido contra um payload real de comentário.
function instanteIsoSegundos(epochSegundos) {
  if (epochSegundos === undefined || epochSegundos === null || epochSegundos === '') return null;
  const numero = typeof epochSegundos === 'string' && /^\d+$/.test(epochSegundos) ? Number(epochSegundos) : epochSegundos;
  if (typeof numero !== 'number' || !Number.isFinite(numero) || numero <= 0) return null;
  const data = new Date(numero * 1000);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * Traduz um evento de COMENTÁRIO do webhook do Instagram (`entry[].changes[]`
 * com `field: 'comments'`) para `{ comentario_id_externo, post_id,
 * autor_ig_id, autor_username, texto, ocorrido_em }`. Devolve `null` (nunca
 * lança) quando não há comentário de paciente a processar.
 *
 * MESMA RESSALVA do cabeçalho deste arquivo e de `normalizarEventoInstagram`:
 * o formato exato de `entry[].changes[]` para o campo `comments` é
 * conhecimento de plataforma (Webhooks de Comments da Instagram Graph API da
 * Meta) — NÃO verificado ainda contra um payload real capturado deste
 * projeto. Validar contra payload real antes de ligar este webhook de
 * verdade; qualquer divergência encontrada então deve ser corrigida ali, não
 * adivinhada agora.
 *
 * Achado A1.9-B (23/08): a lacuna "detectar comentário da própria clínica"
 * (sem equivalente a `message.is_echo` no payload de comentário) foi FECHADA
 * — a documentação de referência da Graph API (developers.facebook.com/docs/
 * graph-api/webhooks/reference/instagram) mostra `value.from.id` e
 * `value.from.self_ig_scoped_id`, e `self_ig_scoped_id` é o ID do autor do
 * comentário visto pela conta que recebeu o webhook — se o comentário for da
 * PRÓPRIA conta comercial, `from.id` (ou `self_ig_scoped_id`) bate com o
 * `contaComercialId` configurado. Passar `contaComercialId` (segundo
 * argumento, opcional) ativa esse corte; sem ele, mantém o comportamento
 * anterior (não filtra) — é assim que os testes existentes, sem essa
 * informação, continuam passando sem mudar.
 */
function normalizarValorDeComentario(valor, tempoDaEntrada, contaComercialId) {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;

  // Resposta a outro comentário — inclui a resposta pública que a PRÓPRIA
  // automação acabou de postar sob o comentário-gatilho. Sem este corte, uma
  // resposta de paciente à resposta pública da clínica reacionaria a
  // automação em cadeia. `parent_id` presente e não vazio = é uma resposta,
  // não um comentário raiz de post.
  if (texto(valor.parent_id)) return null;

  const comentarioIdExterno = texto(valor.id);
  // Sem id nativo do comentário não há chave de idempotência
  // (`instagram_comentarios_processados.comentario_id_externo`) — recusar,
  // mesmo raciocínio do `mid` ausente em `normalizarEventoInstagram`.
  if (!comentarioIdExterno) return null;

  const autorIgId = texto(valor.from?.id);
  if (!autorIgId) return null;

  // Comentário da própria clínica (ex.: a resposta pública que ESTA MESMA
  // automação acabou de postar, no raro caso de `parent_id` não vir
  // preenchido) — evita reagir ao próprio comentário. Só filtra quando o
  // chamador informou `contaComercialId`; sem ele, segue sem filtrar.
  const idAlternativo = texto(valor.from?.self_ig_scoped_id);
  if (contaComercialId && (autorIgId === contaComercialId || idAlternativo === contaComercialId)) return null;

  const conteudo = texto(valor.text);
  if (!conteudo) return null;

  return {
    comentario_id_externo: comentarioIdExterno,
    post_id: texto(valor.media?.id) || null,
    autor_ig_id: autorIgId,
    autor_username: texto(valor.from?.username) || null,
    texto: conteudo.slice(0, LIMITE_TEXTO),
    ocorrido_em: instanteIsoSegundos(tempoDaEntrada),
  };
}

/**
 * TODOS os comentários de uma chamada do webhook, na ordem em que a Meta os
 * empacotou.
 *
 * Achado de 05/09: `normalizarComentarioInstagram` (singular) lê só o primeiro
 * `entry` e o primeiro `changes` com `field: 'comments'`. A Meta empacota mais
 * de um evento na mesma chamada, e o resto era descartado com HTTP 200 — ou
 * seja, perdido sem reentrega e sem rastro. O singular continua existindo
 * porque é o contrato que os testes e o caminho antigo usam; quem processa em
 * produção deve usar este.
 */
function normalizarComentariosInstagram(payload = {}, { contaComercialId = null } = {}) {
  if (!payload || typeof payload !== 'object') return [];

  const entradas = Array.isArray(payload.entry) ? payload.entry : [];
  const comentarios = [];

  for (const entrada of entradas) {
    if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) continue;
    const mudancas = Array.isArray(entrada.changes) ? entrada.changes : [];
    for (const mudanca of mudancas) {
      if (!mudanca || typeof mudanca !== 'object' || Array.isArray(mudanca)) continue;
      if (mudanca.field !== 'comments') continue;
      const comentario = normalizarValorDeComentario(mudanca.value, entrada.time, contaComercialId);
      if (comentario) comentarios.push(comentario);
    }
  }

  return comentarios;
}

function normalizarComentarioInstagram(payload = {}, { contaComercialId = null } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const entradas = Array.isArray(payload.entry) ? payload.entry : [];
  const primeiraEntrada = entradas[0];
  if (!primeiraEntrada || typeof primeiraEntrada !== 'object' || Array.isArray(primeiraEntrada)) return null;

  const mudancas = Array.isArray(primeiraEntrada.changes) ? primeiraEntrada.changes : [];
  const mudancaDeComentario = mudancas.find(
    (item) => item && typeof item === 'object' && !Array.isArray(item) && item.field === 'comments',
  );
  if (!mudancaDeComentario) return null;

  return normalizarValorDeComentario(mudancaDeComentario.value, primeiraEntrada.time, contaComercialId);
}

module.exports = { normalizarEventoInstagram, normalizarComentarioInstagram, normalizarComentariosInstagram };
