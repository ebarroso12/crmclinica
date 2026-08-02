#!/usr/bin/env node
'use strict';

// Worker dos lembretes de agendamento.
//
//   npm run lembretes:worker
//   npm run lembretes:worker -- --uma-vez        (processa um lote e sai)
//   npm run lembretes:worker -- --intervalo=30   (segundos entre lotes)
//   npm run lembretes:worker -- --lote=50
//
// Este processo pode rodar em duas ou mais cópias ao mesmo tempo. Não é um
// detalhe de escala: é uma garantia que o desenho precisa oferecer, porque em
// algum momento alguém sobe uma segunda instância — num deploy, numa migração
// de servidor, ou sem perceber. Duas cópias não mandam a mesma mensagem duas
// vezes porque a reivindicação usa `FOR UPDATE SKIP LOCKED` (ver
// `reivindicarLembretes` em src/dados/repositorio.js), e não porque este arquivo
// tem cuidado.
//
// O que ele garante por si:
//   • um lote por vez — nunca dois em paralelo no mesmo processo;
//   • encerramento limpo — SIGINT/SIGTERM esperam o lote corrente terminar;
//   • falha de um lote não derruba o worker: o próximo tenta de novo.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const os = require('node:os');
const { carregarConfiguracao } = require('../src/config');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarAdaptadorDeLembretes } = require('../src/integracoes/openclaw-lembretes');

function lerArgumento(nome, padrao = null) {
  const prefixo = `--${nome}=`;
  const encontrado = process.argv.find((argumento) => argumento.startsWith(prefixo));
  return encontrado ? encontrado.slice(prefixo.length) : padrao;
}

const temFlag = (nome) => process.argv.includes(`--${nome}`);

/** Identidade desta cópia: aparece na linha reivindicada e nos logs. */
function identificarWorker() {
  return `${os.hostname()}:${process.pid}`.slice(0, 100);
}

async function main() {
  const configuracao = carregarConfiguracao();

  if (!configuracao.banco.configurado) {
    console.error('[lembretes] CRMCLINICA_DATABASE_URL não está definida.');
    console.error('[lembretes] A fila é persistente por definição: sem banco não há worker.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');
  const { exigirConexaoSegura } = require('../src/dados/conferir-conexao');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);

  // Mesma exigência do servidor: conectar como dono das tabelas desliga o RLS
  // sem avisar. Um worker que roda sozinho no servidor merece a mesma barreira.
  try {
    await exigirConexaoSegura(pool, { producao: configuracao.producao });
  } catch (erro) {
    console.error(`[lembretes] ${erro.message}`);
    await encerrarPool();
    process.exit(1);
  }

  const entrega = criarAdaptadorDeLembretes(
    { ...configuracao.openclaw, modoEntrega: configuracao.lembretes.modoEntrega },
    { registrar: (mensagem, dados) => console.log(`[lembretes] ${mensagem}`, JSON.stringify(dados)) },
  );

  const lembretes = criarServicoDeLembretes({
    repositorio,
    entrega,
    clinica: configuracao.lembretes.clinica,
    maxTentativas: configuracao.lembretes.maxTentativas,
  });

  const worker = identificarWorker();
  const lote = Number(lerArgumento('lote', configuracao.lembretes.lote));
  const intervaloMs = lerArgumento('intervalo')
    ? Number(lerArgumento('intervalo')) * 1000
    : configuracao.lembretes.intervaloMs;

  console.log(`[lembretes] worker ${worker} iniciado`);
  console.log(`[lembretes] entrega: ${JSON.stringify(entrega.descrever())}`);
  if (entrega.modo === 'dry_run') {
    console.warn('[lembretes] MODO DRY-RUN: a fila processa normalmente e NENHUMA mensagem sai.');
  }

  let encerrando = false;
  let rodando = false;

  async function umLote() {
    // Um lote por vez. Sem isto, um lote lento e um intervalo curto fariam dois
    // ciclos se sobreporem dentro do mesmo processo.
    if (rodando || encerrando) return null;
    rodando = true;
    try {
      const resultado = await lembretes.processarLote({ limite: lote, worker });
      if (resultado.reivindicados > 0 || resultado.recuperados > 0) {
        console.log('[lembretes] lote', JSON.stringify({
          reivindicados: resultado.reivindicados,
          enviados: resultado.enviados,
          ignorados: resultado.ignorados,
          falhados: resultado.falhados,
          reagendados: resultado.reagendados,
          recuperados: resultado.recuperados,
          modo: resultado.modo,
        }));
      }
      return resultado;
    } catch (erro) {
      // Um lote que falha não derruba o worker: o banco pode ter piscado, e o
      // próximo ciclo tenta de novo. Derrubar aqui pararia a fila inteira.
      console.error(`[lembretes] falha no lote: ${erro.message}`);
      return null;
    } finally {
      rodando = false;
    }
  }

  if (temFlag('uma-vez')) {
    const resultado = await umLote();
    console.log(JSON.stringify(resultado ?? { erro: 'lote falhou' }, null, 2));
    await encerrarPool();
    return;
  }

  const relogio = setInterval(umLote, intervaloMs);
  await umLote();

  const encerrar = async (sinal) => {
    if (encerrando) return;
    encerrando = true;
    console.log(`[lembretes] ${sinal}: encerrando depois do lote corrente…`);
    clearInterval(relogio);

    // Espera o lote em andamento. Matar no meio deixaria linhas em
    // 'processando' — recuperáveis, mas só depois do lease de 5 minutos.
    while (rodando) await new Promise((resolve) => setTimeout(resolve, 100));

    await encerrarPool();
    console.log('[lembretes] encerrado');
    process.exit(0);
  };

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

main().catch(async (erro) => {
  console.error(`[lembretes] falha ao iniciar o worker: ${erro.message}`);
  process.exit(1);
});
