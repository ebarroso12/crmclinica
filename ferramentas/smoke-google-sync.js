#!/usr/bin/env node
'use strict';

// Smoke seguro da sincronia Google. Não usa credenciais, banco nem calendário
// real: executa o protocolo completo contra o Google falso versionado na suíte
// (ETag, paginação, cursor, conflitos, outbox e reconciliação).
//
//   npm run smoke-google
//
// Para qualquer ensaio contra Google real, use o procedimento operacional e
// um calendário de teste; este comando é propositalmente incapaz de enviar ou
// alterar dados de produção.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const resultado = spawnSync(process.execPath, [
  '--test',
  'testes/google-outbox.test.js',
  'testes/google-sincronia.test.js',
], {
  cwd: raiz,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

if (resultado.error) {
  console.error(`Smoke Google não iniciou: ${resultado.error.message}`);
  process.exit(1);
}

process.exit(resultado.status ?? 1);
