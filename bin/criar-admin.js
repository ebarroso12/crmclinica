#!/usr/bin/env node
'use strict';

// Cria ou promove o administrador master no banco configurado.
//
//   npm run criar-admin
//
// Lê `CRMCLINICA_MASTER_EMAIL` e `CRMCLINICA_MASTER_SENHA` do ambiente. Rodar de
// novo é seguro: se a conta já existe, a senha **não** é sobrescrita — quem já
// trocou não volta para a senha do arquivo de configuração.

const fs = require('node:fs');
const path = require('node:path');

// Mesmo carregamento do `.env` que o servidor faz: o script precisa enxergar as
// mesmas variáveis, ou criaria o admin com uma configuração diferente da que roda.
const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { semearMaster } = require('../src/seguranca/semear-master');

async function main() {
  const configuracao = carregarConfiguracao();

  if (!configuracao.banco.configurado) {
    console.error('[crmclinica] CRMCLINICA_DATABASE_URL não está definida.');
    console.error('             Sem banco, o admin criado sumiria no próximo reinício.');
    process.exit(1);
  }
  if (!configuracao.master.email) {
    console.error('[crmclinica] defina CRMCLINICA_MASTER_EMAIL no ambiente.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);

  try {
    const resultado = await semearMaster(repositorio, configuracao.master);

    if (resultado.criado) {
      console.log(`[crmclinica] admin master criado: ${configuracao.master.email} (id ${resultado.id})`);
      console.log('[crmclinica] a troca de senha será exigida no primeiro acesso.');
    } else if (resultado.promovido) {
      console.log(`[crmclinica] conta existente promovida a admin master (id ${resultado.id}).`);
      console.log('[crmclinica] a senha atual foi mantida.');
    } else if (resultado.motivo) {
      console.error(`[crmclinica] nada foi feito: ${resultado.motivo}`);
      process.exitCode = 1;
    } else {
      console.log(`[crmclinica] o admin master já existe (id ${resultado.id}). Senha mantida.`);
    }
  } finally {
    await encerrarPool();
  }
}

main().catch((erro) => {
  console.error('[crmclinica] falha ao criar o admin master:', erro.message);
  process.exit(1);
});
