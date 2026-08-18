#!/usr/bin/env node
'use strict';

// Compara a configuração de produção (Vercel) com a do VPS — sem nunca ler
// nem imprimir valor de segredo, só NOMES de variável e o valor de uma
// única exceção deliberada (ver abaixo).
//
//   node ferramentas/checar-drift-configuracao.js
//
// Achado do incidente de 2026-08-17: a Vercel tinha SERENA_TRANSPORTE_WHATSAPP
// vazia enquanto o VPS tinha "crm_despacha" — ninguém tinha como enxergar
// esse desalinhamento sem entrar nos dois painéis manualmente e comparar de
// cabeça. Esta ferramenta automatiza só ISSO: não aplica nada, não corrige
// nada, só relata.
//
// Requer, na máquina que roda este script (não no CRM em si — é ferramenta
// de operador, não roda em produção):
//   - `vercel` CLI autenticado (`vercel login`) e o projeto linkado
//     (`vercel link` já rodado neste diretório).
//   - Acesso SSH ao VPS configurado (chave já aceita, sem senha) — o host é
//     lido de CRMCLINICA_VPS_SSH_HOST (ex.: "root@meu-servidor.exemplo"),
//     NUNCA hardcoded aqui: o endereço da máquina não é segredo, mas também
//     não é algo para deixar público em código versionado.
//
// Sem essas duas coisas configuradas, a ferramenta avisa o que falta e sai
// — nunca finge um resultado.

const { execFileSync } = require('node:child_process');

const HOST_VPS = process.env.CRMCLINICA_VPS_SSH_HOST || '';
const CAMINHO_ENV_VPS = process.env.CRMCLINICA_VPS_ENV_PATH || '/opt/crmclinica-ponte/.env';

// A ÚNICA variável cujo VALOR este script compara diretamente — porque não
// é segredo (é um enum de arquitetura: 'crm_despacha' ou 'openclaw_gerencia',
// ver src/config.js) e porque foi exatamente essa a que causou o incidente.
// Qualquer outra variável, mesmo aqui, só entra por NOME.
const VALOR_SEGURO_PARA_COMPARAR = 'SERENA_TRANSPORTE_WHATSAPP';

function executarOuFalhar(comando, args, contexto) {
  try {
    return execFileSync(comando, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (erro) {
    throw new Error(`falha ao ${contexto}: ${erro.message}`);
  }
}

/** Só nomes de variável — nunca chama isto pedindo o corpo inteiro do .env. */
function nomesDoEnvNaVps() {
  const saida = executarOuFalhar(
    'ssh',
    [HOST_VPS, `grep -oE '^[A-Z_]+=' '${CAMINHO_ENV_VPS}' | sed 's/=$//'`],
    'ler os nomes de variável do .env no VPS',
  );
  return new Set(saida.split('\n').map((linha) => linha.trim()).filter(Boolean));
}

function valorSeguroNaVps() {
  const saida = executarOuFalhar(
    'ssh',
    [HOST_VPS, `grep '^${VALOR_SEGURO_PARA_COMPARAR}=' '${CAMINHO_ENV_VPS}' | cut -d'=' -f2-`],
    `ler ${VALOR_SEGURO_PARA_COMPARAR} do VPS`,
  );
  return saida.trim() || '(ausente)';
}

/** Só nomes de variável — `vercel env ls` nunca mostra valor de nada. */
function nomesNaVercel() {
  const saida = executarOuFalhar('vercel', ['env', 'ls', 'production'], 'listar variáveis da Vercel');
  const nomes = new Set();
  for (const linha of saida.split('\n')) {
    const casou = /^\s*([A-Z][A-Z0-9_]*)\s+/.exec(linha);
    if (casou) nomes.add(casou[1]);
  }
  return nomes;
}

function valorSeguroNaVercel() {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const arquivoTemporario = path.join(os.tmpdir(), `crmclinica-drift-${process.pid}.env`);
  try {
    executarOuFalhar(
      'vercel',
      ['env', 'pull', arquivoTemporario, '--environment=production', '--yes'],
      'baixar a configuração de produção da Vercel',
    );
    const conteudo = fs.readFileSync(arquivoTemporario, 'utf8');
    const linha = conteudo.split('\n').find((l) => l.startsWith(`${VALOR_SEGURO_PARA_COMPARAR}=`));
    if (!linha) return '(ausente)';
    return linha.slice(VALOR_SEGURO_PARA_COMPARAR.length + 1).replace(/^"|"$/g, '') || '(vazio)';
  } finally {
    // Sempre apaga, mesmo se algo acima lançar — o arquivo baixado tem TODOS
    // os segredos de produção em texto puro; não pode sobrar no disco.
    fs.rmSync(arquivoTemporario, { force: true });
  }
}

function main() {
  if (!HOST_VPS) {
    console.error('CRMCLINICA_VPS_SSH_HOST não configurado — não sei em qual servidor comparar. Exemplo:');
    console.error('  CRMCLINICA_VPS_SSH_HOST=root@meu-servidor.exemplo node ferramentas/checar-drift-configuracao.js');
    process.exit(1);
  }

  console.log(`Comparando Vercel (production) com o VPS (${CAMINHO_ENV_VPS})…\n`);

  const nomesVps = nomesDoEnvNaVps();
  const nomesVercel = nomesNaVercel();

  const soNaVercel = [...nomesVercel].filter((nome) => !nomesVps.has(nome)).sort();
  const soNoVps = [...nomesVps].filter((nome) => !nomesVercel.has(nome)).sort();

  console.log(`Variáveis só na Vercel (${soNaVercel.length}):`);
  console.log(soNaVercel.length ? soNaVercel.map((n) => `  - ${n}`).join('\n') : '  (nenhuma)');
  console.log(`\nVariáveis só no VPS (${soNoVps.length}):`);
  console.log(soNoVps.length ? soNoVps.map((n) => `  - ${n}`).join('\n') : '  (nenhuma)');

  console.log(`\n${VALOR_SEGURO_PARA_COMPARAR} (única variável cujo valor é comparado — não é segredo):`);
  const valorVps = valorSeguroNaVps();
  const valorVercel = valorSeguroNaVercel();
  console.log(`  VPS:    ${valorVps}`);
  console.log(`  Vercel: ${valorVercel}`);
  if (valorVps !== valorVercel) {
    console.log('  ⚠ DIVERGENTE — foi exatamente este desalinhamento que causou o incidente de 2026-08-17.');
  } else {
    console.log('  ✓ igual nos dois ambientes.');
  }
}

main();
