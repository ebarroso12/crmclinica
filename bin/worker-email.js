#!/usr/bin/env node
'use strict';

// Worker da fila de e-mail (db/051).
//
//   npm run email:worker
//   npm run email:worker -- --uma-vez        (processa um lote e sai)
//   npm run email:worker -- --intervalo=15   (segundos entre lotes)
//
// Por que a fila existe, e por que o envio é AQUI: o servidor HTTP da produção
// é uma função serverless na Vercel. Lá o processo morre em segundos (entrega
// lenta vira timeout na cara de quem clicou), o IP muda a cada execução (e IP
// sem reputação cai em spam) e a senha do e-mail não pode ser posta sem o
// painel. Este worker roda no VPS: IP fixo, vive o tempo que precisar, e já
// guarda as credenciais dos outros serviços.
//
// Igual aos outros workers do projeto: duas cópias podem rodar ao mesmo tempo
// sem mandar o mesmo e-mail duas vezes — quem garante isso é o
// `FOR UPDATE SKIP LOCKED` da reivindicação, não o cuidado deste arquivo.

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { criarPool, encerrarPool } = require('../src/dados/pool');
const { criarRepositorio } = require('../src/dados/repositorio');
const { criarRemetente } = require('../src/seguranca/email');

function lerArgumento(nome, padrao = null) {
  const encontrado = process.argv.find((argumento) => argumento.startsWith(`--${nome}=`));
  return encontrado ? encontrado.split('=')[1] : padrao;
}

// Espera crescente entre tentativas: 1, 4, 9, 16… minutos. Servidor de e-mail
// recusando agora costuma aceitar depois; insistir de segundo em segundo só
// piora a reputação do remetente.
function esperaDaTentativa(tentativas) {
  return Math.min(tentativas * tentativas * 60, 30 * 60);
}

async function processarLote({ repositorio, remetente, lote, registrar }) {
  const pendentes = await repositorio.reivindicarEmails({ limite: lote });
  if (pendentes.length === 0) return { processados: 0, enviados: 0 };

  let enviados = 0;
  for (const item of pendentes) {
    try {
      const resultado = await remetente.enviar({
        para: item.para,
        assunto: item.assunto,
        texto: item.texto ?? '',
      });

      if (resultado?.enviado === false) throw new Error(resultado.motivo || 'envio recusado');

      await repositorio.marcarEmailEnviado(item.id);
      enviados += 1;
      // O destinatário entra no log; o corpo, nunca — ele carrega o link que
      // redefine a senha.
      registrar(`e-mail ${item.id} entregue para ${item.para}`);
    } catch (erro) {
      const desistir = item.tentativas >= item.max_tentativas;
      await repositorio.marcarEmailFalhou(item.id, {
        erro: erro.message,
        desistir,
        esperaSegundos: esperaDaTentativa(item.tentativas),
      });
      registrar(
        desistir
          ? `e-mail ${item.id} desistiu depois de ${item.tentativas} tentativas: ${erro.message}`
          : `e-mail ${item.id} falhou (tentativa ${item.tentativas}): ${erro.message}`,
      );
    }
  }

  return { processados: pendentes.length, enviados };
}

async function principal() {
  const configuracao = carregarConfiguracao(process.env);

  if (!configuracao.banco.url) {
    console.error('[email] CRMCLINICA_DATABASE_URL não está definida.');
    console.error('[email] A fila é persistente por definição: sem banco não há worker.');
    process.exit(1);
  }

  const remetente = criarRemetente(configuracao.email, { registrar: () => {} });
  if (!remetente.enviaDireto) {
    console.error('[email] SMTP não configurado NESTE processo (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).');
    console.error('[email] Sem isso o worker só tiraria e-mail da fila para falhar — melhor não subir.');
    process.exit(1);
  }

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);
  const registrar = (mensagem) => console.log(`[email] ${mensagem}`);

  const lote = Number(lerArgumento('lote', 10));
  const intervaloMs = Number(lerArgumento('intervalo', 20)) * 1000;
  const umaVez = process.argv.includes('--uma-vez');

  registrar(`worker iniciado (lote=${lote}, intervalo=${intervaloMs}ms)`);

  let rodando = true;
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      registrar(`${sinal}: encerrando depois do lote corrente…`);
      rodando = false;
    });
  }

  do {
    try {
      const { processados, enviados } = await processarLote({ repositorio, remetente, lote, registrar });
      if (processados > 0) registrar(`lote: ${enviados}/${processados} entregues`);
    } catch (erro) {
      // Banco fora do ar não pode matar o worker: ele volta no próximo ciclo.
      registrar(`falha no lote: ${erro.message}`);
    }
    if (umaVez || !rodando) break;
    await new Promise((resolver) => { setTimeout(resolver, intervaloMs); });
  } while (rodando);

  await encerrarPool();
  registrar('encerrado');
}

principal().catch((erro) => {
  console.error(`[email] ${erro.message}`);
  process.exit(1);
});
