'use strict';

// Registro de idempotência com interface deliberadamente pequena.
// Hoje mora em memória; quando o CRM ganhar banco, basta outra implementação
// com os mesmos três métodos — o restante do sistema não muda.

const JANELA_PADRAO_MS = 24 * 60 * 60 * 1000;
const CAPACIDADE_PADRAO = 5000;

function criarRegistroEmMemoria({ janelaMs = JANELA_PADRAO_MS, capacidade = CAPACIDADE_PADRAO, agora = Date.now } = {}) {
  const registros = new Map();

  function expirar() {
    const limite = agora() - janelaMs;
    for (const [chave, entrada] of registros) {
      if (entrada.registradoEm <= limite) registros.delete(chave);
    }
  }

  return {
    /** Devolve o resultado já produzido para a chave, ou null se for a primeira vez. */
    consultar(chave) {
      const entrada = registros.get(chave);
      if (!entrada) return null;
      if (entrada.registradoEm <= agora() - janelaMs) {
        registros.delete(chave);
        return null;
      }
      return entrada.resultado;
    },

    /** Guarda o resultado da primeira execução. Reescrever a mesma chave é ignorado. */
    registrar(chave, resultado) {
      if (registros.has(chave)) return registros.get(chave).resultado;
      expirar();
      // Descarta o registro mais antigo em vez de crescer sem limite.
      if (registros.size >= capacidade) {
        const maisAntigo = registros.keys().next();
        if (!maisAntigo.done) registros.delete(maisAntigo.value);
      }
      registros.set(chave, { registradoEm: agora(), resultado });
      return resultado;
    },

    tamanho() {
      return registros.size;
    },
  };
}

module.exports = { criarRegistroEmMemoria, JANELA_PADRAO_MS };
