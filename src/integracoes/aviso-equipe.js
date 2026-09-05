'use strict';

// Aviso para a equipe interna da clínica: o resumo completo do lead e o aviso
// de marcação. Um veículo só, o mesmo que já entrega mensagem a paciente todo
// dia — a Evolution API, com o gateway do OpenClaw como reserva.
//
// ----------------------------------------------------------- por que mudou
//
// Até aqui o veículo era `execFile('openclaw', …)`: uma CLI que existe no VPS
// e **não existe na função serverless da Vercel**, que é justamente onde a
// rota do agente roda. Toda chamada falhava no callback, virava uma linha de
// log que ninguém lê e a rota respondia `{ enviado: true }`. O aviso nunca
// chegava a ninguém e nada no sistema acusava — foi assim que o Dr. Edson
// passou semanas sem receber resumo de lead achando que o recurso existia.
//
// Agora o canal é injetado por quem monta a aplicação (o mesmo
// `canal-conversas` do inbox), o envio é aguardado e o resultado é dito: se
// não saiu, a resposta diz que não saiu.

// Números humanos que recebem os avisos internos. A lista real deve vir de
// `CRMCLINICA_RESUMO_DESTINATARIOS` (ou `CRM_AVISO_EQUIPE`); este padrão fica
// como última rede para não regredir uma instalação que nunca as definiu.
const PADRAO = Object.freeze(['+5516992943215', '+5516993624116', '+5516997522881']);

function resolverNumeros(configurados = []) {
  const doAmbiente = String(process.env.CRM_AVISO_EQUIPE || '').trim();
  if (doAmbiente) return doAmbiente.split(',').map((n) => n.trim()).filter(Boolean);
  if (Array.isArray(configurados) && configurados.length > 0) return configurados.slice();
  return PADRAO.slice();
}

/** O aviso mínimo de marcação. Mantido para quem ainda o chama. */
function textoDeMarcacao(dados) {
  let mensagem = 'Nova marcacao - Dr. Edson\n';
  mensagem += `Paciente: ${(dados && dados.nome) || 'paciente'}`;
  if (dados && dados.telefone) mensagem += ` | Tel: ${dados.telefone}`;
  mensagem += `\nData: ${(dados && dados.quando) || ''}`;
  mensagem += '\n(aviso automatico do CRM)';
  return mensagem;
}

/**
 * @param {object} dependencias.canal  quem entrega (canal-conversas)
 * @param {string[]} dependencias.destinatarios  telefones da equipe
 */
function criarAvisoDeEquipe({ canal = null, destinatarios = [] } = {}) {
  const alvos = resolverNumeros(destinatarios);

  async function disparar(mensagem, chave) {
    const texto = String(mensagem || '').trim();
    if (!canal?.enviar || alvos.length === 0 || !texto) {
      return { enviados: 0, falhas: [], motivo: 'sem canal, sem destinatários ou sem texto' };
    }

    const falhas = [];
    let enviados = 0;
    for (const destino of alvos) {
      try {
        await canal.enviar({
          telefone: destino,
          texto,
          ...(chave ? { chave: `${chave}:${destino}` } : {}),
        });
        enviados += 1;
      } catch (erro) {
        falhas.push(erro.message);
        console.error(`[aviso-equipe] falha ao avisar a equipe: ${erro.message}`);
      }
    }
    return { enviados, falhas };
  }

  return {
    disponivel: Boolean(canal?.enviar) && alvos.length > 0,
    /** Quantas pessoas recebem — número nenhum sai daqui. */
    get quantidade() { return alvos.length; },

    /**
     * Resumo COMPLETO do lead, montado pela Serena a partir da conversa.
     * NUNCA vai para o paciente: quem chama passa só o texto interno.
     */
    async enviarResumo(texto, { chave = null } = {}) {
      return disparar(texto, chave);
    },

    async avisarMarcacao(dados, { chave = null } = {}) {
      return disparar(textoDeMarcacao(dados), chave);
    },
  };
}

module.exports = { criarAvisoDeEquipe, textoDeMarcacao, PADRAO };
