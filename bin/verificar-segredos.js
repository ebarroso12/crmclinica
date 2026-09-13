#!/usr/bin/env node
'use strict';

// Procura credencial commitada.
//
//   npm run seguranca:segredos          (só o que está versionado)
//   npm run seguranca:segredos -- --tudo (inclui não versionado, menos ignorados)
//
// Por que existe, sendo que o `.gitignore` já cobre `.env`: o `.gitignore`
// protege o arquivo que alguém LEMBROU de chamar de `.env`. Não protege a
// chave colada dentro de um `.js` "só para testar", o dump de exemplo com a
// senha real, nem o `.env.producao.bak` criado às pressas num incidente. Esses
// três são como credencial vaza de repositório na prática — nenhum deles é
// exótico, e todos passam pelo `.gitignore` sem encostar nele.
//
// Um detalhe que muda tudo: remover o arquivo num commit seguinte NÃO resolve.
// O objeto continua no histórico e num fork. Por isso a verificação roda ANTES
// do commit, não depois — é a única hora em que o custo do erro ainda é zero.
//
// Falso positivo aqui é barato (uma linha de allowlist); falso negativo é uma
// chave de API válida num repositório para sempre. Na dúvida, acusa.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

/**
 * Padrões de credencial com FORMA conhecida.
 *
 * Preferidos à entropia pura porque não têm falso positivo: `sk-` seguido de
 * 40 caracteres é uma chave da OpenAI, não é outra coisa.
 */
const PADROES = [
  { nome: 'chave OpenAI', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { nome: 'chave Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { nome: 'token do GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { nome: 'chave da AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { nome: 'chave de serviço do Google', re: /"type"\s*:\s*"service_account"/ },
  { nome: 'chave privada PEM', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { nome: 'JWT com corpo', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { nome: 'URL de banco com senha', re: /\b(postgres|postgresql|mysql|mongodb(\+srv)?):\/\/[^\s:@/]+:[^\s:@/]+@/ },
  { nome: 'chave de serviço do Supabase', re: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/ },
  // Atribuição de segredo com valor longo e literal no código.
  {
    nome: 'segredo embutido no código',
    re: /\b(?:api[_-]?key|secret|senha|password|passwd|token|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9/+_-]{24,}['"]/i,
  },
];

/**
 * O que NÃO é achado, com o motivo de cada um.
 *
 * Lista curta e justificada de propósito: allowlist que cresce sem explicação
 * vira o lugar onde o segredo de verdade se esconde.
 */
const PERMITIDOS = [
  // O modelo versionado tem as chaves com valor em branco — é o ponto dele.
  { arquivo: /(^|\/)\.env\.exemplo$/, motivo: 'modelo sem valores' },
  // Este próprio arquivo descreve os padrões que procura.
  { arquivo: /(^|\/)bin\/verificar-segredos\.js$/, motivo: 'é o detector' },
  { arquivo: /(^|\/)testes\/seguranca-segredos\.test\.js$/, motivo: 'testa o detector com valores sintéticos' },
  // Documentação que ensina o formato da variável.
  { arquivo: /(^|\/)docs\//, motivo: 'documentação', apenas: ['segredo embutido no código'] },
];

const EXTENSOES_BINARIAS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mp3|ogg)$/i;

function arquivosVersionados() {
  const saida = execFileSync('git', ['ls-files', '-z'], { cwd: RAIZ, encoding: 'utf8' });
  return saida.split('\0').filter(Boolean);
}

function arquivosNaArvore() {
  const saida = execFileSync(
    'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: RAIZ, encoding: 'utf8' },
  );
  return saida.split('\0').filter(Boolean);
}

/**
 * Valor que se declara sintético.
 *
 * A suíte precisa de tokens e senhas para testar autenticação, e todos os
 * deste repositório se nomeiam: `token-do-teste`, `token-sintetico-...`,
 * `nunca-deveria-sair`. Reconhecer isso é melhor que liberar `testes/` inteiro
 * — liberar a pasta faria uma chave REAL colada num teste passar em silêncio,
 * e chave colada "só para rodar uma vez" é um dos caminhos mais comuns de
 * vazamento.
 *
 * Vale só para o padrão genérico. Uma `sk-...` ou uma chave PEM continuam
 * sendo achado em qualquer arquivo, com qualquer nome: formato de credencial
 * real não vira sintético por causa da palavra "teste" ao lado.
 */
const MARCAS_DE_VALOR_SINTETICO = /(teste|sintetic|sintétic|exemplo|example|fake|dummy|placeholder|nunca|invalid|sample)/i;

function permitido(arquivo, nomeDoPadrao, linha) {
  if (nomeDoPadrao === 'segredo embutido no código' && MARCAS_DE_VALOR_SINTETICO.test(linha)) {
    return true;
  }
  return PERMITIDOS.some((regra) => {
    if (!regra.arquivo.test(arquivo)) return false;
    return !regra.apenas || regra.apenas.includes(nomeDoPadrao);
  });
}

/** @returns {{arquivo: string, linha: number, padrao: string, trecho: string}[]} */
function varrer(arquivos) {
  const achados = [];

  for (const arquivo of arquivos) {
    if (EXTENSOES_BINARIAS.test(arquivo)) continue;

    const caminho = path.join(RAIZ, arquivo);
    let conteudo;
    try {
      const info = fs.statSync(caminho);
      // Arquivo enorme quase nunca é fonte, e ler tudo custa caro.
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
      conteudo = fs.readFileSync(caminho, 'utf8');
    } catch {
      continue; // sumiu entre o listar e o ler, ou não é texto
    }

    const linhas = conteudo.split(/\r?\n/);
    for (const [indice, linha] of linhas.entries()) {
      for (const padrao of PADROES) {
        if (!padrao.re.test(linha)) continue;
        if (permitido(arquivo, padrao.nome, linha)) continue;
        achados.push({
          arquivo,
          linha: indice + 1,
          padrao: padrao.nome,
          // NUNCA o valor: um relatório que imprime o segredo o copia para o
          // log do CI, que costuma ser mais fácil de ler que o repositório.
          trecho: `${linha.trim().slice(0, 24)}…`,
        });
      }
    }
  }

  return achados;
}

function principal() {
  const tudo = process.argv.includes('--tudo');
  const arquivos = tudo ? arquivosNaArvore() : arquivosVersionados();
  const achados = varrer(arquivos);

  if (achados.length === 0) {
    console.log(`[segredos] ${arquivos.length} arquivo(s) conferido(s), nada encontrado.`);
    return 0;
  }

  console.error(`[segredos] ${achados.length} achado(s):`);
  for (const achado of achados) {
    console.error(`  ${achado.arquivo}:${achado.linha}  ${achado.padrao}  ${achado.trecho}`);
  }
  console.error('');
  console.error('[segredos] Se for credencial de verdade: ROTACIONE a chave antes de qualquer outra coisa.');
  console.error('[segredos] Tirar do arquivo não basta — o objeto continua no histórico e em qualquer clone.');
  return 1;
}

if (require.main === module) process.exit(principal());

module.exports = { varrer, PADROES, PERMITIDOS };
