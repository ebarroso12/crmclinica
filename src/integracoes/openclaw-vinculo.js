'use strict';

const {
  criarClienteGateway, carregarOuCriarIdentidade, ErroDeGateway, ESCOPOS_DE_CANAL,
} = require('./openclaw-gateway');

// Estado do WhatsApp da clínica, para o painel.
//
// ----------------------------------------------------------- o que isto NÃO faz
//
// Não vincula. A tentativa anterior partia de que o gateway expunha a vinculação
// por RPC — `wizard.start` abre, `wizard.next` avança, um dos passos traz o QR —
// e isso não se confirmou: o `wizard.*` é o assistente de configuração geral do
// gateway, não o do WhatsApp, e `channels.login` só existe no CLI. O resultado
// era um botão que girava sem entregar.
//
// Quem vincula é o comando `vincular-whatsapp`, no servidor. Este módulo apenas
// **lê**: diz qual telefone está conectado, e devolve o QR se algum dia o gateway
// passar a publicá-lo em `wizard.status`.
//
// ------------------------------------------------------- por que só leitura
//
// A tela repete a consulta a cada 5s. Qualquer chamada que altere estado seria
// executada dezenas de vezes por vinculação: `wizard.start` reiniciaria o
// assistente e trocaria o QR que a pessoa está no meio de escanear, e
// `wizard.next` empurraria o assistente às cegas, sem resposta preenchida.
//
// Pelo mesmo motivo não há `cancelar`: cancelar um assistente que este módulo
// nunca abriu só poderia derrubar o de outra pessoa — na prática, o do admin com
// o `vincular-whatsapp` rodando no terminal, no exato momento em que ele fecha a
// janela do navegador.

/**
 * Falhas de transporte: a pergunta não chegou ao gateway, ou a resposta não
 * voltou. Só estas viram 503.
 *
 * O teste não pode ser o prefixo `gateway_`: o cliente carimba esse prefixo em
 * cima do código que o *gateway* devolveu, então uma recusa de aplicação —
 * método inexistente, nenhum assistente aberto — sairia daqui como 503 e
 * esconderia a instrução manual, que é o caminho que funciona hoje.
 *
 * Estes três nascem deste lado, sem resposta do outro (ver as construções de
 * `ErroDeGateway` em `openclaw-gateway.js`). Os de configuração —
 * `gateway_sem_url`, `gateway_sem_identidade`, `identidade_invalida` — não
 * entram porque `conectar()` os lança antes do `try`, e nunca chegam a este
 * catch. `openclaw_nao_pareado` também fica de fora: é permanente, e "tente de
 * novo" esconderia o que a pessoa precisa fazer — quando vier de
 * `channels.status`, sobe direto para a rota, que o traduz.
 */
const FALHAS_DE_TRANSPORTE = new Set([
  'gateway_timeout',
  'gateway_desconectado',
  'gateway_indisponivel',
]);

/** Acha o QR na resposta do wizard, sem depender de um caminho fixo. */
function extrairQr(passo) {
  if (!passo || typeof passo !== 'object') return null;

  // O passo pode trazer o QR em lugares diferentes conforme a versão; procurar
  // pela forma (data URL de imagem) é mais estável que fixar o caminho.
  const candidatos = [
    passo.qr, passo.qrDataUrl, passo.qrPng,
    passo.data?.qr, passo.data?.qrDataUrl,
    passo.payload?.qr, passo.payload?.qrDataUrl,
    passo.step?.qr, passo.step?.qrDataUrl,
  ];

  for (const valor of candidatos) {
    if (typeof valor === 'string' && valor.startsWith('data:image')) return valor;
  }

  // Varredura rasa como último recurso: o wizard é dado do gateway, não entrada
  // de usuário, e o custo de não achar o QR é a tela ficar inútil.
  for (const valor of Object.values(passo)) {
    if (typeof valor === 'string' && valor.startsWith('data:image')) return valor;
    if (valor && typeof valor === 'object') {
      const dentro = extrairQr(valor);
      if (dentro) return dentro;
    }
  }

  return null;
}

/**
 * @param {object} configuracao  `{ url, token, deviceToken, chavePrivada, identidadePath, timeoutMs }`
 * @param {object} dependencias  `cliente` para injeção nos testes.
 */
function criarVinculoDeCanal(configuracao = {}, dependencias = {}) {
  let cliente = dependencias.cliente ?? null;

  function conectar() {
    if (cliente) return cliente;
    if (!configuracao.url) {
      throw new ErroDeGateway('gateway do canal não configurado', 'gateway_sem_url', { permanente: true });
    }

    const identidade = carregarOuCriarIdentidade(configuracao.identidadePath, configuracao.chavePrivada);
    cliente = criarClienteGateway({
      url: configuracao.url,
      token: configuracao.token || null,
      deviceToken: configuracao.deviceToken || null,
      identidade,
      timeoutMs: configuracao.timeoutMs ?? 30000,
      // Vincular canal é administração do gateway: os escopos de mensagem não bastam.
      escopos: ESCOPOS_DE_CANAL,
    });
    return cliente;
  }

  return {
    /** Estado do canal: é o que decide se a tela mostra "conectar" ou "conectado". */
    async estado() {
      const status = await conectar().chamar('channels.status', {});
      const canal = status?.channels?.whatsapp ?? null;

      return {
        vinculado: canal?.linked === true,
        conectado: canal?.connected === true,
        numero: canal?.self?.e164 ?? null,
        estado: canal?.statusState ?? 'desconhecido',
      };
    },

    /**
     * Devolve o QR do momento, se houver um assistente aberto publicando um.
     *
     * Não abre nada: quem abre é o `vincular-whatsapp` no servidor. Chamar de
     * novo é seguro e esperado — é como a tela acompanharia a troca do código,
     * que expira em segundos, sem o operador perceber.
     *
     * Sem QR, a resposta é `{ vinculado: false, qr: null }` e a rota completa
     * com o passo a passo manual. Esse é o caminho normal hoje, não o de exceção.
     */
    async obterQr() {
      const gateway = conectar();

      // Já vinculado não tem QR a mostrar, e a pergunta seguinte seria inútil.
      const atual = await this.estado();
      if (atual.vinculado) return { vinculado: true, qr: null, ...atual };

      let passo = null;
      try {
        passo = await gateway.chamar('wizard.status', {});
      } catch (erro) {
        // "Não consegui perguntar" e "perguntei, e não há assistente aberto" são
        // respostas opostas, e só a primeira é falha. Distinguir pelo prefixo
        // `gateway_` não serve: o cliente carimba esse mesmo prefixo em cima do
        // código que o gateway devolveu, então uma recusa de aplicação — método
        // inexistente, nenhum wizard aberto — sairia daqui como 503, escondendo
        // a instrução manual, que é justamente o caminho que funciona hoje.
        if (FALHAS_DE_TRANSPORTE.has(erro.codigo)) throw erro;
        return { vinculado: false, qr: null };
      }

      const qr = extrairQr(passo);

      return {
        vinculado: false,
        qr,
        passo: passo?.step?.id ?? passo?.id ?? null,
        ...(qr ? {} : { motivo: 'o gateway não devolveu um QR neste passo' }),
      };
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarVinculoDeCanal, extrairQr, FALHAS_DE_TRANSPORTE };
