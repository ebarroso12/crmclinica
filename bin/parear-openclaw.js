#!/usr/bin/env node
'use strict';

// Pareamento do crmclinica como dispositivo do gateway OpenClaw.
//
//   npm run parear-openclaw
//
// Por que existe: o gateway não concede escopo a quem chega só com o token
// compartilhado. Quem envia mensagem precisa de `operator.write`, e escopo vem
// de **dispositivo pareado** — uma chave Ed25519 que o gateway conhece e um
// operador aprovou uma vez. É o mesmo caminho que o CLI oficial e o app usam.
//
// O que este comando faz:
//   1. gera (ou reaproveita) a chave Ed25519 do crmclinica;
//   2. conecta ao gateway e pede pareamento;
//   3. quando aprovado, guarda o `deviceToken` emitido.
//
// A aprovação é um ato humano deliberado, feito no servidor:
//
//   openclaw devices list                  # vê o pedido pendente
//   openclaw devices approve <requestId>   # aprova
//
// A chave privada **não** entra no repositório. Ela vive no arquivo apontado
// por `OPENCLAW_DEVICE_IDENTITY_PATH` (padrão: `.openclaw-identidade.json`, que
// o `.gitignore` protege), ou em `OPENCLAW_DEVICE_PRIVATE_KEY` para ambientes
// sem disco gravável, como a Vercel.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const {
  carregarOuCriarIdentidade, descreverIdentidade, criarClienteGateway,
} = require('../src/integracoes/openclaw-gateway');

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const amarelo = (t) => `\x1b[33m${t}\x1b[0m`;
const vermelho = (t) => `\x1b[31m${t}\x1b[0m`;

async function main() {
  const configuracao = carregarConfiguracao();
  const gateway = configuracao.openclaw.gateway;

  if (!gateway.url) {
    console.error(vermelho('OPENCLAW_GATEWAY_URL não está definida.'));
    console.error('Exemplo: OPENCLAW_GATEWAY_URL=wss://openclaw.exemplo.com.br/ws');
    process.exit(1);
  }
  if (!gateway.token && !gateway.deviceToken) {
    console.error(vermelho('É preciso OPENCLAW_GATEWAY_TOKEN para o primeiro pareamento.'));
    console.error('Depois de pareado, o deviceToken emitido basta.');
    process.exit(1);
  }

  const identidade = carregarOuCriarIdentidade(gateway.identidadePath, gateway.chavePrivada);
  const retrato = descreverIdentidade(identidade);

  console.log(`\nGateway:   ${gateway.url}`);
  console.log(`deviceId:  ${retrato.deviceId}`);
  console.log(`identidade: ${retrato.origem}\n`);

  const cliente = criarClienteGateway({ ...gateway, identidade });

  try {
    const sessao = await cliente.conectar();

    console.log(verde('Pareado.'));
    console.log(`  papel:   ${sessao.auth?.role ?? '—'}`);
    console.log(`  escopos: ${(sessao.auth?.scopes ?? []).join(', ') || '—'}`);

    const status = await cliente.chamar('channels.status', {});
    const zap = status?.channels?.whatsapp;
    console.log(`\nCanal WhatsApp: ${zap?.connected ? verde('conectado') : vermelho('desconectado')}`
      + `${zap?.self?.e164 ? ` (${zap.self.e164})` : ''}`);

    if (sessao.auth?.deviceToken) {
      console.log(`\n${amarelo('Guarde no .env (não versionado):')}`);
      console.log(`OPENCLAW_DEVICE_TOKEN=${sessao.auth.deviceToken}`);
      console.log('\nCom ele, o worker conecta sem depender do token compartilhado do gateway.');
    }
  } catch (erro) {
    if (erro.codigo === 'openclaw_nao_pareado') {
      console.log(amarelo('Pedido de pareamento registrado. Falta aprovar no servidor:\n'));
      console.log(`  openclaw devices list`);
      console.log(`  openclaw devices approve ${erro.requestId ?? '<requestId>'}\n`);
      console.log('Depois rode este comando de novo.');
      process.exit(2);
    }
    console.error(vermelho(`\nFalha: ${erro.message}\n`));
    process.exit(1);
  } finally {
    await cliente.encerrar();
  }
}

main().catch((erro) => {
  console.error(vermelho(`\nFalha ao parear: ${erro.message}\n`));
  process.exit(1);
});
