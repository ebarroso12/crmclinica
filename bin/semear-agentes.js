#!/usr/bin/env node
'use strict';

// Semeia um agente configurável a partir de um arquivo JSON.
//
//   npm run semear-agentes -- --arquivo=configuracao/agentes/alpins.json            (simulação)
//   npm run semear-agentes -- --arquivo=configuracao/agentes/alpins.json --aplicar  (grava)
//
// Lições de docs/INCIDENTE-REGRAS-SEMEADAS.md aplicadas de propósito:
//
//   1. Importar este arquivo NUNCA conecta em banco nenhum: `main()` só roda
//      como script (`require.main === module`). Os testes importam as funções
//      puras daqui em todo `npm test`.
//   2. Sem `--aplicar`, é simulação: descreve o que faria a partir do arquivo,
//      não lê `.env` e não abre conexão. Gravar é um ato explícito.
//   3. Tudo é validado por src/dominio/agentes/regras.js ANTES de qualquer
//      escrita, e a escrita acontece numa transação só — arquivo com um
//      treinamento inválido não deixa meio agente no banco.
//
// E uma regra deste produto: o seeder nunca LIGA um agente. Agente novo nasce
// `desativado` mesmo que o arquivo peça `ativo` (com aviso), e num agente que
// já existe o status não é tocado — ligar ou desligar é decisão tomada no
// painel, depois do teste, por quem responde pelo que o agente diz.
//
// Idempotente por slug: cria se não existe; se existe, atualiza só os campos
// que diferem do arquivo, acrescenta só os treinamentos cujo conteúdo ainda
// não está lá, e substitui ações de inatividade e canais pelo que o arquivo diz.

const fs = require('node:fs');
const path = require('node:path');

const regras = require('../src/dominio/agentes/regras');

const CAMPOS_DO_AGENTE = Object.freeze([
  'slug', 'nome', 'descricao', 'status', 'comunicacao', 'comportamento', 'finalidade',
  'empresa_nome', 'empresa_site', 'empresa_descricao', 'provedor', 'modelo', 'configuracoes',
]);

function lerArgumentos(argv) {
  const prefixo = '--arquivo=';
  const arquivo = argv.find((argumento) => argumento.startsWith(prefixo))?.slice(prefixo.length) || null;
  return { arquivo, aplicar: argv.includes('--aplicar') };
}

function chaveDeConteudo(treinamento) {
  return `${treinamento.tipo}|${String(treinamento.conteudo ?? '').replace(/\s+/g, ' ').trim()}`;
}

/** Valida o arquivo inteiro. Lança no primeiro problema, com o caminho do campo. */
function validarArquivo(dados) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    throw new Error('o arquivo de agente precisa conter um objeto JSON');
  }

  const campos = {};
  for (const chave of CAMPOS_DO_AGENTE) {
    if (Object.prototype.hasOwnProperty.call(dados, chave)) campos[chave] = dados[chave];
  }

  const avisos = [];
  const agente = regras.validarAgente(campos);
  if (agente.status === 'ativo') {
    avisos.push('o arquivo pede status "ativo" — um agente novo é gravado como "desativado"; ligar é decisão do painel, depois do teste');
  }
  agente.status = 'desativado';
  agente.configuracoes = regras.normalizarConfiguracoes(agente.configuracoes);

  const listaDeTreinamentos = dados.treinamentos ?? [];
  if (!Array.isArray(listaDeTreinamentos)) throw new Error('treinamentos deve ser uma lista');
  const vistos = new Set();
  const treinamentos = [];
  listaDeTreinamentos.forEach((bruto, indice) => {
    let treinamento;
    try {
      treinamento = regras.validarTreinamento(bruto);
    } catch (erro) {
      throw new Error(`treinamentos[${indice}]: ${erro.message}`);
    }
    const chave = chaveDeConteudo(treinamento);
    if (vistos.has(chave)) {
      avisos.push(`treinamentos[${indice}] repete o conteúdo de outro treinamento do arquivo — ignorado`);
      return;
    }
    vistos.add(chave);
    treinamentos.push(treinamento);
  });

  return {
    agente,
    treinamentos,
    acoes: regras.validarAcoesDeInatividade(dados.acoes_inatividade ?? []),
    canais: regras.validarCanais(dados.canais ?? []),
    avisos,
  };
}

/** Plano puro: o que gravar, comparando o arquivo validado com o que existe (ou nada). */
function planejarSemeadura(validado, existente = null, treinamentosExistentes = []) {
  const conhecidos = new Set(treinamentosExistentes.map(chaveDeConteudo));
  const treinamentosNovos = validado.treinamentos.filter((treinamento) => !conhecidos.has(chaveDeConteudo(treinamento)));

  if (!existente) {
    return {
      acao: 'criar',
      agenteId: null,
      campos: { ...validado.agente },
      camposAlterados: Object.keys(validado.agente),
      treinamentosNovos,
      acoes: validado.acoes,
      canais: validado.canais,
      avisos: [...validado.avisos],
    };
  }

  // Status fora da comparação: num agente existente ele é do painel.
  const { status: _statusDoArquivo, ...semStatus } = validado.agente;
  const camposAlterados = Object.keys(semStatus).filter((campo) => (
    JSON.stringify(existente[campo] ?? null) !== JSON.stringify(semStatus[campo] ?? null)
  ));

  return {
    acao: 'atualizar',
    agenteId: existente.id,
    campos: Object.fromEntries(camposAlterados.map((campo) => [campo, semStatus[campo]])),
    camposAlterados,
    treinamentosNovos,
    acoes: validado.acoes,
    canais: validado.canais,
    avisos: [...validado.avisos, `status atual mantido: "${existente.status}"`],
  };
}

/** Grava o plano numa transação só. */
async function aplicarPlano(repositorio, plano) {
  return repositorio.comUsuario(null, async () => {
    let agente;
    if (plano.acao === 'criar') {
      agente = await repositorio.criarAgente(plano.campos, { usuarioId: null });
    } else if (plano.camposAlterados.length > 0) {
      agente = await repositorio.atualizarAgente(plano.agenteId, plano.campos, { usuarioId: null });
    } else {
      agente = await repositorio.obterAgente(plano.agenteId);
    }

    for (const treinamento of plano.treinamentosNovos) {
      await repositorio.criarTreinamento(agente.id, treinamento);
    }
    await repositorio.definirAcoesDeInatividade(agente.id, plano.acoes);
    await repositorio.definirCanaisDoAgente(agente.id, plano.canais);

    await repositorio.registrarAuditoria({
      entidade: 'agente',
      entidadeId: agente.id,
      acao: plano.acao === 'criar' ? 'agente_semeado' : 'agente_ressemeado',
      detalhe: {
        slug: agente.slug,
        campos: plano.camposAlterados,
        treinamentos_novos: plano.treinamentosNovos.length,
      },
    });
    return agente;
  });
}

function descrever(plano) {
  const linhas = [];
  const nome = plano.campos.nome ?? plano.campos.slug ?? `agente #${plano.agenteId}`;
  if (plano.acao === 'criar') {
    linhas.push(`Criar "${nome}" (slug ${plano.campos.slug}) com status "${plano.campos.status}".`);
  } else {
    linhas.push(`Atualizar o agente #${plano.agenteId}: ${plano.camposAlterados.length
      ? `campos ${plano.camposAlterados.join(', ')}`
      : 'nenhum campo diferente'}.`);
  }
  linhas.push(`Treinamentos a acrescentar: ${plano.treinamentosNovos.length}.`);
  linhas.push(`Ações de inatividade (substituem as atuais): ${plano.acoes
    .map((acao) => `${acao.apos_minutos} min → ${acao.acao}`).join('; ') || 'nenhuma'}.`);
  linhas.push(`Canais (substituem os atuais): ${plano.canais
    .map((canal) => `${canal.canal}:${canal.instancia}${canal.ativo ? '' : ' (inativo)'}`).join('; ') || 'nenhum'}.`);
  for (const aviso of plano.avisos) linhas.push(`Aviso: ${aviso}`);
  return linhas.join('\n');
}

async function main() {
  const { arquivo, aplicar } = lerArgumentos(process.argv.slice(2));
  if (!arquivo) {
    console.error('uso: npm run semear-agentes -- --arquivo=configuracao/agentes/<slug>.json [--aplicar]');
    process.exit(1);
  }

  const dados = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), arquivo), 'utf8'));
  const validado = validarArquivo(dados);

  if (!aplicar) {
    // Sem banco: descreve como se o slug ainda não existisse.
    console.log(descrever(planejarSemeadura(validado)));
    console.log('\nSimulação: nada foi gravado e nenhum banco foi consultado.');
    console.log('Se o slug já existir, --aplicar atualiza só o que difere e mantém o status atual.');
    return;
  }

  const caminhoEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(caminhoEnv) && typeof process.loadEnvFile === 'function') process.loadEnvFile(caminhoEnv);

  const { carregarConfiguracao } = require('../src/config');
  const configuracao = carregarConfiguracao();
  if (!configuracao.banco.configurado) {
    console.error('CRMCLINICA_DATABASE_URL não está definida — nada foi gravado.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');
  const { exigirConexaoSegura } = require('../src/dados/conferir-conexao');

  const pool = criarPool(configuracao.banco);
  try {
    await exigirConexaoSegura(pool, { producao: configuracao.producao });
    const repositorio = criarRepositorio(pool);

    const existente = await repositorio.obterAgentePorSlug(validado.agente.slug);
    const treinamentosExistentes = existente ? await repositorio.listarTreinamentos(existente.id) : [];
    const plano = planejarSemeadura(validado, existente, treinamentosExistentes);

    console.log(descrever(plano));
    const agente = await aplicarPlano(repositorio, plano);
    console.log(`\nGravado: agente #${agente.id} (${agente.slug}), status "${agente.status}".`);
  } finally {
    await encerrarPool();
  }
}

if (require.main === module) {
  main().catch((erro) => {
    console.error(`falha ao semear o agente: ${erro.message}`);
    process.exit(1);
  });
}

module.exports = { lerArgumentos, validarArquivo, planejarSemeadura, aplicarPlano, descrever };
