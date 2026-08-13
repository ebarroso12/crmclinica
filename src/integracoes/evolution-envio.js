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
        falha.indeterminado = erro.name === 'TimeoutError' || erro.name === 'AbortError';
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
  };
}

module.exports = { criarClienteEvolucaoEnvio };
