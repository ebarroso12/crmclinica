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
  '012_serena_voz': {
    tabelas: ['serena_voz_sessoes', 'serena_voz_turnos'],
    colunas: [
      ['serena_voz_sessoes', 'consentimento_em'], ['serena_voz_sessoes', 'expira_em'],
      ['serena_voz_turnos', 'chave_idempotencia'], ['serena_voz_turnos', 'transcricao'],
    ],
  },
  // 013 e não 012: o laboratório de voz chegou primeiro a esse número. Duas
  // migrations com o mesmo prefixo se aplicam fora de ordem conforme o `ls`.
  '013_serena_horario': {
    colunas: [
      ['serena_configuracao', 'agenda'],
      ['serena_configuracao', 'pausada_ate'],
      ['serena_configuracao', 'ligada_ate'],
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
  '025_crm_fluxo': {
    tabelas: ['tarefas', 'formularios_pre_consulta'],
    colunas: [
      ['leads', 'estagio_desde'], ['leads', 'proprietario_id'],
      ['leads', 'proximo_passo'], ['leads', 'proximo_passo_em'],
      ['conversas', 'aguardando_resposta_desde'],
      ['conversas', 'resumo_interno'], ['conversas', 'resumo_interno_em'],
      ['tarefas', 'chave'], ['formularios_pre_consulta', 'token'],
    ],
  },
  '026_analitica': {
    tabelas: ['eventos_analiticos'],
    colunas: [
      ['eventos_analiticos', 'nome'], ['eventos_analiticos', 'chave'],
      ['eventos_analiticos', 'ocorrido_em'],
    ],
  },
  '027_ia_gateway': {
    tabelas: ['ia_modelos', 'ia_chamadas'],
    colunas: [
      ['ia_modelos', 'provedor'], ['ia_modelos', 'ativo'], ['ia_modelos', 'padrao'],
      ['ia_chamadas', 'chave_idempotencia'], ['ia_chamadas', 'latencia_ms'],
      ['ia_chamadas', 'custo_estimado_usd'], ['ia_chamadas', 'fallback_de'],
    ],
  },
  '028_avaliacoes_notificacoes': {
    tabelas: ['ia_avaliacoes', 'notificacoes', 'serena_ativacao_contatos'],
    colunas: [
      ['ia_avaliacoes', 'empatia'], ['ia_avaliacoes', 'seguranca'],
      ['ia_avaliacoes', 'aderencia'], ['ia_avaliacoes', 'veredito'],
      ['notificacoes', 'chave'], ['notificacoes', 'lida_em'],
      ['serena_configuracao', 'modo_ativacao'],
      ['serena_configuracao', 'ativacao_percentual'],
    ],
  },
  '021_google_outbox': {
    tabelas: ['google_outbox'],
    colunas: [
      ['agendamentos', 'google_calendar_id'], ['agendamentos', 'google_etag'],
      ['agendamentos', 'sync_status'], ['agendamentos', 'sync_version'],
      ['agendamentos', 'last_synced_at'], ['agendamentos', 'last_sync_error'],
      ['agendamentos', 'origem_alteracao'],
      ['google_outbox', 'operacao'], ['google_outbox', 'versao'],
      ['google_outbox', 'chave_idempotencia'], ['google_outbox', 'estado'],
      ['google_outbox', 'proximo_retry_em'],
    ],
  },
  '022_google_sincronia_inbound': {
    tabelas: ['google_sincronia_estado', 'google_eventos_externos', 'google_sincronia_conflitos'],
    colunas: [
      ['google_sincronia_estado', 'calendario'], ['google_sincronia_estado', 'next_sync_token'],
      ['google_sincronia_estado', 'precisa_full_sync'],
      ['google_eventos_externos', 'google_evento_id'], ['google_eventos_externos', 'etag'],
      ['google_sincronia_conflitos', 'tipo'], ['google_sincronia_conflitos', 'resolucao'],
    ],
  },
  '023_usuarios_contatos': {
    tabelas: ['termos', 'termo_assinaturas'],
    colunas: [
      ['usuarios', 'nome_completo'], ['usuarios', 'nascimento'],
      ['usuarios', 'cpf_cifrado'], ['usuarios', 'cpf_busca_hash'], ['usuarios', 'rg_cifrado'],
      ['usuarios', 'whatsapp_particular_autorizado'], ['usuarios', 'excluido_em'],
      ['contatos', 'nome_completo'], ['contatos', 'nascimento'],
      ['contatos', 'cpf_cifrado'], ['contatos', 'cpf_busca_hash'], ['contatos', 'rg_cifrado'],
      ['contatos', 'responsavel_nome'], ['contatos', 'responsavel_cpf_cifrado'],
      ['contatos', 'consentimento_responsavel_em'],
      ['termos', 'versao'], ['termos', 'publicado_em'],
      ['termo_assinaturas', 'termo_id'], ['termo_assinaturas', 'assinatura_externa_id'],
    ],
  },
  '024_indices_extensoes_qualidade': {
    colunas: [],
  },
  // Sem `conversas.agente_id` o código dos agentes derruba o inbox inteiro: é a
  // prova de "migration antes do deploy". O índice de canal, a FK RESTRICT e o
  // SELECT da aplicação em `agentes` são conferidos à parte, mais abaixo.
  '046_agentes': {
    tabelas: ['agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais'],
    colunas: [
      ['conversas', 'agente_id'],
      ['agentes', 'slug'], ['agentes', 'status'], ['agentes', 'configuracoes'],
      ['agente_canais', 'instancia'], ['agente_canais', 'ativo'],
      ['agente_acoes_inatividade', 'apos_minutos'], ['agente_treinamentos', 'conteudo'],
      ['agente_comportamentos', 'comportamento'],
    ],
  },
  // Sem `usuarios.acesso_clinica` o código da separação clínica × agentes
  // responde 500 a toda requisição de quem não é admin: é a prova de "047
  // antes do deploy". Grants, FKs e o gatilho são conferidos mais abaixo.
  '047_equipe_de_agentes': {
    tabelas: ['agente_equipe', 'resumo_envios'],
    colunas: [
      ['usuarios', 'acesso_clinica'],
      // Sem ela, o login (CAMPOS_USUARIO) e o resumo por equipe falham.
      ['usuarios', 'recebe_resumo'],
      ['agente_equipe', 'agente_id'], ['agente_equipe', 'usuario_id'],
      // Registro de envios do resumo: sem ele, o worker não envia (auditoria M2).
      ['resumo_envios', 'chave'], ['resumo_envios', 'status'],
      // Sem ela, a reserva falha e nenhum resumo sai (conferência final, item 1).
      ['resumo_envios', 'tentativas'],
    ],
  },
  // Sem ela, escolher canal devolve 503 e a clínica não consegue atender só no
  // Instagram — o código sobe e o recurso fica inerte, sem nada avisando.
  '048_serena_canais_desligados': {
    tabelas: [],
    colunas: [
      ['serena_configuracao', 'canais_desligados'],
    ],
  },
  // Sem ela, a regra de gatilho de um perfil do Instagram dispara no outro:
  // a palavra da loja responderia nos posts da clinica.
  '049_instagram_por_agente': {
    tabelas: [],
    colunas: [
      ['instagram_regras_gatilho', 'agente_id'],
      ['instagram_comentarios_processados', 'agente_id'],
      ['instagram_comentarios_processados', 'conta_comercial_id'],
    ],
  },
  // As três abaixo tinham ficado de fora da sonda (achado em revisão
  // independente, 13/09/2026). Todas falham do mesmo jeito: o código sobe, a
  // rota responde, e o recurso simplesmente não acontece — sem nada aceso.
  //
  // Sem ela, nenhum aparelho fica inscrito e o celular nunca toca.
  '050_avisos_no_celular': {
    tabelas: ['notificacoes_inscricoes'],
    colunas: [
      ['notificacoes_inscricoes', 'endpoint'],
      ['notificacoes_inscricoes', 'usuario_id'],
    ],
  },
  // Sem ela, "Esqueci minha senha" responde "enviado" e o e-mail não sai:
  // a rota enfileira, e a fila é esta tabela.
  '051_email_outbox': {
    tabelas: ['email_outbox'],
    colunas: [
      ['email_outbox', 'estado'],
      ['email_outbox', 'disponivel_em'],
    ],
  },
  // Sem ela, a assistente promete ao lead "vou confirmar com um profissional"
  // e a dúvida não é registrada em lugar nenhum.
  '052_orientacoes': {
    tabelas: ['orientacoes'],
    colunas: [
      ['orientacoes', 'duvida'],
      ['orientacoes', 'estado'],
      ['orientacoes', 'avisado_em'],
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
  ['tarefas', 'tarefas_chave_unica', 'o sino não duplica: uma inatividade, uma tarefa'],
  ['formularios_pre_consulta', 'formularios_um_por_agendamento', 'um formulário por agendamento'],
  ['ia_chamadas', 'ia_chamadas_chave_unica', 'retry de IA devolve o mesmo resultado, sem custo dobrado'],
  ['ia_avaliacoes', 'ia_avaliacoes_unicas', 'reavaliar não duplica avaliação'],
  ['notificacoes', 'notificacoes_chave_unica', 'reprocessar não duplica aviso no sino'],
  ['agentes', 'agentes_slug_uk', 'dois agentes não dividem o mesmo identificador'],
  ['serena_configuracao', 'serena_configuracao_canais_desligados_array',
    'canal calado só entra como lista: objeto ou texto viraria adivinhação na hora de responder'],
];

// Funções nossas que precisam de `search_path` fixo. Sem ele, um schema no
// caminho de quem chama decide qual tabela a função enxerga.
const FUNCOES_COM_SEARCH_PATH = [
  'set_atualizado_em', 'limpar_sessoes_vencidas', 'limpar_recuperacoes_vencidas',
  'limpar_tentativas_vencidas', 'app_usuario_atual',
];

// Tabelas cujo histórico não se reescreve. A aplicação não deve ter privilégio
// de apagá-las — nem depender de a policy segurar. `operacao_heartbeats` e
// `auditoria_exportacoes` entram pela migration 029: a validação em produção
// pegou DELETE herdado de default privileges, e esta lista é o teste negativo
// executável que impede a regressão.
const SEM_DELETE = ['audit_log', 'lead_eventos', 'usuarios', 'operacao_heartbeats', 'auditoria_exportacoes'];

// Toda tabela do produto precisa de RLS. A lista é explícita para que uma tabela
// nova sem RLS apareça como falta, não passe despercebida.
const TABELAS_COM_RLS = [
  'usuarios', 'contatos', 'conversas', 'mensagens', 'etiquetas', 'conversa_etiquetas',
  'leads', 'notas_internas', 'audit_log', 'eventos_recebidos', 'sessoes',
  'recuperacoes_senha', 'tentativas_autenticacao', 'lead_eventos',
  'profissionais', 'disponibilidades', 'agenda_bloqueios', 'agendamentos', 'lembretes',
  'serena_configuracao', 'serena_prompts', 'serena_regras',
  'tarefas', 'formularios_pre_consulta', 'eventos_analiticos',
  'ia_modelos', 'ia_chamadas', 'ia_avaliacoes', 'notificacoes', 'serena_ativacao_contatos',
  'google_outbox', 'google_sincronia_estado', 'google_eventos_externos',
  'google_sincronia_conflitos', 'termos', 'termo_assinaturas',
  // Agentes configuráveis (migration 046, docs/AGENTES.md).
  'agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais',
  // Equipe dos agentes e registro de envios do resumo (migration 047).
  'agente_equipe',
  'resumo_envios',
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

    // Migration 046 (agentes). A presença de tabelas e colunas já foi cobrada
    // em ESPERADO; aqui, o que só o catálogo responde e que, faltando, quebra
    // em produção sem erro de sintaxe nenhum: sem SELECT em `agentes`, toda
    // leitura de conversa (LEFT JOIN agentes) dá "permission denied"; sem o
    // índice por lower(instancia), duas grafias da mesma instância viram dois
    // donos; com FK SET NULL, apagar agente devolve conversas à clínica.
    if (porNome.has('agentes')) {
      for (const tabela of ['agentes', 'agente_comportamentos', 'agente_treinamentos', 'agente_acoes_inatividade', 'agente_canais']) {
        if (!porNome.has(tabela)) continue;
        const { rows: [leitura] } = await pool.query(
          "SELECT has_table_privilege('crmclinica_app', $1, 'SELECT') AS pode",
          [`public.${tabela}`],
        );
        marcar(leitura.pode, `SELECT em ${tabela}`, leitura.pode ? '' : 'a aplicação não lê: o inbox cai');
        const { rows: [trunca] } = await pool.query(
          "SELECT has_table_privilege('crmclinica_app', $1, 'TRUNCATE') AS pode",
          [`public.${tabela}`],
        );
        marcar(!trunca.pode, `sem TRUNCATE em ${tabela}`, trunca.pode ? 'TRUNCATE ignora o RLS' : '');
        // RLS ligada sem política da aplicação: a tabela fica invisível SEM erro
        // (obterAgentePorCanal devolveria null e o cliente cairia na clínica).
        const temPolitica = (politicasPorTabela.get(tabela) ?? []).includes('app_trabalho');
        marcar(temPolitica, `política app_trabalho em ${tabela}`, temPolitica ? '' : 'a aplicação não enxerga as linhas');
      }

      const { rows: indices } = await pool.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'agente_canais_instancia_uk'",
      );
      const indiceCerto = indices.length === 1
        && /UNIQUE/i.test(indices[0].indexdef) && /lower\(instancia\)/i.test(indices[0].indexdef);
      marcar(indiceCerto, 'índice agente_canais_instancia_uk por (canal, lower(instancia))',
        indices.length === 0 ? 'ausente' : (indiceCerto ? '' : `forma diferente: ${indices[0].indexdef}`));

      const { rows: chaves } = await pool.query(`
        SELECT c.confdeltype
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND c.conrelid = 'public.conversas'::regclass
           AND c.confrelid = 'public.agentes'::regclass AND a.attname = 'agente_id'
      `);
      // 'r' = RESTRICT. Mais de uma FK também é defeito (IF NOT EXISTS reaplicado em versão antiga).
      const restrict = chaves.length === 1 && chaves[0].confdeltype === 'r';
      marcar(restrict, 'conversas.agente_id com FK ON DELETE RESTRICT',
        chaves.length === 0 ? 'FK ausente' : (restrict ? '' : `${chaves.length} FK(s), confdeltype=${chaves.map((ch) => ch.confdeltype).join(',')}`));
    }

    // Migration 047 (equipe dos agentes). Sem SELECT em agente_equipe, ninguém
    // além do admin enxerga conversa de agente; com UPDATE/TRUNCATE sobrando, o
    // vínculo vira editável por fora do RLS; sem o gatilho, o próprio usuário
    // pode se dar acesso à clínica pela política de autoatualização.
    if (porNome.has('agente_equipe')) {
      const { rows: [privEquipe] } = await pool.query(`
        SELECT has_table_privilege('crmclinica_app', 'public.agente_equipe', 'SELECT') AS le,
               has_table_privilege('crmclinica_app', 'public.agente_equipe', 'INSERT') AS insere,
               has_table_privilege('crmclinica_app', 'public.agente_equipe', 'DELETE') AS apaga,
               has_table_privilege('crmclinica_app', 'public.agente_equipe', 'UPDATE') AS atualiza,
               has_table_privilege('crmclinica_app', 'public.agente_equipe', 'TRUNCATE') AS trunca
      `);
      marcar(privEquipe.le && privEquipe.insere && privEquipe.apaga, 'SELECT/INSERT/DELETE em agente_equipe',
        privEquipe.le ? '' : 'a aplicação não lê: só o admin veria conversa de agente');
      marcar(!privEquipe.atualiza && !privEquipe.trunca, 'sem UPDATE/TRUNCATE em agente_equipe',
        privEquipe.trunca ? 'TRUNCATE ignora o RLS' : '');
      const temPoliticaEquipe = (politicasPorTabela.get('agente_equipe') ?? []).includes('app_trabalho');
      marcar(temPoliticaEquipe, 'política app_trabalho em agente_equipe', temPoliticaEquipe ? '' : 'a aplicação não enxerga as linhas');

      const { rows: chavesEquipe } = await pool.query(`
        SELECT a.attname AS coluna, c.confdeltype
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND c.conrelid = 'public.agente_equipe'::regclass
           AND a.attname IN ('agente_id', 'usuario_id')
      `);
      // 'c' = CASCADE: apagar agente ou usuário leva só o vínculo.
      const cascata = chavesEquipe.length === 2 && chavesEquipe.every((chave) => chave.confdeltype === 'c');
      marcar(cascata, 'agente_equipe com FKs ON DELETE CASCADE',
        cascata ? '' : `${chavesEquipe.length} FK(s): ${chavesEquipe.map((ch) => `${ch.coluna}=${ch.confdeltype}`).join(', ')}`);

      const { rows: gatilhos } = await pool.query(`
        SELECT tgenabled FROM pg_trigger
         WHERE tgrelid = 'public.usuarios'::regclass AND tgname = 'trg_usuarios_acesso_clinica_guard'
      `);
      const gatilhoLigado = gatilhos.length === 1 && gatilhos[0].tgenabled !== 'D';
      marcar(gatilhoLigado, 'gatilho trg_usuarios_acesso_clinica_guard em usuarios',
        gatilhos.length === 0 ? 'ausente: o próprio usuário pode se dar acesso à clínica' : (gatilhoLigado ? '' : 'desligado'));
    }

    // Registro de envios do resumo (migration 047, auditoria M2). Sem INSERT ou
    // UPDATE o worker não reserva nem conclui envio — e sem reserva não envia;
    // com DELETE/TRUNCATE sobrando, o registro que impede reenvio pode sumir.
    if (porNome.has('resumo_envios')) {
      const { rows: [privEnvios] } = await pool.query(`
        SELECT has_table_privilege('crmclinica_app', 'public.resumo_envios', 'SELECT') AS le,
               has_table_privilege('crmclinica_app', 'public.resumo_envios', 'INSERT') AS insere,
               has_table_privilege('crmclinica_app', 'public.resumo_envios', 'UPDATE') AS atualiza,
               has_table_privilege('crmclinica_app', 'public.resumo_envios', 'DELETE') AS apaga,
               has_table_privilege('crmclinica_app', 'public.resumo_envios', 'TRUNCATE') AS trunca
      `);
      marcar(privEnvios.le && privEnvios.insere && privEnvios.atualiza, 'SELECT/INSERT/UPDATE em resumo_envios',
        privEnvios.insere ? '' : 'o worker não reserva envio: nenhum resumo sai');
      marcar(!privEnvios.apaga && !privEnvios.trunca, 'sem DELETE/TRUNCATE em resumo_envios',
        privEnvios.trunca ? 'TRUNCATE ignora o RLS' : '');
      const temPoliticaEnvios = (politicasPorTabela.get('resumo_envios') ?? []).includes('app_trabalho');
      marcar(temPoliticaEnvios, 'política app_trabalho em resumo_envios', temPoliticaEnvios ? '' : 'a aplicação não enxerga as linhas');
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
