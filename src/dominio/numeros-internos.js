'use strict';

const { normalizarTelefone } = require('./serena');

// Os números da clínica — quem opera, não quem é atendido.
//
// A Serena atende no telefone da clínica e reporta para os administradores. Sem
// distinguir os dois papéis, o resumo enviado ao Dr. Edson voltava pelo próprio
// canal, era lido como mensagem nova e virava um contato — com conversa aberta,
// lead no funil e resumo do resumo. Cada envio criava mais um, e em uma semana o
// inbox estaria cheio de atendimentos que nunca existiram.
//
// Um administrador escrevendo para a Serena está dando uma ordem, não pedindo
// consulta. O que ele manda não é atendimento e não entra no funil.

/**
 * Forma canônica de um celular brasileiro: 55 + DDD + 8 dígitos (sem o nono
 * dígito). 10 ou 11 dígitos sem o 55 ganham o 55. Fora do Brasil, os dígitos.
 * O DDD sempre entra na comparação — é o que o sufixo de 8 dígitos ignorava.
 */
function formaCanonica(digitos) {
  const comPais = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  if (comPais.startsWith('55') && comPais.length === 13 && comPais[4] === '9') return `${comPais.slice(0, 4)}${comPais.slice(5)}`;
  return comPais;
}

function criarNumerosInternos(lista = [], { porSufixo = true } = {}) {
  const internos = new Set();

  for (const bruto of lista) {
    try {
      // Guardado normalizado porque a comparação precisa valer com ou sem
      // máscara: o mesmo número chega como "+55 16 99294-3215" da configuração
      // e como "5516992943215" do gateway.
      internos.add(normalizarTelefone(bruto).replace(/\D/g, ''));
    } catch {
      // Número inválido na configuração não pode derrubar o worker: o efeito
      // seria a clínica inteira parar por causa de um dígito a mais.
    }
  }

  const canonicos = new Set([...internos].map(formaCanonica));

  return {
    /** Quantos números a clínica reconhece como seus. */
    get quantidade() { return internos.size; },

    /** É da equipe? */
    ehInterno(telefone) {
      if (!telefone) return false;
      const digitos = String(telefone).replace(/\D/g, '');
      if (internos.has(digitos)) return true;

      // Números do CADASTRO (auditoria B2): E.164 completo, só o nono dígito
      // normalizado nas duas formas — o DDD precisa bater. O sufixo de 8
      // dígitos abaixo fica só para a lista antiga do ambiente.
      if (!porSufixo) return canonicos.has(formaCanonica(digitos));

      // O Brasil escreve o mesmo celular com e sem o nono dígito. Sem esta
      // comparação, o mesmo administrador seria interno numa forma e paciente
      // na outra — e a conversa dele apareceria no inbox.
      for (const conhecido of internos) {
        if (conhecido.length !== digitos.length && conhecido.slice(-8) === digitos.slice(-8)) return true;
      }
      return false;
    },
  };
}

/**
 * Os números da equipe que vêm do CADASTRO (docs/RESUMOS.md): com o resumo indo
 * para o WhatsApp de cada pessoa, a resposta dela ao resumo — e o eco do próprio
 * resumo — chegam pelos webhooks como qualquer mensagem. Sem esta lista, cada
 * resumo abriria um "atendimento" com a própria equipe, na clínica e no agente.
 *
 * Lida do banco no máximo uma vez por `validadeMs` (por processo). Se a leitura
 * falhar, fica a última lista conhecida — nunca derruba o ingresso, e nunca
 * cala paciente por uma falha de banco.
 */
function criarNumerosInternosDoCadastro({ repositorio, validadeMs = 60_000, relogio = () => Date.now() } = {}) {
  // Carregado aqui, não no topo: destinatarios-resumo não depende deste módulo,
  // mas manter a dependência preguiçosa evita ciclo se um dia depender.
  const { telefonesInternosDoCadastro } = require('./destinatarios-resumo');
  let conhecidos = criarNumerosInternos([]);
  let lidoEm = null;
  let leitura = null;

  async function atualizar({ forcar = false } = {}) {
    if (!repositorio?.listarDestinatariosDeResumo) return conhecidos;
    if (!forcar && lidoEm !== null && relogio() - lidoEm < validadeMs) return conhecidos;
    if (!leitura) {
      leitura = (async () => {
        try {
          // E.164 completo, sem sufixo (auditoria B2): o sufixo de 8 dígitos
          // descartava cliente de outro DDD com o mesmo final.
          conhecidos = criarNumerosInternos(
            telefonesInternosDoCadastro(await repositorio.listarDestinatariosDeResumo()),
            { porSufixo: false },
          );
        } catch (erro) {
          console.error(`[numeros-internos] cadastro indisponível, segue a última lista: ${erro.message}`);
        } finally {
          lidoEm = relogio();
          leitura = null;
        }
      })();
    }
    await leitura;
    return conhecidos;
  }

  return {
    /**
     * É WhatsApp autorizado de alguém da equipe? O cache só vale para o SIM
     * (auditoria M1): com `confirmarNoBanco` (valor ou função, avaliada só
     * quando o cache diz NÃO), o cadastro é relido na hora — é o que pede quem
     * vai CRIAR contato, porque a pessoa pode ter sido autorizada depois da
     * última leitura.
     */
    async ehInterno(telefone, { confirmarNoBanco = false } = {}) {
      if (!telefone) return false;
      if ((await atualizar()).ehInterno(telefone)) return true;
      const confirmar = typeof confirmarNoBanco === 'function' ? await confirmarNoBanco() : confirmarNoBanco;
      if (!confirmar) return false;
      return (await atualizar({ forcar: true })).ehInterno(telefone);
    },
  };
}

module.exports = { criarNumerosInternos, criarNumerosInternosDoCadastro };
