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
  '006_agenda': {
    tabelas: ['profissionais', 'disponibilidades', 'agenda_bloqueios', 'agendamentos'],
    colunas: [
      ['agendamentos', 'conversa_id'], ['agendamentos', 'confirmado_em'],
      ['disponibilidades', 'dia_semana'],
    ],
  },
  '007_hardening': {
    funcoes: ['app_usuario_atual'],
  },
  '011_serena': {
    tabelas: ['serena_configuracao', 'serena_prompts', 'serena_regras'],
    colunas: [
      ['serena_configuracao', 'ativa'], ['serena_prompts', 'publicado'],
      ['serena_regras', 'categoria'], ['contatos', 'excluido_em'],
    ],
  },
  '010_lembretes': {
    tabelas: ['lembretes'],
    colunas: [
      ['lembretes', 'janela'], ['lembretes', 'agendar_para'], ['lembretes', 'estado'],
      ['lembretes', 'tentativas'], ['lembretes', 'tentar_em'], ['lembretes', 'modo_entrega'],
      ['contatos', 'lembretes_optout'],
    ],
  },
};

// Constraints sem as quais uma garantia inteira deixa de existir. Índice
// ausente é lentidão; constraint ausente é lembrete duplicado no WhatsApp do
// paciente — e nada no código avisaria.
const CONSTRAINTS = [
  ['lembretes', 'lembretes_unicos', 'idempotência por agendamento, tipo e janela'],
  ['agendamentos', 'agendamentos_sem_conflito', 'dois agendamentos não se sobrepõem'],
  ['serena_prompts', 'serena_prompt_versao_uk', 'versão de prompt não se repete'],
];

// Funções nossas que precisam de `search_path` fixo. Sem ele, um schema no
// caminho de quem chama decide qual tabela a função enxerga.
const FUNCOES_COM_SEARCH_PATH = [
  'set_atualizado_em', 'limpar_sessoes_vencidas', 'limpar_recuperacoes_vencidas',
  'limpar_tentativas_vencidas', 'app_usuario_atual',
];

// Tabelas cujo histórico não se reescreve. A aplicação não deve ter privilégio
// de apagá-las — nem depender de a policy segurar.
const SEM_DELETE = ['audit_log', 'lead_eventos', 'usuarios'];

// Toda tabela do produto precisa de RLS. A lista é explícita para que uma tabela
// nova sem RLS apareça como falta, não passe despercebida.
const TABELAS_COM_RLS = [
  'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas', 'conversa_etiquetas',
  'leads', 'notas_internas', 'audit_log', 'eventos_recebidos', 'sessoes',
  'recuperacoes_senha', 'tentativas_autenticacao', 'lead_eventos',
  'profissionais', 'disponibilidades', 'agenda_bloqueios', 'agendamentos', 'lembretes',
  'serena_configuracao', 'serena_prompts', 'serena_regras',
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

    // ---------------------------------------------------------------- constraints

    console.log('Constraints que sustentam garantias');
    const { rows: constraints } = await pool.query(`
      SELECT conname, conrelid::regclass::text AS tabela
        FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
    `);
    const constraintsPresentes = new Set(constraints.map((linha) => `${linha.tabela}.${linha.conname}`));

    for (const [tabela, constraint, porque] of CONSTRAINTS) {
      if (!porNome.has(tabela)) {
        console.log(`  ${amarelo('—')}    ${constraint} (tabela ${tabela} ausente)`);
        continue;
      }
      marcar(constraintsPresentes.has(`${tabela}.${constraint}`), `${tabela}: ${constraint}`, porque);
    }
    console.log('');

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

    // ---------------------------------------------------------------- storage
    //
    // A verificação que faltava. `anon` tinha TRUNCATE em storage.objects, e
    // TRUNCATE não passa pelo RLS: é privilégio de tabela, e não há linha para o
    // RLS filtrar quando o comando apaga tudo. RLS ligado não protege disso.

    console.log('\nStorage');
    const { rows: [temStorage] } = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'storage'",
    );

    if (!temStorage.n) {
      console.log(`  ${amarelo('—')}    projeto sem schema storage`);
    } else {
      const { rows: expostas } = await pool.query(`
        SELECT t.tabela, r.papel,
               has_table_privilege(r.papel, 'storage.' || t.tabela, 'TRUNCATE') AS truncate,
               has_table_privilege(r.papel, 'storage.' || t.tabela, 'DELETE')   AS delete,
               has_table_privilege(r.papel, 'storage.' || t.tabela, 'INSERT')   AS insert
          FROM unnest(ARRAY['objects','buckets']) AS t(tabela)
         CROSS JOIN unnest(ARRAY['anon','authenticated']) AS r(papel)
         WHERE to_regclass('storage.' || t.tabela) IS NOT NULL
      `);

      const perigosas = expostas.filter((linha) => linha.truncate || linha.delete || linha.insert);
      if (perigosas.length === 0) {
        console.log(`  ${verde('ok  ')} anon e authenticated não escrevem no storage`);
      } else {
        for (const linha of perigosas) {
          const quais = [
            linha.truncate ? 'TRUNCATE' : null,
            linha.delete ? 'DELETE' : null,
            linha.insert ? 'INSERT' : null,
          ].filter(Boolean).join(', ');

          falhas += 1;
          console.log(
            `  ${vermelho('RISCO')} ${linha.papel} → storage.${linha.tabela} (${quais})`
            + (linha.truncate ? ' — TRUNCATE ignora o RLS' : ''),
          );
        }
        console.log(`  ${amarelo('→')}    corrija pelo SQL Editor do painel: `
          + 'REVOKE ALL ON storage.objects, storage.buckets FROM anon, authenticated;');
        console.log(`  ${amarelo('→')}    não dá para fazer daqui: as tabelas pertencem a `
          + 'supabase_storage_admin, e postgres não é superuser.');
      }
    }

    // ---------------------------------------------------------------- funções

    console.log('\nsearch_path das funções');
    const { rows: configs } = await pool.query(`
      SELECT p.proname, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1)
    `, [FUNCOES_COM_SEARCH_PATH]);

    const configPorNome = new Map(configs.map((linha) => [linha.proname, linha.proconfig]));
    for (const nome of FUNCOES_COM_SEARCH_PATH) {
      if (!configPorNome.has(nome)) {
        console.log(`  ${amarelo('—')}    ${nome}() (função ausente)`);
        continue;
      }
      const fixo = (configPorNome.get(nome) ?? []).some((item) => item.startsWith('search_path='));
      marcar(fixo, `${nome}()`, fixo ? '' : 'search_path MUTÁVEL');
    }

    // ---------------------------------------------------------------- privilégios da app

    console.log('\nPrivilégios de crmclinica_app');
    const { rows: [papel] } = await pool.query(`
      SELECT COALESCE(bool_or(rolcanlogin), false) AS pode_logar
        FROM pg_roles WHERE rolname = 'crmclinica_app'
    `);
    marcar(papel.pode_logar, 'crmclinica_app pode conectar');

    for (const tabela of SEM_DELETE) {
      if (!porNome.has(tabela)) continue;
      const { rows: [priv] } = await pool.query(
        "SELECT has_table_privilege('crmclinica_app', $1, 'DELETE') AS pode",
        [`public.${tabela}`],
      );
      marcar(!priv.pode, `sem DELETE em ${tabela}`, priv.pode ? 'a aplicação pode apagar histórico' : '');
    }

    const { rows: sobraram } = await pool.query(
      "SELECT policyname FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'app_total%'",
    );
    marcar(sobraram.length === 0, 'policies app_total_* substituídas',
      sobraram.length ? `${sobraram.length} restante(s)` : '');

    // ---------------------------------------------------------------- quem conecta
    //
    // O achado que reordena todos os outros: enquanto a aplicação conectar como
    // dono das tabelas, o RLS não é avaliado para ela e nenhuma policy vale.

    console.log('\nConexão desta verificação');
    const { rows: [quem] } = await pool.query(`
      SELECT current_user AS usuario,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS ignora_rls,
             (SELECT count(*) FROM pg_tables
               WHERE schemaname='public' AND tableowner = current_user) AS tabelas_proprias
    `);

    if (quem.ignora_rls || Number(quem.tabelas_proprias) > 0) {
      falhas += 1;
      console.log(`  ${vermelho('RISCO')} conectado como "${quem.usuario}"`
        + `${quem.ignora_rls ? ', que tem BYPASSRLS' : ''}`
        + `${Number(quem.tabelas_proprias) > 0 ? ` e é dono de ${quem.tabelas_proprias} tabela(s)` : ''}`);
      console.log(`  ${amarelo('→')}    o RLS não é avaliado para esta conexão: as policies são decoração.`);
      console.log(`  ${amarelo('→')}    aponte CRMCLINICA_DATABASE_URL para crmclinica_app.`);
    } else {
      console.log(`  ${verde('ok  ')} conectado como "${quem.usuario}" — o RLS vale para esta conexão`);
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
