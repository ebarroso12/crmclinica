'use strict';

const {
  criarClienteGateway, carregarOuCriarIdentidade, ErroDeGateway, ESCOPOS_DE_CANAL,
} = require('./openclaw-gateway');

// Conversa com a Serena sem passar pelo WhatsApp.
//
// Existe para que dê para testar o prompt antes de soltá-lo no telefone da
// clínica. Sem isto, a única forma de saber como ela responde é mandar alguém
// escrever para o número real — e foi assim que a equipe descobriu, com paciente
// na linha, que ela publicava o próprio raciocínio na conversa.
//
// A sessão é do painel (`dashboard`), não do canal: nada aqui toca o WhatsApp,
// nenhuma mensagem sai para telefone nenhum, e o paciente fictício não vira
// contato no CRM.
//
// ------------------------------------------------------------------ o mecanismo
//
// Três passos, porque o gateway responde de forma assíncrona:
//
//   1. `sessions.create` abre a conversa e devolve uma `sessionKey`
//   2. `chat.send` entrega a mensagem e volta na hora com `status: started`
//   3. `chat.history` traz a conversa inteira quando o modelo terminou
//
// O passo 2 não espera o modelo pensar. Quem chama precisa consultar o histórico
// depois — e é por isso que `enviar` e `historico` são separados: a tela mostra
// a pergunta imediatamente e preenche a resposta quando ela chega.

/**
 * Qual gateway o laboratório usa para gerar a resposta de ensaio.
 *
 * Comando 5 / frente 10: até aqui o laboratório dependia só do gateway da
 * CLÍNICA — ponto único de falha. A Evolution (canal efetivo de entrega
 * desde o Comando 4) não é uma alternativa válida aqui: ela só transporta
 * WhatsApp, não tem sessão nem modelo — quem GERA a resposta da Serena é
 * sempre uma sessão OpenClaw (`sessions.create`/`chat.send`), com ou sem
 * WhatsApp de verdade atrás dela. O que existe para reaproveitar, no mesmo
 * espírito de "principal, depois reserva" de `canal-conversas.js`, são os
 * DOIS gateways de sessão que este sistema já tem:
 *
 *   1. `canalClinica` (principal) — a mesma conexão que a tela usa para
 *      vincular o WhatsApp da clínica; testar por ela reflete o canal que o
 *      painel já mostra.
 *   2. `comando` (reserva) — o gateway que `criarClienteOpenClaw` usa para
 *      o atendimento real (`crm_despacha`). Seguro para o laboratório
 *      porque `abrir()` sempre chama `sessions.create` (uma sessão NOVA);
 *      nunca reaproveita a sessão fixa (`OPENCLAW_SESSION_ID`) do
 *      atendimento — testar não mistura contexto com paciente real, mesmo
 *      compartilhando a conexão do gateway.
 *
 * Nenhum dos dois configurado: `null`, e o chamador decide o 503 —
 * continua sendo o comportamento correto (falha fechada), não um bug.
 */
function escolherConfiguracaoDoLaboratorio({ canalClinica, comando } = {}) {
  if (canalClinica?.url) return canalClinica;
  if (comando?.url) return comando;
  return null;
}

/** Extrai o texto da resposta, que vem em formatos diferentes conforme o provedor. */
function textoDaMensagem(mensagem) {
  const conteudo = mensagem?.content;

  if (typeof conteudo === 'string') return conteudo;

  if (Array.isArray(conteudo)) {
    return conteudo
      .filter((parte) => parte?.type === 'text' && typeof parte.text === 'string')
      .map((parte) => parte.text)
      .join('\n')
      .trim();
  }

  return '';
}

/**
 * @param {object} configuracao  mesma forma de `canalClinica` em `src/config.js`
 * @param {object} dependencias  `cliente` para injeção nos testes
 */
function criarConversaDeTeste(configuracao = {}, dependencias = {}) {
  let cliente = dependencias.cliente ?? null;

  function conectar() {
    if (cliente) return cliente;
    if (!configuracao.url) {
      throw new ErroDeGateway('gateway do canal não configurado', 'gateway_sem_url', { permanente: true });
    }

    cliente = criarClienteGateway({
      url: configuracao.url,
      token: configuracao.token || null,
      deviceToken: configuracao.deviceToken || null,
      identidade: carregarOuCriarIdentidade(configuracao.identidadePath, configuracao.chavePrivada),
      // O modelo leva alguns segundos para responder, e a espera é do gateway.
      timeoutMs: configuracao.timeoutMs ?? 60000,
      escopos: ESCOPOS_DE_CANAL,
    });
    return cliente;
  }

  return {
    /**
     * Abre uma conversa nova. Cada teste começa do zero, sem herdar contexto.
     *
     * O modelo é escolhido aqui, na abertura, e vale para a conversa inteira.
     * Trocar no meio compararia respostas com históricos diferentes, que é
     * justamente o que impede saber qual modelo se saiu melhor.
     */
    async abrir({ agente = 'serena', modelo = null } = {}) {
      const sessao = await conectar().chamar('sessions.create', {
        agentId: agente,
        ...(modelo ? { model: modelo } : {}),
      });

      if (!sessao?.key) {
        throw new ErroDeGateway('o gateway não devolveu a sessão', 'sessao_ausente');
      }
      return { sessao: sessao.key, modelo };
    },

    /**
     * Entrega a mensagem e volta sem esperar a resposta.
     *
     * A `idempotencyKey` é exigida pelo gateway e evita que um clique duplo, ou
     * uma retentativa da rede, faça a Serena responder duas vezes à mesma frase.
     */
    async enviar({ sessao, texto, chave = null }) {
      if (!sessao) throw new ErroDeGateway('sessão não informada', 'sessao_ausente');

      const resultado = await conectar().chamar('chat.send', {
        sessionKey: sessao,
        message: String(texto ?? '').slice(0, 4000),
        idempotencyKey: chave ?? `teste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      return { enviado: true, execucao: resultado?.runId ?? null };
    },

    /** A conversa inteira, na ordem. É aqui que a resposta aparece. */
    async historico(sessao) {
      if (!sessao) throw new ErroDeGateway('sessão não informada', 'sessao_ausente');

      const dados = await conectar().chamar('chat.history', { sessionKey: sessao });
      const mensagens = Array.isArray(dados?.messages) ? dados.messages : [];

      return {
        mensagens: mensagens
          .map((mensagem) => ({
            // `toolResult` é o retorno de uma ferramenta, não fala de ninguém.
            // Rotulá-lo como paciente fazia a tela mostrar JSON e mensagem de
            // erro como se a pessoa tivesse escrito aquilo — e quem testa
            // concluiria que a Serena estava confusa, não que a ferramenta falhou.
            de: mensagem.role === 'assistant' ? 'serena'
              : (mensagem.role === 'user' ? 'paciente' : 'ferramenta'),
            texto: textoDaMensagem(mensagem),
            em: mensagem.timestamp ?? null,
            // Quem respondeu, dito pelo próprio gateway. Sem isto, comparar dois
            // modelos dependeria de lembrar qual foi escolhido em qual aba.
            modelo: mensagem.role === 'assistant' ? (mensagem.model ?? null) : null,
          }))
          // Mensagem sem texto é chamada de ferramenta ou marcação interna do
          // provedor: mostrá-la vazia sugeriria que a Serena respondeu nada.
          .filter((mensagem) => mensagem.texto.length > 0),
      };
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarConversaDeTeste, textoDaMensagem, escolherConfiguracaoDoLaboratorio };
