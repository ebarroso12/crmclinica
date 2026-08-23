'use strict';

// Envio de mensagem ao paciente via Instagram Messaging API (Graph API da
// Meta) — mesmo modelo de evolution-envio.js: um POST, uma resposta, sem
// fila nem retry próprio. A chave de idempotência de quem chama
// (`canal-conversas.js`/`atendimento.js`) é o que evita duplicata do lado
// do CRM; este endpoint, como o da Evolution, não expõe idempotência
// nativa — uma reentrega de rede pode, na pior das hipóteses, mandar a
// mesma mensagem duas vezes.
//
// ATENÇÃO (documentado para quem for revisar/validar depois): o formato
// exato da resposta de sucesso (`{ recipient_id, message_id }`) e de erro
// (`{ error: { message, code, ... } }`) da Graph API abaixo é conhecimento
// de plataforma — NÃO foi verificado contra uma chamada real, porque não
// havia credencial de Instagram disponível no momento em que este arquivo
// foi escrito. Validar contra a API real assim que houver acesso.

const { ehFalhaIndeterminada } = require('./evolution-envio');

function criarClienteInstagramEnvio(configuracao = {}, dependencias = {}) {
  const fetchImpl = dependencias.fetchImpl || globalThis.fetch;
  const disponivel = Boolean(configuracao.accessToken && configuracao.contaComercialId);
  const apiVersion = configuracao.apiVersion || 'v23.0';

  // Núcleo compartilhado do round-trip HTTP com a Graph API — extraído de
  // enviar() para ser reaproveitado por enviarBotaoWhatsapp() sem duplicar
  // URL, timeout, tratamento de erro HTTP não-2xx e disciplina de
  // ehFalhaIndeterminada. Não faz as checagens de disponivel/fetchImpl nem
  // validação de destinatário — isso fica em cada método público, na mesma
  // ordem que já existia em enviar(), pra não alterar o comportamento
  // observável de quem já chama esse arquivo.
  async function enviarPayload(mensagem) {
    const url = `https://graph.instagram.com/${apiVersion}/me/messages`;

    let resposta;
    try {
      resposta = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${configuracao.accessToken}`,
        },
        body: JSON.stringify(mensagem),
        signal: AbortSignal.timeout(configuracao.timeoutMs ?? 15000),
      });
    } catch (erro) {
      const falha = new Error(`falha de rede ao chamar a Graph API do Instagram: ${erro.message}`);
      // Mesma disciplina de evolution-envio.js: timeout/AbortError e
      // ECONNRESET pós-envio não dizem que a mensagem não saiu — dizem
      // que não sabemos. A Graph API pode ter recebido e processado o
      // envio antes da conexão cair ou do relógio estourar; só a nossa
      // leitura da resposta que não chegou. Retentar aqui arrisca mandar
      // a mesma mensagem duas vezes ao paciente.
      falha.indeterminado = ehFalhaIndeterminada(erro);
      throw falha;
    }

    if (!resposta.ok) {
      // Resposta HTTP de erro é a Graph API dizendo "recebi e recusei" —
      // não é incerteza, é uma recusa conhecida. Seguro retentar.
      const corpoErro = await resposta.json().catch(() => null);
      const mensagemErro = corpoErro?.error?.message;
      throw new Error(mensagemErro || `Graph API do Instagram respondeu HTTP ${resposta.status}`);
    }

    const dados = await resposta.json().catch(() => null);
    const identificador = dados?.message_id ?? null;
    if (!identificador) throw new Error('a Graph API não confirmou o envio');

    return { identificador };
  }

  return {
    disponivel,

    /**
     * Manda o texto pro destinatário indicado. O parâmetro continua se
     * chamando `telefone` por compatibilidade com a interface existente de
     * `canal-conversas.js` (mesmo nome usado pela Evolution) — no
     * Instagram não é telefone nenhum, é o PSID (page-scoped id) que
     * identifica o contato na Graph API.
     */
    async enviar({ telefone, texto }) {
      if (!disponivel) {
        throw new Error('Instagram API não configurada (accessToken/contaComercialId)');
      }
      if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

      const destinatario = String(telefone ?? '').trim();
      if (!destinatario) throw new Error('destinatário inválido para envio pelo Instagram');

      return enviarPayload({
        recipient: { id: destinatario },
        message: { text: String(texto ?? '') },
      });
    },

    /**
     * Manda um template de botão (link) linkando pro WhatsApp — usado
     * quando a conversa no Instagram precisa migrar de canal. Mesma
     * infraestrutura de enviar() (URL, timeout, tratamento de erro),
     * só muda o corpo da mensagem. `numeroWhatsapp` chega pronto (só
     * dígitos com código do país) — quem chama já validou/normalizou,
     * não é responsabilidade daqui.
     */
    async enviarBotaoWhatsapp({ telefone, numeroWhatsapp, texto }) {
      if (!disponivel) {
        throw new Error('Instagram API não configurada (accessToken/contaComercialId)');
      }
      if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

      const destinatario = String(telefone ?? '').trim();
      if (!destinatario) throw new Error('destinatário inválido para envio pelo Instagram');

      return enviarPayload({
        recipient: { id: destinatario },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text: String(texto ?? ''),
              buttons: [
                {
                  type: 'web_url',
                  url: `https://wa.me/${numeroWhatsapp}`,
                  title: 'Falar no WhatsApp',
                },
              ],
            },
          },
        },
      });
    },

    /**
     * Responde publicamente a um comentário (visível a todo mundo, embaixo
     * do comentário original) — a metade pública do requisito do gatilho:
     * "resposta pública no comentário E DM privada, sempre as duas".
     *
     * Endpoint diferente do envio de DM: `POST /{comment-id}/replies`, corpo
     * `{ message: texto }` (confirmado contra a documentação de referência
     * da Graph API — developers.facebook.com/docs/marketing-api/reference/
     * instagram-comment/replies — em 23/08). ATENÇÃO: essa referência é do
     * produto "Instagram API with Facebook Login" (host graph.facebook.com);
     * o resto deste arquivo usa "Instagram API with Instagram Login" (host
     * graph.instagram.com, o mesmo de `enviar()`/`enviarBotaoWhatsapp()`).
     * Mantido `graph.instagram.com` aqui por consistência com o resto da
     * integração — se a conta em uso for do outro produto, o host pode
     * precisar mudar. Não verificado contra uma chamada real (sem
     * credencial disponível) — validar antes de confiar em produção.
     */
    async responderComentarioPublicamente({ comentarioIdExterno, texto }) {
      if (!disponivel) {
        throw new Error('Instagram API não configurada (accessToken/contaComercialId)');
      }
      if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');

      const idDoComentario = String(comentarioIdExterno ?? '').trim();
      if (!idDoComentario) throw new Error('id de comentário inválido para resposta pública');

      const url = `https://graph.instagram.com/${apiVersion}/${idDoComentario}/replies`;
      let resposta;
      try {
        resposta = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${configuracao.accessToken}`,
          },
          body: JSON.stringify({ message: String(texto ?? '') }),
          signal: AbortSignal.timeout(configuracao.timeoutMs ?? 15000),
        });
      } catch (erro) {
        const falha = new Error(`falha de rede ao responder comentário no Instagram: ${erro.message}`);
        falha.indeterminado = ehFalhaIndeterminada(erro);
        throw falha;
      }

      if (!resposta.ok) {
        const corpoErro = await resposta.json().catch(() => null);
        const mensagemErro = corpoErro?.error?.message;
        throw new Error(mensagemErro || `Graph API do Instagram respondeu HTTP ${resposta.status}`);
      }

      const dados = await resposta.json().catch(() => null);
      // A resposta de sucesso deste endpoint devolve o id da nova réplica
      // (`{ id: "..." }") — formato diferente do envio de DM
      // (`{ recipient_id, message_id }`), documentado como tal na referência.
      const identificador = dados?.id ?? null;
      if (!identificador) throw new Error('a Graph API não confirmou a resposta pública ao comentário');

      return { identificador };
    },

    async encerrar() {
      // Sem estado nenhum pra fechar: cada enviar() é um POST isolado, sem
      // conexão persistente (mesmo modelo stateless de evolution-envio.js,
      // que nem chega a expor este método). Existe aqui só para manter a
      // mesma forma de retorno que os outros clientes de canal expõem
      // (ver `criarCanalDeConversas`, em canal-conversas.js).
    },
  };
}

module.exports = { criarClienteInstagramEnvio };
