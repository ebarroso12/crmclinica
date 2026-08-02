'use strict';

const { criarServidor } = require('../src/servidor/http');
const { carregarConfiguracao } = require('../src/config');

// Ambiente de teste: nenhuma variável real, nenhum segredo de produção, nenhuma chamada de rede.
const AMBIENTE_BASE = Object.freeze({
  NODE_ENV: 'test',
  PORT: '0',
  CRMCLINICA_DATABASE_URL: '',
  OPENCLAW_BASE_URL: '',
  OPENCLAW_TOKEN: '',
  OPENCLAW_WEBHOOK_SECRET: '',
  SERENA_BASE_URL: '',
  KIMI_API_KEY: '',
});

function configuracaoDeTeste(sobrescritas = {}) {
  return carregarConfiguracao({ ...AMBIENTE_BASE, ...sobrescritas });
}

/**
 * Sobe o servidor numa porta livre e devolve utilitários de requisição.
 * O chamador é responsável por `await ambiente.encerrar()`.
 */
async function subirServidor(dependencias = {}) {
  const configuracao = dependencias.configuracao || configuracaoDeTeste();
  const servidor = criarServidor({ ...dependencias, configuracao });

  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  return {
    base,
    configuracao,
    pedir: (caminho, opcoes) => fetch(`${base}${caminho}`, opcoes),
    encerrar: () => new Promise((resolve, reject) => {
      servidor.close((erro) => (erro ? reject(erro) : resolve()));
    }),
  };
}

module.exports = { AMBIENTE_BASE, configuracaoDeTeste, subirServidor };
