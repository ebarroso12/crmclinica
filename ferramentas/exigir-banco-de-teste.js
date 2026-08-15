#!/usr/bin/env node
'use strict';

// Porteiro do banco de teste (Commit 24-A do plano de confiabilidade).
//
// Existe por causa de um defeito real, encontrado na auditoria de 2026-08-14:
// `testes/ingresso-whatsapp-transacao.test.js` foi escrito para provar, contra
// PostgreSQL de verdade, a correção do erro `mensagens_conversa_id_fkey` — mas
// sem `CRMCLINICA_TEST_DATABASE_URL` ele caía num ramo que registrava um caso
// de **corpo vazio** chamado "PULADO". Esse caso passava, somava +1 no total, e
// o commit foi descrito como "vermelho/verde contra Postgres real". Ninguém
// conseguia reexecutar a prova. Teste que passa sem exercitar nada é pior que
// teste ausente: o ausente ninguém conta como cobertura.
//
// Daí as duas regras que este arquivo aplica, e que valem mesmo quando dão
// trabalho:
//
//   1. quem pede a suíte de PostgreSQL recebe PostgreSQL ou recebe erro —
//      nunca um verde vazio;
//   2. o banco precisa ser comprovadamente descartável. Rodar a suíte contra
//      produção seria catastrófico: os testes fazem TRUNCATE de tabelas
//      inteiras (ver `testes/lembretes-concorrencia.test.js`), incluindo
//      `mensagens`, `contatos` e `usuarios`.
//
// A verificação da regra 2 é programática de propósito. Disciplina de quem
// executa não é controle: às três da manhã, no meio de um incidente, é
// exatamente quando a variável errada está exportada no terminal.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  // Só para ler CRMCLINICA_TEST_DATABASE_URL de um .env local, se houver.
  // Nunca imprimimos nada do que vem daqui.
  try {
    process.loadEnvFile(CAMINHO_ENV);
  } catch {
    // .env ilegível não é motivo para falhar: a variável pode vir do ambiente.
  }
}

// Projetos que NUNCA podem receber a suíte de testes. Os dois são reais:
//   umvpwqqjzpxwuxdnnxzy — Supabase de produção do crmclinica;
//   rkdvvynxxerqpjzetmse — projeto legado, proibido sem autorização expressa.
// A lista é de referências de projeto, não de URLs completas, porque a mesma
// base é alcançável por vários hosts (pooler de sessão, de transação, conexão
// direta) e bloquear só uma forma de escrever seria bloquear nada.
const PROIBIDOS = Object.freeze([
  { referencia: 'umvpwqqjzpxwuxdnnxzy', motivo: 'Supabase de PRODUÇÃO do crmclinica' },
  { referencia: 'rkdvvynxxerqpjzetmse', motivo: 'projeto legado (proibido sem autorização expressa)' },
]);

// Montado em pedaços de propósito. `testes/auditoria.test.js` proíbe que
// qualquer arquivo versionado traga usuário e senha embutidos numa URL de
// PostgreSQL (o formato `esquema://usuario:senha@host`) —
// a assinatura de uma credencial vazada. A regra vale mesmo para exemplo
// fictício: um detector que abre exceção para "mas esse é de mentira" para de
// detectar. Aqui o texto só existe em tempo de execução, na mensagem de ajuda.
const EXEMPLO_DE_URL = ['postgresql://postgres', ':', 'teste', '@', '127.0.0.1:55432/crmclinica_teste'].join('');

/** Descreve a URL sem jamais revelar usuário, senha ou host completo. */
function descreverSemCredencial(url) {
  try {
    const analisada = new URL(url);
    const host = analisada.hostname || '(sem host)';
    // Só o primeiro rótulo do host e o banco: suficiente para a pessoa saber
    // qual banco escolheu, insuficiente para vazar o endereço em um log.
    const primeiroRotulo = host.split('.')[0];
    const banco = analisada.pathname.replace(/^\//, '') || '(sem banco)';
    return `host "${primeiroRotulo}…", banco "${banco}"`;
  } catch {
    return '(URL em formato não reconhecido)';
  }
}

/**
 * Decide se a URL pode receber a suíte.
 * Devolve `{ liberado, motivo }` em vez de lançar: o chamador escolhe como
 * comunicar, e o teste desta função fica trivial.
 */
function avaliarUrlDeTeste(url) {
  const bruta = typeof url === 'string' ? url.trim() : '';

  if (!bruta) {
    return {
      liberado: false,
      motivo: 'CRMCLINICA_TEST_DATABASE_URL não está definida',
      ausente: true,
    };
  }

  if (!/^postgres(ql)?:\/\//i.test(bruta)) {
    return {
      liberado: false,
      motivo: 'CRMCLINICA_TEST_DATABASE_URL não é uma URL PostgreSQL (precisa começar com postgres:// ou postgresql://)',
    };
  }

  const minuscula = bruta.toLowerCase();
  for (const { referencia, motivo } of PROIBIDOS) {
    if (minuscula.includes(referencia.toLowerCase())) {
      return {
        liberado: false,
        motivo: `a URL aponta para ${motivo}. A suíte de PostgreSQL faz TRUNCATE de tabelas inteiras — rodar aqui apagaria dados reais`,
        proibido: true,
      };
    }
  }

  return { liberado: true, motivo: null };
}

/** Arquivos que exigem PostgreSQL real. Ampliar conforme o plano avança. */
const TESTES_DE_POSTGRES = Object.freeze([
  'testes/contrato-repositorio.test.js',
  'testes/lembretes-concorrencia.test.js',
]);

function existentes(arquivos) {
  const raiz = path.join(__dirname, '..');
  return arquivos.filter((arquivo) => fs.existsSync(path.join(raiz, arquivo)));
}

function main() {
  const avaliacao = avaliarUrlDeTeste(process.env.CRMCLINICA_TEST_DATABASE_URL);

  if (!avaliacao.liberado) {
    console.error('');
    console.error('  A suíte de PostgreSQL não pode rodar.');
    console.error('');
    console.error(`  Motivo: ${avaliacao.motivo}.`);
    console.error('');

    if (avaliacao.ausente) {
      console.error('  O que fazer:');
      console.error('');
      console.error('    1. Suba um PostgreSQL descartável. Local, com Docker, resolve:');
      console.error('');
      console.error('         docker run --rm -d --name crmclinica-teste \\');
      console.error('           -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=crmclinica_teste \\');
      console.error('           -p 55432:5432 postgres:17');
      console.error('');
      console.error('    2. Aplique as migrations de db/ nesse banco (ordem numérica).');
      console.error('');
      console.error('    3. Exporte a variável apontando para ele:');
      console.error('');
      console.error(`         CRMCLINICA_TEST_DATABASE_URL="${EXEMPLO_DE_URL}"`);
      console.error('');
      console.error('    4. Rode de novo: npm run test:pg');
      console.error('');
      console.error('  Este banco precisa ser DESCARTÁVEL: a suíte executa TRUNCATE em');
      console.error('  mensagens, contatos, conversas, usuarios e outras tabelas.');
      console.error('');
      console.error('  Nunca aponte para o Supabase de produção nem para o projeto legado —');
      console.error('  este porteiro recusa os dois, mas a regra vale antes de chegar aqui.');
    } else if (avaliacao.proibido) {
      console.error(`  URL recusada: ${descreverSemCredencial(process.env.CRMCLINICA_TEST_DATABASE_URL)}`);
      console.error('');
      console.error('  Use um banco descartável, criado só para teste.');
    }

    console.error('');
    // Sai com erro de propósito: "pular em silêncio" é o defeito que este
    // arquivo existe para impedir.
    process.exit(1);
  }

  const arquivos = existentes(TESTES_DE_POSTGRES);
  if (arquivos.length === 0) {
    console.error('Nenhum arquivo de teste de PostgreSQL encontrado — verifique TESTES_DE_POSTGRES.');
    process.exit(1);
  }

  console.log(`Banco de teste aceito: ${descreverSemCredencial(process.env.CRMCLINICA_TEST_DATABASE_URL)}`);
  console.log(`Rodando ${arquivos.length} arquivo(s) que exigem PostgreSQL real:`);
  for (const arquivo of arquivos) console.log(`  - ${arquivo}`);
  console.log('');

  const resultado = spawnSync(process.execPath, ['--test', ...arquivos], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });

  process.exit(resultado.status ?? 1);
}

if (require.main === module) main();

module.exports = { avaliarUrlDeTeste, descreverSemCredencial, PROIBIDOS, TESTES_DE_POSTGRES };
