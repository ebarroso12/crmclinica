'use strict';

const {
  criarClienteGateway, carregarOuCriarIdentidade, ErroDeGateway, ESCOPOS_DE_CANAL,
} = require('./openclaw-gateway');

// Faz a decisão do CRM valer para quem atende o paciente.
//
// A Serena que responde no WhatsApp é um agente do OpenClaw. Ela lê a mensagem e
// responde sozinha, sem passar pelo CRM — então o interruptor do painel, a grade
// de horário e o botão de pausa não a alcançavam. Eram controles que pareciam
// funcionar e não desligavam nada: a tela dizia "desligada" enquanto o paciente
// continuava recebendo resposta automática.
//
// O gateway expõe `config.get` e `config.set`, que leem e gravam o arquivo de
// configuração da instância. É por aí que a decisão do CRM chega ao agente.
//
// ------------------------------------------------------------------ o mecanismo
//
// `dmPolicy` decide quem tem direito a resposta automática numa conversa direta:
//
//   • `open`      — qualquer pessoa; é o modo de atendimento
//   • `allowlist` — só quem está em `allowFrom`; com a lista vazia, ninguém
//
// Calar com uma lista vazia, e não desligando o canal, é deliberado: o telefone
// continua vinculado e conectado, as mensagens continuam chegando, e a equipe
// segue atendendo pelo celular. Desligar o canal exigiria escanear o QR de novo
// toda vez que a Serena tirasse um turno de folga.

/** Reescreve a política de conversa direta preservando o resto do arquivo. */
function aplicarPoliticaNoTexto(textoBruto, atender) {
  const configuracao = JSON.parse(textoBruto);

  configuracao.channels = configuracao.channels ?? {};
  configuracao.channels.whatsapp = configuracao.channels.whatsapp ?? {};

  const canal = configuracao.channels.whatsapp;
  canal.dmPolicy = atender ? 'open' : 'allowlist';
  canal.allowFrom = atender ? ['*'] : [];

  // O arquivo é editado à mão no servidor de vez em quando; manter a indentação
  // evita que cada mudança automática apareça como reescrita do arquivo inteiro.
  return `${JSON.stringify(configuracao, null, 2)}\n`;
}

/** Lê a política vigente sem alterá-la. */
function lerPoliticaDoTexto(textoBruto) {
  let configuracao;
  try {
    configuracao = JSON.parse(textoBruto);
  } catch {
    return { atendendo: null, motivo: 'configuração do gateway ilegível' };
  }

  const canal = configuracao?.channels?.whatsapp ?? {};
  const lista = Array.isArray(canal.allowFrom) ? canal.allowFrom : [];

  return {
    atendendo: canal.dmPolicy === 'open' || (canal.dmPolicy === 'allowlist' && lista.includes('*')),
    dmPolicy: canal.dmPolicy ?? null,
    allowFrom: lista,
  };
}

/**
 * @param {object} configuracao  mesma forma de `canalClinica` em `src/config.js`
 * @param {object} dependencias  `cliente` para injeção nos testes
 */
function criarPoliticaDoCanal(configuracao = {}, dependencias = {}) {
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
      timeoutMs: configuracao.timeoutMs ?? 30000,
      // Reescrever a configuração da instância é administração, não envio.
      escopos: ESCOPOS_DE_CANAL,
    });
    return cliente;
  }

  return {
    /** O que o agente está fazendo agora, segundo o próprio gateway. */
    async ler() {
      const atual = await conectar().chamar('config.get', {});
      if (!atual?.raw) {
        return { atendendo: null, motivo: 'o gateway não devolveu a configuração' };
      }
      return lerPoliticaDoTexto(atual.raw);
    },

    /**
     * Estado com o hash da versão lida, para quem for gravar em seguida.
     *
     * O gateway recusa `config.set` sem `baseHash`: é o que impede uma escrita
     * nossa de apagar uma alteração que alguém fez no servidor entre a nossa
     * leitura e a nossa gravação.
     */
    async lerComVersao() {
      const atual = await conectar().chamar('config.get', {});
      if (!atual?.raw) {
        throw new ErroDeGateway('o gateway não devolveu a configuração', 'config_ausente');
      }
      return { ...lerPoliticaDoTexto(atual.raw), raw: atual.raw, hash: atual.hash ?? null };
    },

    /**
     * Manda o agente atender ou calar.
     *
     * Devolve `alterado: false` quando já estava no estado pedido — isto é
     * chamado a cada minuto pelo worker, e gravar o arquivo sessenta vezes por
     * hora para não mudar nada é desgaste sem propósito, além de encher o
     * histórico de alterações com ruído.
     */
    async definir(atender) {
      const gateway = conectar();
      const vigente = await this.lerComVersao();

      if (vigente.atendendo === atender) {
        return { alterado: false, atendendo: atender };
      }

      // `baseHash` é a versão que acabamos de ler. Se alguém alterou o arquivo
      // no servidor nesse intervalo, o gateway recusa em vez de deixar a nossa
      // escrita apagar a alteração dele em silêncio.
      await gateway.chamar('config.set', {
        raw: aplicarPoliticaNoTexto(vigente.raw, atender),
        ...(vigente.hash ? { baseHash: vigente.hash } : {}),
      });

      return { alterado: true, atendendo: atender, de: vigente.atendendo };
    },

    async encerrar() {
      await cliente?.encerrar?.();
      cliente = dependencias.cliente ?? null;
    },
  };
}

module.exports = { criarPoliticaDoCanal, aplicarPoliticaNoTexto, lerPoliticaDoTexto };
