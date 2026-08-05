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

function criarNumerosInternos(lista = []) {
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

  return {
    /** Quantos números a clínica reconhece como seus. */
    get quantidade() { return internos.size; },

    /** É da equipe? */
    ehInterno(telefone) {
      if (!telefone) return false;
      const digitos = String(telefone).replace(/\D/g, '');
      if (internos.has(digitos)) return true;

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

module.exports = { criarNumerosInternos };
