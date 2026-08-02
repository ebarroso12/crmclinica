'use strict';

const { ErroDeContrato } = require('../contratos/erros');

// Erro de corpo grande demais. Vira HTTP 413 e interrompe a leitura sem
// derrubar a conexão antes da resposta sair.
class ErroCorpoExcedido extends Error {
  constructor(limiteBytes) {
    super(`corpo excede o limite de ${limiteBytes} bytes`);
    this.name = 'ErroCorpoExcedido';
    this.limiteBytes = limiteBytes;
  }
}

/**
 * Lê o corpo da requisição com teto rígido de bytes.
 * Devolve o texto bruto — a assinatura do webhook é conferida sobre ele, antes do JSON.parse.
 */
function lerCorpoBruto(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    let encerrado = false;

    const finalizar = (executar) => {
      if (encerrado) return;
      encerrado = true;
      req.removeListener('data', aoReceber);
      req.removeListener('end', aoTerminar);
      req.removeListener('error', aoFalhar);
      executar();
    };

    function aoReceber(pedaco) {
      total += pedaco.length;
      if (total > limiteBytes) {
        // Para de acumular e devolve o controle: quem chamou responde 413.
        req.pause();
        finalizar(() => reject(new ErroCorpoExcedido(limiteBytes)));
        return;
      }
      pedacos.push(pedaco);
    }

    function aoTerminar() {
      finalizar(() => resolve(Buffer.concat(pedacos).toString('utf8')));
    }

    function aoFalhar(erro) {
      finalizar(() => reject(erro));
    }

    req.on('data', aoReceber);
    req.on('end', aoTerminar);
    req.on('error', aoFalhar);
  });
}

function interpretarJson(bruto) {
  if (!bruto) throw new ErroDeContrato('corpo vazio');
  try {
    return JSON.parse(bruto);
  } catch {
    throw new ErroDeContrato('corpo não é JSON válido');
  }
}

module.exports = { lerCorpoBruto, interpretarJson, ErroCorpoExcedido };
