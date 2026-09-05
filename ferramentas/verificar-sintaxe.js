#!/usr/bin/env node
'use strict';

// `npm run verificar` — checagem de sintaxe de todo o JavaScript do projeto.
//
// ------------------------------------------------------------ por que mudou
//
// Até aqui isto era uma linha só no package.json: 175 `node --check` ligados
// por `&&`, 8.425 caracteres. No Linux funciona; no **Windows não**, porque o
// `cmd.exe` corta a linha de comando em 8.191 caracteres. O job `windows` do
// CI passou a falhar em `npm run verificar` em 0s, sem nenhum arquivo estar
// errado — só o comando não cabia.
//
// A lista à mão tinha um segundo defeito, mais antigo e mais silencioso:
// arquivo novo só era checado se alguém lembrasse de registrá-lo ali. Já
// aconteceu de vários arquivos do Instagram ficarem de fora do build original
// exatamente assim.
//
// Este script varre as pastas de código e checa TUDO que encontra. Não há mais
// lista para crescer, para estourar limite de sistema operacional, nem para
// alguém esquecer de atualizar.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PASTAS = ['api', 'bin', 'ferramentas', 'integracoes', 'public', 'servicos', 'src', 'testes'];
const IGNORADAS = new Set(['node_modules', '.git', 'tmp', 'coverage']);

// Um por núcleo, com teto: 175 processos em série levam quase um minuto, e
// todos de uma vez estouram o limite de processos em máquina pequena.
const SIMULTANEOS = 8;

function listarJs(diretorio, encontrados = []) {
  let entradas;
  try {
    entradas = fs.readdirSync(diretorio, { withFileTypes: true });
  } catch {
    return encontrados; // pasta opcional que não existe neste checkout
  }

  for (const entrada of entradas) {
    if (IGNORADAS.has(entrada.name)) continue;
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) listarJs(caminho, encontrados);
    else if (entrada.isFile() && entrada.name.endsWith('.js')) encontrados.push(caminho);
  }

  return encontrados;
}

function checar(arquivo) {
  return new Promise((resolver) => {
    execFile(process.execPath, ['--check', arquivo], (erro, _saida, saidaDeErro) => {
      resolver(erro ? { arquivo, erro: String(saidaDeErro || erro.message).trim() } : null);
    });
  });
}

async function main() {
  const arquivos = PASTAS
    .flatMap((pasta) => listarJs(path.join(RAIZ, pasta)))
    .sort();

  if (arquivos.length === 0) {
    console.error('nenhum arquivo .js encontrado — a varredura está olhando no lugar errado');
    process.exit(1);
  }

  const falhas = [];
  const fila = arquivos.slice();

  // Trabalhadores puxando da mesma fila: mantém o paralelismo constante em vez
  // de esperar o lote mais lento terminar antes de começar o próximo.
  await Promise.all(Array.from({ length: SIMULTANEOS }, async () => {
    for (let arquivo = fila.pop(); arquivo; arquivo = fila.pop()) {
      const falha = await checar(arquivo);
      if (falha) falhas.push(falha);
    }
  }));

  if (falhas.length > 0) {
    for (const falha of falhas.sort((a, b) => a.arquivo.localeCompare(b.arquivo))) {
      console.error(`\n${path.relative(RAIZ, falha.arquivo)}\n${falha.erro}`);
    }
    console.error(`\n${falhas.length} arquivo(s) com erro de sintaxe.`);
    process.exit(1);
  }

  console.log(`${arquivos.length} arquivos .js verificados, nenhum erro de sintaxe.`);
}

main().catch((erro) => {
  console.error(`falha na verificação: ${erro.message}`);
  process.exit(1);
});
