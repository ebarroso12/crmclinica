#!/usr/bin/env node
'use strict';

// Troca a conexão da aplicação de `postgres` para `crmclinica_app`.
//
//   npm run preparar-conexao
//
// O que faz, nesta ordem:
//   1. lê a URL atual do `.env` para aproveitar host, porta e base;
//   2. gera uma senha aleatória de 32 bytes;
//   3. aplica a senha na role, conectado como a URL atual;
//   4. testa a conexão nova antes de mexer em qualquer arquivo;
//   5. reescreve `CRMCLINICA_DATABASE_URL` no `.env`, preservando o resto.
//
// A senha **nunca** é impressa, gravada em log ou devolvida. Ela existe em
// memória durante a execução e depois só no `.env`, que o `.gitignore` protege.
// Se precisar trocá-la, rode de novo: o comando é idempotente.
//
// Por que isso importa: a role `postgres` é dona das tabelas e tem BYPASSRLS.
// Conectando por ela, o Row Level Security nunca é avaliado e todas as políticas
// do banco viram decoração. Não há erro, log ou sintoma — só a proteção ausente.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
const PAPEL = 'crmclinica_app';

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const vermelho = (t) => `\x1b[31m${t}\x1b[0m`;
const amarelo = (t) => `\x1b[33m${t}\x1b[0m`;

function abortar(mensagem, dica = null) {
  console.error(vermelho(`\n${mensagem}`));
  if (dica) console.error(dica);
  process.exit(1);
}

/** Descrição sem a senha — é o que pode aparecer na tela. */
function descrever(url) {
  return `${url.username}@${url.hostname}:${url.port || 5432}${url.pathname}`;
}

async function main() {
  if (!fs.existsSync(CAMINHO_ENV)) {
    abortar('Não encontrei o arquivo .env.', 'Copie o .env.exemplo e preencha CRMCLINICA_DATABASE_URL.');
  }

  const textoEnv = fs.readFileSync(CAMINHO_ENV, 'utf8');
  const linhaAtual = textoEnv.split(/\r?\n/).find((linha) => linha.startsWith('CRMCLINICA_DATABASE_URL='));
  const urlAtualTexto = linhaAtual ? linhaAtual.slice('CRMCLINICA_DATABASE_URL='.length).trim() : '';

  if (!urlAtualTexto) {
    abortar('CRMCLINICA_DATABASE_URL está vazia no .env.', 'Preencha com a connection string do projeto.');
  }

  let urlAtual;
  try {
    urlAtual = new URL(urlAtualTexto);
  } catch {
    abortar('CRMCLINICA_DATABASE_URL não é uma URL válida.');
  }

  console.log(`\nConexão atual: ${descrever(urlAtual)}`);

  if (urlAtual.username === PAPEL) {
    console.log(amarelo(`Já está conectando como ${PAPEL}.`));
    console.log('Rodando assim mesmo: a senha será trocada por uma nova.');
  }

  const { Pool } = require('pg');
  const ssl = /supabase|amazonaws|render|neon/i.test(urlAtualTexto)
    ? { rejectUnauthorized: false }
    : undefined;

  // A senha vive só nesta variável e no .env. Nunca em log, nunca em retorno.
  const senha = crypto.randomBytes(32).toString('base64url');

  const poolAdmin = new Pool({ connectionString: urlAtualTexto, max: 1, ssl });
  try {
    const { rows: [papel] } = await poolAdmin.query(
      'SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb '
      + 'FROM pg_roles WHERE rolname = $1',
      [PAPEL],
    );

    if (!papel) {
      abortar(`A role ${PAPEL} não existe.`, 'Aplique db/002_autenticacao_e_rls.sql e db/007_hardening.sql.');
    }

    // Uma role da aplicação com qualquer um destes atributos anula o motivo de
    // existir: ela voltaria a passar por cima do RLS.
    const perigosos = [
      papel.rolsuper ? 'SUPERUSER' : null,
      papel.rolbypassrls ? 'BYPASSRLS' : null,
      papel.rolcreaterole ? 'CREATEROLE' : null,
      papel.rolcreatedb ? 'CREATEDB' : null,
    ].filter(Boolean);

    if (perigosos.length) {
      abortar(
        `${PAPEL} tem atributo que anula o RLS: ${perigosos.join(', ')}.`,
        `Remova antes de usar: ALTER ROLE ${PAPEL} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;`,
      );
    }

    // `ALTER ROLE` não aceita `$1`, e um bloco `DO` também não. O caminho seguro
    // é pedir ao próprio PostgreSQL que monte o comando: a senha viaja como
    // parâmetro nesta primeira consulta, e `format(%L)` faz o escape com as
    // regras do servidor — não com uma tentativa de escapar aspas em JavaScript.
    const { rows: [{ comando }] } = await poolAdmin.query(
      "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1, $2) AS comando",
      [PAPEL, senha],
    );
    await poolAdmin.query(comando);
    console.log(verde(`Senha definida para ${PAPEL}.`));
  } finally {
    await poolAdmin.end();
  }

  // Monta a URL nova reaproveitando host, porta e base da atual.
  const urlNova = new URL(urlAtualTexto);
  urlNova.username = PAPEL;
  urlNova.password = senha;

  // Testa ANTES de escrever: um .env com credencial que não conecta é pior que
  // o .env de antes, porque a aplicação para de subir e a causa não é óbvia.
  const poolTeste = new Pool({ connectionString: urlNova.toString(), max: 1, ssl });
  try {
    const { conferirConexao, descreverConexao } = require('../src/dados/conferir-conexao');
    const diagnostico = await conferirConexao(poolTeste);

    console.log(`Teste de conexão: ${descreverConexao(diagnostico)}`);
    if (!diagnostico.seguro) {
      abortar('A conexão nova ainda é privilegiada.', 'Revise os atributos da role antes de continuar.');
    }
  } catch (erro) {
    if (erro.codigo === undefined && !/privilegiada/.test(erro.message)) {
      abortar(`Não consegui conectar como ${PAPEL}: ${erro.message}`,
        'A senha foi trocada no banco, mas o .env não foi alterado. Rode de novo.');
    }
    throw erro;
  } finally {
    await poolTeste.end();
  }

  const textoNovo = textoEnv.replace(
    /^CRMCLINICA_DATABASE_URL=.*$/m,
    `CRMCLINICA_DATABASE_URL=${urlNova.toString()}`,
  );

  if (textoNovo === textoEnv) {
    abortar('Não consegui atualizar a linha no .env.', 'Verifique se existe uma linha CRMCLINICA_DATABASE_URL=.');
  }

  fs.writeFileSync(CAMINHO_ENV, textoNovo);
  console.log(verde(`\n.env atualizado: agora conecta como ${PAPEL}.`));
  console.log('A senha não foi exibida nem registrada em log — ela está apenas no .env.');
  console.log('\nConfira com: npm run verificar-banco');
}

main().catch((erro) => {
  console.error(vermelho(`\nFalhou: ${erro.message}`));
  process.exit(1);
});
