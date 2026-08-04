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

const WIZARD_DO_WHATSAPP = 'whatsapp';

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

      let passo;
      try {
        passo = await gateway.chamar('wizard.start', { wizard: WIZARD_DO_WHATSAPP });
      } catch (erro) {
        // Wizard já aberto de uma tentativa anterior: seguir de onde parou é
        // melhor que falhar e obrigar a reiniciar o gateway.
        if (!/already|em andamento|in progress/i.test(erro.message)) throw erro;
        passo = await gateway.chamar('wizard.status', {});
      }

      let qr = extrairQr(passo);

      // O QR costuma aparecer depois de um ou dois passos do wizard.
      for (let avanco = 0; avanco < 4 && !qr; avanco += 1) {
        passo = await gateway.chamar('wizard.next', {});
        qr = extrairQr(passo);
      }

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

module.exports = { criarVinculoDeCanal, extrairQr };
