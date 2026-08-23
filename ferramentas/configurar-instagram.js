#!/usr/bin/env node
'use strict';

// Ajuda a configurar as credenciais do Instagram sem que nenhum valor passe
// pelo Claude — o mesmo desenho já usado para o token da Evolution em
// 22/08 (ver skill crmclinica): quem digita e quem propaga é sempre o
// operador humano, num terminal que a IA não vê.
//
//   node ferramentas/configurar-instagram.js
//
// O que este script faz:
//   1. Pergunta as 4 credenciais com digitação oculta (não aparece na tela,
//      não fica no histórico do terminal).
//   2. Grava num `.env.instagram.local` (já no .gitignore — nunca commitado)
//      pra você conferir e usar localmente se quiser.
//   3. Imprime os comandos EXATOS de `vercel env add` para colar você mesmo
//      no terminal — o próprio `vercel` pede o valor na hora, sem este
//      script nem qualquer outro processo intermediário guardar nada.
//   4. Lembra o que falta manualmente: o `.env` do VPS
//      (/opt/crmclinica-ponte/.env) é arquivo separado, propagado por SSH —
//      fora do alcance deste script (e do Claude Code, que não tem SSH
//      liberado neste ambiente). Use o terminal web da Hostinger, mesmo
//      caminho já usado no incidente de 22/08.
//
// Onde pegar cada valor:
//   - INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_APP_SECRET, INSTAGRAM_BUSINESS_ACCOUNT_ID:
//     painel do app no developers.facebook.com (Meta for Developers) —
//     produto "Instagram" > Configurações da API > Gerar token de acesso.
//   - INSTAGRAM_WEBHOOK_VERIFY_TOKEN: você mesmo inventa uma string
//     aleatória longa agora (ex.: `openssl rand -hex 32`) e usa o MESMO
//     valor nos dois lugares: aqui e no campo "Verify Token" da tela de
//     configuração do webhook no painel da Meta.
//
// Se os valores hoje só existem dentro da automação externa anterior: abra
// o painel dela, vá na área de credenciais, ache a do Instagram, e copie de
// lá — ela também pode não mostrar o valor cru se já foi salvo antes (mesmo
// comportamento "write-only" da Vercel); pode ser preciso gerar um token
// NOVO no painel da Meta em vez de recuperar o antigo.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO_LOCAL = path.join(RAIZ, '.env.instagram.local');

const CAMPOS = [
  { chave: 'INSTAGRAM_ACCESS_TOKEN', obrigatorio: true },
  { chave: 'INSTAGRAM_APP_SECRET', obrigatorio: true },
  { chave: 'INSTAGRAM_BUSINESS_ACCOUNT_ID', obrigatorio: true },
  { chave: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN', obrigatorio: true },
];

/** Pergunta com o que for digitado escondido (não ecoa na tela). */
function perguntarOculto(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const escritaOriginal = rl._writeToOutput;
    let mostrarPergunta = true;
    rl._writeToOutput = function (linha) {
      if (mostrarPergunta) { escritaOriginal.call(rl, linha); return; }
      // Enquanto a pessoa digita a resposta, não ecoa nada — nem asterisco,
      // pra não dar nem a dica do tamanho do valor.
    };
    rl.question(pergunta, (resposta) => {
      mostrarPergunta = true;
      rl.close();
      process.stdout.write('\n');
      resolve(resposta.trim());
    });
    mostrarPergunta = false;
  });
}

async function main() {
  console.log('');
  console.log('  Configuração de credenciais do Instagram — nada disto passa pelo Claude.');
  console.log('  Cada valor fica só neste terminal e no arquivo local abaixo (fora do git).');
  console.log('');

  const valores = {};
  for (const { chave } of CAMPOS) {
    // eslint-disable-next-line no-await-in-loop
    valores[chave] = await perguntarOculto(`  ${chave}: `);
  }

  const faltando = CAMPOS.filter(({ chave, obrigatorio }) => obrigatorio && !valores[chave]);
  if (faltando.length > 0) {
    console.error('');
    console.error(`  Faltou preencher: ${faltando.map((f) => f.chave).join(', ')}`);
    console.error('  Nada foi gravado. Rode de novo quando tiver todos os valores.');
    process.exit(1);
  }

  const conteudo = CAMPOS.map(({ chave }) => `${chave}=${valores[chave]}`).join('\n') + '\n';
  fs.writeFileSync(ARQUIVO_LOCAL, conteudo, { mode: 0o600 });

  console.log('');
  console.log(`  Gravado em ${path.relative(RAIZ, ARQUIVO_LOCAL)} (já protegido no .gitignore).`);
  console.log('');
  console.log('  Próximo passo — Vercel (produção). Cole estes comandos um por um; o próprio');
  console.log('  `vercel` vai pedir o valor na hora, direto no seu terminal:');
  console.log('');
  for (const { chave } of CAMPOS) {
    console.log(`    vercel env add ${chave} production`);
  }
  console.log('');
  console.log('  Depois disso, redeploy pra pegar as variáveis novas:');
  console.log('');
  console.log('    vercel --prod');
  console.log('');
  console.log('  Último passo — worker do VPS (/opt/crmclinica-ponte/.env), fora do alcance');
  console.log('  deste script: abra o terminal web da Hostinger (asc.hostingervps.com) e');
  console.log('  adicione as mesmas 4 linhas nesse arquivo (os valores estão em');
  console.log(`  ${path.relative(RAIZ, ARQUIVO_LOCAL)}, se precisar copiar), depois:`);
  console.log('');
  console.log('    systemctl restart crmclinica-outbox.service');
  console.log('');
  console.log('  (o worker de Instagram, quando existir, vai precisar do mesmo restart —');
  console.log('  hoje só o de mensagens/outbox roda lá; confirme se o Instagram roda na');
  console.log('  Vercel sozinho ou também precisa de um processo no VPS antes de assumir.)');
  console.log('');
}

if (require.main === module) {
  main().catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exit(1);
  });
}

module.exports = { CAMPOS };
