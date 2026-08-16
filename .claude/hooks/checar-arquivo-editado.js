#!/usr/bin/env node
'use strict';

// PostToolUse — depois de Edit/Write/MultiEdit num arquivo .js, roda
// `node --check` nele. É o equivalente de formatter/lint que este projeto
// tem disponível de verdade: sem eslint/prettier (testes/auditoria.test.js
// proíbe dependência de terceiros além de `pg` — instalar um linter aqui
// quebraria essa garantia), então o gate rápido e honesto é sintaxe válida.
//
// Não roda em arquivos fora do repositório, não roda em .sql/.md/.json —
// só no que `node --check` sabe validar. Rápido de propósito: isto dispara
// a cada edição, não pode virar a suíte inteira (isso é papel do hook de Stop).

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function lerStdin() {
  return new Promise((resolve) => {
    let dados = '';
    process.stdin.on('data', (pedaco) => { dados += pedaco; });
    process.stdin.on('end', () => resolve(dados));
  });
}

async function main() {
  const bruto = await lerStdin();
  let evento;
  try {
    evento = JSON.parse(bruto);
  } catch {
    process.exit(0);
  }

  const alvo = evento?.tool_input?.file_path ?? '';
  if (!alvo || !alvo.endsWith('.js')) process.exit(0);

  const cwd = evento?.cwd ?? process.cwd();
  const relativo = path.relative(cwd, alvo);
  // Fora do repositório (scratch, temp) — não é nosso trabalho validar.
  if (relativo.startsWith('..')) process.exit(0);

  const resultado = spawnSync(process.execPath, ['--check', alvo], { encoding: 'utf8' });
  if (resultado.status !== 0) {
    process.stderr.write(
      `node --check falhou em ${relativo}:\n${resultado.stderr || resultado.stdout}\n`
      + 'Corrija o erro de sintaxe antes de seguir — este arquivo não compila.\n',
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
