#!/usr/bin/env node
'use strict';

// Confere o que está realmente aplicado no banco: tabelas, colunas, RLS,
// políticas e privilégios de `anon`/`authenticated`.
//
//   npm run verificar-banco
//
// Existe porque "a migration foi aplicada" é uma afirmação que precisa de prova.
// Um RLS que se acredita ligado e não está é pior que um RLS que se sabe ausente.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');

// O que cada migration deve ter deixado no banco.
const ESPERADO = {
  '001_inbox': {
    tabelas: [
      'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas',
      'conversa_etiquetas', 'leads', 'notas_internas', 'audit_log', 'eventos_recebidos',
    ],
    colunas: [
      ['conversas', 'assumida_por_humano'],
      ['conversas', 'ia_pausada_ate'],
      ['leads', 'conversa_id'],
      ['mensagens', 'id_externo'],
    ],
  },
  '002_autenticacao_e_rls': {
    tabelas: ['sessoes'],
    colunas: [
      ['usuarios', 'ultimo_login_em'],
      ['sessoes', 'hash_refresh'],
      ['sessoes', 'revogada_em'],
    ],
    funcoes: ['limpar_sessoes_vencidas'],
    papeis: ['crmclinica_app'],
  },
  '003_contas': {
    tabelas: ['recuperacoes_senha'],
    colunas: [
      ['usuarios', 'situacao'], ['usuarios', 'master'], ['usuarios', 'precisa_trocar_senha'],
      ['usuarios', 'google_sub'], ['usuarios', 'totp_segredo_cifrado'], ['usuarios', 'totp_ativo'],
      ['recuperacoes_senha', 'hash_token'],
    ],
    funcoes: ['limpar_recuperacoes_vencidas'],
  },
  '004_rate_limit': {
    tabelas: ['tentativas_autenticacao'],
    colunas: [['tentativas_autenticacao', 'hash_conta'], ['tentativas_autenticacao', 'ip']],
    funcoes: ['limpar_tentativas_vencidas'],
  },
  '005_qualificacao_jornada': {
    tabelas: ['lead_eventos'],
    colunas: [
      ['leads', 'interesse'], ['leads', 'pagamento'], ['leads', 'urgencia'],
      ['leads', 'disponibilidade'], ['leads', 'score'], ['leads', 'temperatura_manual'],
      ['leads', 'utm_source'], ['lead_eventos', 'tipo'],
    ],
  },
};

// Toda tabela do produto precisa de RLS. A lista é explícita para que uma tabela
// nova sem RLS apareça como falta, não passe despercebida.
const TABELAS_COM_RLS = [
  'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas', 'conversa_etiquetas',
  'leads', 'notas_internas', 'audit_log', 'eventos_recebidos', 'sessoes',
  'recuperacoes_senha', 'tentativas_autenticacao', 'lead_eventos',
];

const verde = (texto) => `\x1b[32m${texto}\x1b[0m`;
const vermelho = (texto) => `\x1b[31m${texto}\x1b[0m`;
const amarelo = (texto) => `\x1b[33m${texto}\x1b[0m`;

async function main() {
  const configuracao = carregarConfiguracao();

  if (!configuracao.banco.configurado) {
    console.error(vermelho('CRMCLINICA_DATABASE_URL não está definida.'));
    console.error('Sem a connection string não há como verificar o banco.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const pool = criarPool(configuracao.banco);

  let falhas = 0;
  const marcar = (ok, texto, detalhe = '') => {
    if (!ok) falhas += 1;
    console.log(`  ${ok ? verde('ok  ') : vermelho('FALTA')} ${texto}${detalhe ? ` — ${detalhe}` : ''}`);
  };

  try {
    // Sem esta consulta não há conexão, e o resto não faz sentido.
    const { rows: [{ versao }] } = await pool.query('SELECT version() AS versao');
    console.log(`\nConectado: ${versao.split(',')[0]}\n`);

    const { rows: tabelas } = await pool.query(
      "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'",
    );
    const porNome = new Map(tabelas.map((linha) => [linha.tablename, linha]));

    const { rows: colunas } = await pool.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const colunasPorTabela = new Map();
    for (const { table_name: tabela, column_name: coluna } of colunas) {
      if (!colunasPorTabela.has(tabela)) colunasPorTabela.set(tabela, new Set());
      colunasPorTabela.get(tabela).add(coluna);
    }

    const { rows: funcoes } = await pool.query(
      "SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'",
    );
    const nomesDeFuncoes = new Set(funcoes.map((linha) => linha.proname));

    const { rows: papeis } = await pool.query('SELECT rolname FROM pg_roles');
    const nomesDePapeis = new Set(papeis.map((linha) => linha.rolname));

    // ---------------------------------------------------------------- migrations

    for (const [migration, requisitos] of Object.entries(ESPERADO)) {
      console.log(`${migration}`);

      for (const tabela of requisitos.tabelas ?? []) {
        marcar(porNome.has(tabela), `tabela ${tabela}`);
      }
      for (const [tabela, coluna] of requisitos.colunas ?? []) {
        marcar(colunasPorTabela.get(tabela)?.has(coluna) ?? false, `${tabela}.${coluna}`);
      }
      for (const funcao of requisitos.funcoes ?? []) {
        marcar(nomesDeFuncoes.has(funcao), `função ${funcao}()`);
      }
      for (const papel of requisitos.papeis ?? []) {
        marcar(nomesDePapeis.has(papel), `papel ${papel}`);
      }
      console.log('');
    }

    // ---------------------------------------------------------------- RLS

    console.log('Row Level Security');
    const { rows: politicas } = await pool.query(
      "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'",
    );
    const politicasPorTabela = new Map();
    for (const { tablename, policyname } of politicas) {
      if (!politicasPorTabela.has(tablename)) politicasPorTabela.set(tablename, []);
      politicasPorTabela.get(tablename).push(policyname);
    }

    for (const tabela of TABELAS_COM_RLS) {
      if (!porNome.has(tabela)) {
        console.log(`  ${amarelo('—')}    ${tabela} (tabela ausente)`);
        continue;
      }
      const ligado = porNome.get(tabela).rowsecurity;
      const quantas = politicasPorTabela.get(tabela)?.length ?? 0;
      marcar(ligado, `RLS em ${tabela}`, ligado ? `${quantas} política(s)` : 'DESLIGADO');
    }

    // ---------------------------------------------------------------- exposição

    console.log('\nExposição pela API automática do Supabase');
    const { rows: privilegios } = await pool.query(`
      SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ', ') AS privilegios
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
      GROUP BY grantee, table_name
      ORDER BY grantee, table_name
    `);

    if (privilegios.length === 0) {
      console.log(`  ${verde('ok  ')} anon e authenticated não têm privilégio em nenhuma tabela`);
    } else {
      for (const linha of privilegios) {
        // Privilégio sem RLS é leitura livre pela API REST; com RLS, é bloqueado
        // pela política — mas continua sendo superfície que não precisa existir.
        const comRls = porNome.get(linha.table_name)?.rowsecurity;
        falhas += comRls ? 0 : 1;
        console.log(
          `  ${comRls ? amarelo('aviso') : vermelho('RISCO')} ${linha.grantee} → ${linha.table_name}`
          + ` (${linha.privilegios})${comRls ? ' — contido por RLS' : ' — SEM RLS'}`,
        );
      }
    }

    console.log('');
    if (falhas === 0) {
      console.log(verde('Tudo aplicado. O banco está como as migrations descrevem.'));
    } else {
      console.log(vermelho(`${falhas} item(ns) faltando ou em risco.`));
      console.log('Aplique as migrations pendentes de db/ em ordem antes de expor o sistema.');
    }
    process.exitCode = falhas === 0 ? 0 : 1;
  } finally {
    await encerrarPool();
  }
}

main().catch((erro) => {
  console.error(vermelho(`\nFalha ao verificar o banco: ${erro.message}`));
  process.exit(1);
});
