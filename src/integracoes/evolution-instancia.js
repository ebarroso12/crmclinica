'use strict';

// Estado e pareamento de UMA instância da Evolution API, para o painel de
// operação dos agentes (docs/AGENTES.md, "Painel de operação").
//
// Só duas perguntas: "a instância está conectada?" e "me dá um código para
// conectar". Criar ou apagar instância e mexer em webhook NÃO passam por aqui —
// são operações de servidor, feitas uma vez, e um botão no painel que as fizesse
// poderia desligar a recepção de mensagens do número sem ninguém perceber.
//
// A apikey fica dentro deste módulo: nada do que ele devolve (resultado ou erro)
// carrega a chave nem a URL da Evolution. Erro vira mensagem curta com o código
// HTTP e um `status` que a rota repassa.

const PRAZO_MAXIMO_MS = 10000;

// Estados da Evolution (Baileys) traduzidos para o que a tela mostra.
const ESTADOS = Object.freeze({ open: 'conectado', close: 'desconectado', connecting: 'conectando' });

// QR vem como data URL de imagem. Qualquer outra coisa é descartada: o valor
// vai parar num `img.src` no navegador.
const QR_VALIDO = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const CODIGO_VALIDO = /^[A-Za-z0-9-]{4,16}$/;

function erroDaEvolution(mensagem, status, codigo) {
  const erro = new Error(mensagem);
  erro.status = status;
  erro.codigo = codigo;
  return erro;
}

function soDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

function criarClienteEvolucaoInstancia(configuracao = {}, { fetchImpl = globalThis.fetch } = {}) {
  const base = String(configuracao.apiUrl ?? '').replace(/\/+$/, '');
  const disponivel = Boolean(base && configuracao.apiKey);
  // Teto curto: a tela espera por isto com a pessoa olhando.
  const prazoMs = Math.min(Number(configuracao.timeoutMs) || PRAZO_MAXIMO_MS, PRAZO_MAXIMO_MS);

  async function pedir(caminho) {
    if (!disponivel) {
      throw erroDaEvolution('a Evolution API não está configurada no servidor', 503, 'evolution_nao_configurada');
    }
    let resposta;
    try {
      resposta = await fetchImpl(`${base}${caminho}`, {
        method: 'GET',
        headers: { apikey: configuracao.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(prazoMs),
      });
    } catch (erro) {
      if (erro?.name === 'TimeoutError' || erro?.name === 'AbortError') {
        throw erroDaEvolution('a Evolution não respondeu a tempo', 503, 'evolution_sem_resposta');
      }
      // A mensagem original do fetch pode citar o endereço: não sobe. 503 e não
      // 502/504 porque o tradutor de erro do http.js só repassa 400/403/404/409/
      // 422/503 — o resto vira "falha interna" e a tela perderia o motivo.
      throw erroDaEvolution('não foi possível falar com a Evolution', 503, 'evolution_inacessivel');
    }
    let corpo = null;
    try {
      corpo = await resposta.json();
    } catch {
      corpo = null;
    }
    return { status: resposta.status, corpo };
  }

  function exigirInstancia(instancia) {
    const nome = typeof instancia === 'string' ? instancia.trim() : '';
    if (!nome) throw erroDaEvolution('o agente não tem instância de WhatsApp', 422, 'instancia_ausente');
    return encodeURIComponent(nome);
  }

  return {
    disponivel,

    /** `{ estado, numero, perfil }` — estado: conectado, desconectado, conectando, inexistente ou desconhecido. */
    async estado(instancia) {
      const nome = exigirInstancia(instancia);
      const { status, corpo } = await pedir(`/instance/connectionState/${nome}`);
      if (status === 404) return { estado: 'inexistente', numero: null, perfil: null };
      if (status >= 400) throw erroDaEvolution(`a Evolution respondeu HTTP ${status}`, 503, 'evolution_http');

      const bruto = corpo?.instance?.state ?? corpo?.state ?? null;
      const resultado = { estado: ESTADOS[bruto] ?? 'desconhecido', numero: null, perfil: null };
      if (resultado.estado !== 'conectado') return resultado;

      // Número e nome do perfil são extras: sem eles o estado continua valendo.
      try {
        const lista = await pedir(`/instance/fetchInstances?instanceName=${nome}`);
        const item = Array.isArray(lista.corpo) ? lista.corpo[0] : null;
        const dono = item?.ownerJid ?? item?.instance?.owner ?? '';
        resultado.numero = soDigitos(String(dono).split('@')[0]) || null;
        const perfil = item?.profileName ?? item?.instance?.profileName;
        resultado.perfil = typeof perfil === 'string' && perfil.trim() ? perfil.trim().slice(0, 100) : null;
      } catch {
        // Fica só o estado.
      }
      return resultado;
    },

    /**
     * Pede à Evolution o código de pareamento (com número) e/ou o QR.
     * `{ ja_conectado, codigo_pareamento, qr }`.
     */
    async conectar(instancia, { numero = null } = {}) {
      const nome = exigirInstancia(instancia);
      const digitos = numero ? soDigitos(numero) : '';
      const { status, corpo } = await pedir(`/instance/connect/${nome}${digitos ? `?number=${digitos}` : ''}`);
      if (status === 404) throw erroDaEvolution('a instância não existe na Evolution', 404, 'instancia_inexistente');
      if (status >= 400) throw erroDaEvolution(`a Evolution respondeu HTTP ${status}`, 503, 'evolution_http');

      const estado = corpo?.instance?.state ?? corpo?.state ?? null;
      return {
        ja_conectado: estado === 'open',
        codigo_pareamento: typeof corpo?.pairingCode === 'string' && CODIGO_VALIDO.test(corpo.pairingCode)
          ? corpo.pairingCode
          : null,
        qr: typeof corpo?.base64 === 'string' && QR_VALIDO.test(corpo.base64) ? corpo.base64 : null,
      };
    },
  };
}

module.exports = { criarClienteEvolucaoInstancia, ESTADOS };
