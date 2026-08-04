'use strict';

const {
  criarClienteGateway, carregarOuCriarIdentidade, ErroDeGateway, ESCOPOS_DE_CANAL,
} = require('./openclaw-gateway');

// Vinculação do WhatsApp da clínica, pelo painel.
//
// Sem isto, conectar o telefone da clínica exigia SSH no servidor e um comando
// de terminal com o celular na mão — algo que ninguém da clínica ia fazer, e que
// na prática significava depender de quem tem acesso ao servidor toda vez que a
// sessão do WhatsApp caísse. E ela cai: troca de aparelho, celular sem bateria
// por dias, WhatsApp desconectando aparelhos antigos.
//
// ------------------------------------------------------------------ o mecanismo
//
// O gateway expõe um **wizard**: `wizard.start` abre, `wizard.next` avança, e
// um dos passos é `scanQr` — que traz o QR já renderizado como PNG em data URL.
// O plugin do WhatsApp o produz em `renderQrPngDataUrl`.
//
// O QR expira em segundos e é substituído por outro enquanto ninguém escaneia.
// Por isso a rota devolve o QR atual a cada chamada, e a tela repete a chamada:
// entregar um QR e deixá-lo na tela produziria um código morto que a pessoa
// tenta escanear sem entender por que não funciona.

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
     * Abre (ou retoma) a vinculação e devolve o QR do momento.
     *
     * Chamar de novo é seguro e esperado: cada chamada traz o QR atual, que é
     * como a tela acompanha a troca do código sem o operador perceber.
     */
    async obterQr() {
      const gateway = conectar();

      // Já vinculado: não há QR a mostrar, e abrir o wizard derrubaria a sessão
      // existente — o oposto do que quem clicou no botão espera.
      const atual = await this.estado();
      if (atual.vinculado) return { vinculado: true, qr: null, ...atual };

      // Só leitura. A tela repete esta chamada a cada 5s, e qualquer coisa que
      // altere estado aqui é executada dezenas de vezes por vinculação:
      // `wizard.start` reiniciaria o assistente e trocaria o QR que a pessoa
      // está no meio de escanear, e `wizard.next` empurraria um assistente de
      // configuração geral às cegas, sem nenhuma resposta preenchida.
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

    /** Cancela a vinculação em andamento — o botão "fechar" da tela. */
    async cancelar() {
      try {
        await conectar().chamar('wizard.cancel', {});
        return { cancelado: true };
      } catch {
        // Não havia wizard aberto. Fechar o que já está fechado não é erro.
        return { cancelado: false };
      }
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarVinculoDeCanal, extrairQr, FALHAS_DE_TRANSPORTE };
