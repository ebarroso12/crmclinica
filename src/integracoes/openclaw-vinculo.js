'use strict';

const {
  criarClienteGateway, carregarOuCriarIdentidade, ErroDeGateway, ESCOPOS_DE_CANAL,
} = require('./openclaw-gateway');

// Vinculação do WhatsApp da clínica, pelo painel.
//
// --------------------------------------------------------------- o que faz
//
// O método é `web.login.start`, e ele devolve `{ qrDataUrl, message }` — o QR
// pronto, como PNG em data URL. O painel mostra, a pessoa escaneia, acabou.
//
// Duas rodadas anteriores concluíram que "o gateway não expõe vinculação". A
// conclusão era falsa, e vale registrar como se erra assim: a lista de métodos
// vem no `hello` e tem **220 nomes**; a primeira sondagem imprimiu os primeiros
// ~150 e eu li a lista truncada como se fosse inteira. `web.login.start` e
// `web.login.wait` estavam logo depois do corte.
//
// O que de fato não existe: `channels.login`, `.link`, `.pair`, `.qr` — o
// gateway responde "unknown method". E `wizard.*` é o assistente de
// configuração geral, que trava numa nota com `executor: "client"`. Procurar
// pelo nome errado durante duas rodadas foi o custo de não ter lido a lista até
// o fim logo na primeira.
//
// `channels.logout` existe, para desvincular — ainda não usado aqui.
//
// --------------------------------------------- por que a tela pode repetir
//
// A tela pede o QR a cada 5s. Isso só é seguro porque `web.login.start` é
// idempotente enquanto o código está vivo: devolve o mesmo `qrDataUrl` e diz
// "QR already active". Foi medido — duas chamadas seguidas retornam a mesma
// string.
//
// É exatamente o que o `wizard.*` não fazia: lá, chamar de novo reiniciava o
// assistente e trocava o código no meio do escaneamento.
//
// Não há `cancelar`. O QR expira sozinho, e um cancelamento disparado ao fechar
// a janela derrubaria também o login que outra pessoa tivesse aberto pela
// interface do OpenClaw.

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

/**
 * O endereço da interface de controle do OpenClaw, derivado do gateway.
 *
 * `wss://host/clinica/ws` → `https://host/clinica/`. Derivar em vez de pedir
 * mais uma variável: as duas apontam para a mesma instância por definição, e
 * duas variáveis que precisam concordar são duas variáveis que um dia discordam.
 *
 * É por essa tela que o telefone é vinculado — ver o cabeçalho deste arquivo.
 */
function urlDoControle(urlDoGateway) {
  if (!urlDoGateway) return null;
  try {
    const url = new URL(urlDoGateway);
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
    url.pathname = url.pathname.replace(/ws\/?$/, '');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

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
     * Abre o login do WhatsApp Web e devolve o QR — o de verdade, para escanear.
     *
     * `web.login.start` devolve `{ qrDataUrl, message }`, com o QR já pronto
     * como PNG em data URL. Chamar de novo **não** reinicia nada: enquanto o
     * código está vivo, o gateway devolve o mesmo e responde "QR already
     * active". É isso que torna o polling da tela seguro — e é a diferença
     * entre este método e o `wizard.*`, que reiniciava o assistente a cada
     * chamada e trocava o código no meio do escaneamento.
     */
    async obterQr() {
      const gateway = conectar();

      // Já vinculado não tem QR a mostrar, e abrir o login derrubaria a sessão.
      const atual = await this.estado();
      if (atual.vinculado) return { vinculado: true, qr: null, ...atual };

      let login = null;
      try {
        login = await gateway.chamar('web.login.start', {});
      } catch (erro) {
        // "Não consegui perguntar" e "perguntei, e o gateway recusou" são
        // respostas opostas, e só a primeira é indisponibilidade. Distinguir
        // pelo prefixo `gateway_` não serve: o cliente carimba esse mesmo
        // prefixo em cima do código que o gateway devolveu, então uma recusa de
        // aplicação sairia daqui como 503 e esconderia o caminho manual.
        if (FALHAS_DE_TRANSPORTE.has(erro.codigo)) throw erro;
        return { vinculado: false, qr: null };
      }

      const qr = extrairQr(login);

      return {
        vinculado: false,
        qr,
        mensagem: login?.message ?? null,
        ...(qr ? {} : { motivo: 'o gateway não devolveu um QR desta vez' }),
      };
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = {
  criarVinculoDeCanal, extrairQr, urlDoControle, FALHAS_DE_TRANSPORTE,
};
