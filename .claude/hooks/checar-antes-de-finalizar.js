#!/usr/bin/env node
'use strict';

// Stop — antes de aceitar que a sessão terminou, se há mudança não
// commitada no working tree, exige os gates do projeto: `npm run
// verificar` (sintaxe) e `npm test` (suíte). Só roda quando há mudança de
// verdade — sessão que só leu/conversou não paga o custo de ~30-40s da
// suíte inteira.
//
// `stop_hook_active`: o próprio Claude Code manda esse campo quando já
// está reentrando por causa de um bloqueio anterior deste mesmo hook —
// sem checar isso, gates que continuam falhando (ou um bug no hook)
// travariam a sessão num loop sem saída. Na reentrada, deixa passar.

const { spawnSync } = require('node:child_process');

function lerStdin() {
  return new Promise((resolve) => {
    let dados = '';
    process.stdin.on('data', (pedaco) => { dados += pedaco; });
    process.stdin.on('end', () => resolve(dados));
  });
}

function rodar(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, shell: true, encoding: 'utf8', timeout: 180_000 });
}

async function main() {
  const bruto = await lerStdin();
  let evento;
  try {
    evento = JSON.parse(bruto);
  } catch {
    process.exit(0);
  }

  if (evento?.stop_hook_active) process.exit(0);

  const cwd = evento?.cwd ?? process.cwd();

  const status = rodar('git', ['status', '--short'], cwd);
  if (status.status !== 0 || !status.stdout || !status.stdout.trim()) {
    // Sem git, ou sem mudança pendente: nada a exigir.
    process.exit(0);
  }

  const verificar = rodar('npm', ['run', 'verificar'], cwd);
  if (verificar.status !== 0) {
    process.stderr.write(
      'Há mudança não commitada e `npm run verificar` falhou — não finaliza '
      + `assim.\n\n${(verificar.stdout || '') + (verificar.stderr || '')}\n`,
    );
    process.exit(2);
  }

  const teste = rodar('npm', ['test'], cwd);
  if (teste.status !== 0) {
    const saida = (teste.stdout || '') + (teste.stderr || '');
    // A suíte é grande — manda só a cauda (onde ficam os resumos de falha).
    const cauda = saida.split('\n').slice(-60).join('\n');
    process.stderr.write(
      'Há mudança não commitada e `npm test` falhou — não finaliza assim.\n\n'
      + `${cauda}\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
