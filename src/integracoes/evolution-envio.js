'use strict';

// Envio de mensagem ao paciente pela Evolution API — via REST simples, sem
// depender de um processo de gateway sempre conectado (o WebSocket do
// OpenClaw, que hoje é a mesma instância que também gera a resposta
// automática indevida — ver integracoes/openclaw-plugin-crmclinica).
//
// É intencionalmente burro: um POST, uma resposta, sem fila nem retry
// próprio — a chave de idempotência de quem chama (`canal-conversas.js`,
// que já deriva de `origem:conversaId:mensagemId`) é o que evita duplicata
// do lado do CRM; a Evolution API não expõe idempotência nativa nesse
// endpoint, então uma reentrega de rede pode, na pior das hipóteses, mandar
// a mesma mensagem duas vezes — risco aceito por ora, documentado aqui para
// quem for revisar depois.

// Achado B-5 (docs/superpowers/plans/2026-08-13-achados-pendentes.md): um
// ECONNRESET depois do request já ter sido mandado é tão "indeterminado"
// quanto um TimeoutError/AbortError — a Evolution pode ter recebido e
// processado o envio antes da conexão cair; só a nossa leitura da resposta
// que não chegou. Sem esta checagem, esse erro caía no `throw` genérico
// abaixo (indeterminado = false) e a outbox reenviava a mesma mensagem ao
// paciente — mesma família de risco do M-1 (corrigido no Comando 7 via
// LEASE_MS), caminho de erro diferente. `erro.cause?.code` é onde o fetch
// nativo (undici) aninha o código do socket; `erro.code` cobre chamadas que
// já vêm com o erro de baixo nível direto (ex.: `fetchImpl` de teste).
function ehFalhaIndeterminada(erro) {
  if (erro.name === 'TimeoutError' || erro.name === 'AbortError') return true;
  return (erro.cause?.code ?? erro.code) === 'ECONNRESET';
}

function criarClienteEvolucaoEnvio(configuracao = {}, dependencias = {}) {
  const fetchImpl = dependencias.fetchImpl || globalThis.fetch;
  const disponivel = Boolean(configuracao.apiUrl && configuracao.apiKey && configuracao.instancia);

  return {
    disponivel,

    /**
     * Manda o texto pro número indicado. `telefone` já deve vir normalizado
     * (dígitos, com DDI) — quem chama (`canal-conversas.js`) faz isso antes
     * de escolher a via de envio, para as duas vias receberem o mesmo dado.
     */
    async enviar({ telefone, texto }) {
      if (!disponivel) throw new Error('Evolution API não configurada (EVOLUTION_API_URL/EVOLUTION_API_KEY)');
      if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

      const numero = String(telefone ?? '').replace(/\D/g, '');
      if (!numero) throw new Error('telefone inválido para envio pela Evolution');

      const base = configuracao.apiUrl.replace(/\/+$/, '');
      const url = `${base}/message/sendText/${encodeURIComponent(configuracao.instancia)}`;

      let resposta;
      try {
        resposta = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: configuracao.apiKey },
          body: JSON.stringify({
            number: numero,
            text: String(texto ?? ''),
            // Aninhado em `options`, não solto: é o formato confirmado por
            // teste real contra a instância de produção (HTTP 201).
            options: { delay: 1200, presence: 'composing' },
          }),
          signal: AbortSignal.timeout(configuracao.timeoutMs ?? 15000),
        });
      } catch (erro) {
        const falha = new Error(`falha de rede ao chamar a Evolution API: ${erro.message}`);
        // O timeout do AbortSignal (`TimeoutError`/`AbortError`) não diz que a
        // mensagem não saiu — diz que NÃO SABEMOS. A Evolution pode ter
        // recebido e processado o envio; só a nossa espera pela resposta é
        // que estourou. Retentar automaticamente aqui arrisca mandar a mesma
        // mensagem duas vezes ao paciente. Qualquer outro erro de rede (recusa
        // de conexão, DNS, etc.) acontece ANTES do pedido chegar ao servidor —
        // aí sim é seguro dizer "não foi enviada" e permitir retentativa.
        // ECONNRESET entra na mesma incerteza do timeout — ver `ehFalhaIndeterminada`.
        falha.indeterminado = ehFalhaIndeterminada(erro);
        throw falha;
      }

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        // Resposta HTTP de erro é o servidor dizendo "recebi e recusei" — não
        // é incerteza, é uma recusa conhecida. Seguro retentar.
        throw new Error(`Evolution API respondeu HTTP ${resposta.status}${corpo ? `: ${corpo.slice(0, 300)}` : ''}`);
      }

      const dados = await resposta.json().catch(() => null);
      const identificador = dados?.key?.id ?? dados?.id ?? null;
      return { identificador };
    },

    /**
     * Manda um anexo (imagem/documento/áudio/vídeo) pro número indicado.
     * `mediaUrl` é uma URL http(s) alcançável pela Evolution API (a leitura
     * assinada do Storage, de vida curta — ver supabase-storage.js). Mesmo
     * contrato de erro/timeout/indeterminado de `enviar`, acima.
     */
    async enviarMidia({ telefone, mediaUrl, tipo, legenda, nomeArquivo }) {
      if (!disponivel) throw new Error('Evolution API não configurada (EVOLUTION_API_URL/EVOLUTION_API_KEY)');
      if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

      const numero = String(telefone ?? '').replace(/\D/g, '');
      if (!numero) throw new Error('telefone inválido para envio pela Evolution');
      if (!mediaUrl) throw new Error('mediaUrl é obrigatório para envio de anexo');

      // O schema (mensagens.tipo) já distingue imagem/audio/documento/video;
      // a Evolution usa o mesmo vocabulário para `mediatype`, exceto que ela
      // não tem tipo "sistema"/"texto" — só chega aqui quem já é mídia.
      const mediatype = { imagem: 'image', documento: 'document', audio: 'audio', video: 'video' }[tipo];
      if (!mediatype) throw new Error(`tipo de mídia não suportado pela Evolution: ${tipo}`);

      const base = configuracao.apiUrl.replace(/\/+$/, '');
      const url = `${base}/message/sendMedia/${encodeURIComponent(configuracao.instancia)}`;

      let resposta;
      try {
        resposta = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: configuracao.apiKey },
          body: JSON.stringify({
            number: numero,
            mediatype,
            media: mediaUrl,
            ...(legenda ? { caption: String(legenda) } : {}),
            ...(nomeArquivo ? { fileName: String(nomeArquivo) } : {}),
            options: { delay: 1200, presence: 'composing' },
          }),
          signal: AbortSignal.timeout(configuracao.timeoutMs ?? 15000),
        });
      } catch (erro) {
        const falha = new Error(`falha de rede ao chamar a Evolution API (mídia): ${erro.message}`);
        falha.indeterminado = ehFalhaIndeterminada(erro);
        throw falha;
      }

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        throw new Error(`Evolution API respondeu HTTP ${resposta.status}${corpo ? `: ${corpo.slice(0, 300)}` : ''}`);
      }

      const dados = await resposta.json().catch(() => null);
      const identificador = dados?.key?.id ?? dados?.id ?? null;
      return { identificador };
    },
  };
}

module.exports = { criarClienteEvolucaoEnvio };
