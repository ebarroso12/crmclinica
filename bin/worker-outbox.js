#!/usr/bin/env node
'use strict';

// Worker da outbox durável do atendimento automático (Comando 3).
//
//   npm run outbox:worker
//   npm run outbox:worker -- --uma-vez        (processa um lote e sai)
//   npm run outbox:worker -- --intervalo=5    (segundos entre lotes)
//   npm run outbox:worker -- --lote=20
//
// Substitui o `setImmediate` que rodava depois do 202 do webhook do
// WhatsApp. A rota (`src/servidor/http.js`) só grava o trabalho — quem faz
// a IA gerar a resposta e entregar ao paciente é este processo, lendo da
// tabela `automacao_outbox` (db/031).
//
// Igual ao worker de lembretes: pode rodar em duas ou mais cópias ao mesmo
// tempo sem risco de resposta duplicada. Quem garante isso é `FOR UPDATE
// SKIP LOCKED` na reivindicação (ver `reivindicarTrabalhosDeOutbox` em
// src/dados/repositorio.js), não o cuidado deste arquivo.
//
// A barreira de controle do Comando 2 (Desligar, Pausar, Assumir, PARAR
// SERENA) vale aqui do mesmo jeito que valeria numa chamada síncrona: o
// worker chama `atendimento.responderSePossivel`, que relê o controle
// imediatamente antes de qualquer envio. Este arquivo não reimplementa nada
// disso — só decide quando chamar, com que trabalho, e o que fazer com o
// desfecho (retentar, dar por concluído, ou mandar para dead-letter).

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const os = require('node:os');
const { carregarConfiguracao, validarTransporteWhatsapp } = require('../src/config');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDeOutbox } = require('../src/dominio/automacao-outbox-servico');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarCanalDeConversas } = require('../src/integracoes/canal-conversas');
const { criarClienteEvolucaoEnvio } = require('../src/integracoes/evolution-envio');
const { criarClienteInstagramEnvio } = require('../src/integracoes/instagram-envio');
const { criarAdaptadorDeLembretes } = require('../src/integracoes/openclaw-lembretes');
const { criarClienteOpenClaw } = require('../src/integracoes/openclaw');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');
const { criarGatewayDeIA } = require('../src/ia/gateway');
const { criarMotorDeAgentes } = require('../src/dominio/agentes/motor');

function lerArgumento(nome, padrao = null) {
  const prefixo = `--${nome}=`;
  const encontrado = process.argv.find((argumento) => argumento.startsWith(prefixo));
  return encontrado ? encontrado.slice(prefixo.length) : padrao;
}

const temFlag = (nome) => process.argv.includes(`--${nome}`);

/** Identidade desta cópia: aparece na linha reivindicada e no heartbeat. */
function identificarWorker() {
  return `${os.hostname()}:${process.pid}`.slice(0, 100);
}

async function main() {
  const configuracao = carregarConfiguracao();

  const problemasDoTransporte = validarTransporteWhatsapp(configuracao);
  if (problemasDoTransporte.length > 0) {
    for (const problema of problemasDoTransporte) {
      console.error(`[outbox] configuração recusada: ${problema}`);
    }
    process.exit(1);
  }

  if (!configuracao.banco.configurado) {
    console.error('[outbox] CRMCLINICA_DATABASE_URL não está definida.');
    console.error('[outbox] A fila é persistente por definição: sem banco não há worker.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');
  const { exigirConexaoSegura } = require('../src/dados/conferir-conexao');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);

  // Mesma exigência do servidor e do worker de lembretes: conectar como dono
  // das tabelas desliga o RLS sem avisar.
  try {
    await exigirConexaoSegura(pool, { producao: configuracao.producao });
  } catch (erro) {
    console.error(`[outbox] ${erro.message}`);
    await encerrarPool();
    process.exit(1);
  }

  // Três vias de entrega, mesma ordem e mesma composição que o servidor HTTP
  // usa (ver criarAplicacao em src/servidor/http.js): Evolution primeiro
  // quando configurada, o gateway do OpenClaw como reserva, e Instagram
  // (Graph API) para conversas do canal instagram. Sem a Evolution aqui,
  // o worker só entregaria pelo caminho antigo — silenciosamente sem a
  // via primária.
  const clienteEvolucaoEnvio = criarClienteEvolucaoEnvio(configuracao.evolution);
  const clienteInstagramEnvio = criarClienteInstagramEnvio(configuracao.instagram);
  const canalDeConversas = (configuracao.openclaw.canalClinica.url || clienteEvolucaoEnvio.disponivel || clienteInstagramEnvio.disponivel)
    ? criarCanalDeConversas(configuracao.openclaw.canalClinica, { evolucao: clienteEvolucaoEnvio, instagram: clienteInstagramEnvio })
    : null;
  if (!canalDeConversas) {
    console.warn('[outbox] nenhum canal de entrega configurado (nem Evolution, nem gateway do OpenClaw, nem Instagram) — os trabalhos vão ficar sem "canal_nao_configurado" resolvido.');
  }

  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const servicoDeLeads = criarServicoDeLeads({ repositorio });

  // A fila de lembretes entra porque `atendimento` usa `ehPedidoDeOptOut`
  // para "PARAR" pelo canal — mesma composição de dependências do servidor.
  const entregaDeLembretes = criarAdaptadorDeLembretes(
    { ...configuracao.openclaw, modoEntrega: configuracao.lembretes.modoEntrega },
    { registrar: (mensagem, dados) => console.log(`[outbox] ${mensagem}`, JSON.stringify(dados)) },
  );
  const servicoDeLembretes = configuracao.lembretes.ativos
    ? criarServicoDeLembretes({
      repositorio, entrega: entregaDeLembretes, clinica: configuracao.lembretes.clinica,
      maxTentativas: configuracao.lembretes.maxTentativas,
    })
    : null;

  // Comando 4 / frente 8: era condicionado a `SERENA_TRANSPORTE_WHATSAPP ===
  // 'crm_despacha'` — cópia indevida do padrão de `bin/worker-lembretes.js`,
  // onde essa variável decide se a sincronia de conversas por LEITURA (outra
  // funcionalidade) deve rodar. Aqui não faz sentido: todo trabalho que chega
  // à outbox já nasceu carimbado `crm_despacha` pela própria porta do webhook
  // (ver `exigirEstrategiaDoAdaptador`, adaptador `openclaw_ingresso_crm`) —
  // condicionar o orquestrador a essa variável fazia o worker, com o valor
  // padrão do `.env.exemplo` (`openclaw_gerencia`), nunca responder paciente
  // nenhum: todo trabalho reivindicado caía em `sem_orquestrador`. Mesma
  // composição incondicional que `criarAplicacao` já usa em
  // src/servidor/http.js.
  // Bug 2.2 da auditoria (Claude): sem emissor, nenhuma resposta deste worker
  // entra em `conversas_eventos` — e a releitura cross-processo do PR #50
  // fica sem o que reler. O emissor grava no banco mesmo sem conexões SSE
  // (o empurrão local simplesmente não alcança ninguém).
  const emissorDeConversas = criarEmissorDeConversas({ repositorio });

  // Agentes configuráveis (docs/AGENTES.md): quem gera a resposta de uma
  // conversa de agente é este worker, pelo gateway multi-IA — então as chaves
  // de IA precisam existir no .env DESTE processo (o do VPS), não só na Vercel.
  const motorDeAgentes = criarMotorDeAgentes({ gateway: criarGatewayDeIA({ configuracao, repositorio }) });

  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: criarClienteOpenClaw(configuracao.openclaw),
    // Quem opera a clinica nao entra no funil como paciente.
    numerosInternos: configuracao.numerosInternos,
    leads: servicoDeLeads,
    lembretes: servicoDeLembretes,
    serena: servicoDaSerena,
    canal: canalDeConversas,
    emissor: emissorDeConversas,
    agentes: motorDeAgentes,
    instanciasDaClinica: configuracao.evolution.instanciasDaClinica,
  });

  const outbox = criarServicoDeOutbox({
    repositorio, atendimento, idadeMaximaRespostaMs: configuracao.serena.idadeMaximaRespostaMs,
  });

  const worker = identificarWorker();
  const lote = Number(lerArgumento('lote', 20));
  const intervaloMs = lerArgumento('intervalo')
    ? Number(lerArgumento('intervalo')) * 1000
    : 5000; // um paciente esperando resposta não pode esperar o intervalo de 1 minuto dos lembretes.

  console.log(`[outbox] worker ${worker} iniciado (lote=${lote}, intervalo=${intervaloMs}ms)`);

  let encerrando = false;
  let rodando = false;

  async function marcarHeartbeat(ultimoLote = null) {
    try {
      const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
      await repositorio.registrarBatimentoDoSistema('automacao_outbox_worker', {
        status: 'ok',
        detalhe: {
          versao: require('../package.json').version,
          worker,
          ultima_execucao_em: new Date().toISOString(),
          fila_pendente: fila.pendente,
          fila_processando: fila.processando,
          fila_morta: fila.morto,
          fila_incerta: fila.incerto,
          ultimo_lote: ultimoLote,
        },
      });
    } catch (erro) {
      // A prova de vida não pode virar ponto único de falha do processamento.
      console.error(`[outbox] heartbeat não registrado: ${erro.message}`);
    }
  }

  async function umLote() {
    // Um lote por vez. Sem isto, um lote lento e um intervalo curto fariam
    // dois ciclos se sobreporem dentro do mesmo processo.
    if (rodando || encerrando) return null;
    rodando = true;
    try {
      const resultado = await outbox.processarLote({ limite: lote, worker });
      if (resultado.reivindicados > 0 || resultado.recuperados > 0) {
        // Resumo das ações dos concluídos: sem isto, um lote com
        // concluidos:1 pode esconder uma falha de entrega (escalonada)
        // ou um silenciamento da barreira (aguardando_equipe).
        const acoes = {};
        for (const item of resultado.resultados ?? []) {
          if (item.status === 'concluido' && item.acao) {
            acoes[item.acao] = (acoes[item.acao] ?? 0) + 1;
          }
        }
        console.log('[outbox] lote', JSON.stringify({
          reivindicados: resultado.reivindicados,
          concluidos: resultado.concluidos,
          reagendados: resultado.reagendados,
          mortos: resultado.mortos,
          incertos: resultado.incertos,
          recuperados: resultado.recuperados,
          acoes: Object.keys(acoes).length > 0 ? acoes : undefined,
        }));
      }
      return resultado;
    } catch (erro) {
      // Um lote que falha não derruba o worker: o banco pode ter piscado, e
      // o próximo ciclo tenta de novo.
      console.error(`[outbox] falha no lote: ${erro.message}`);
      return null;
    } finally {
      rodando = false;
    }
  }

  if (temFlag('uma-vez')) {
    const resultado = await umLote();
    await marcarHeartbeat(resultado);
    console.log(JSON.stringify(resultado ?? { erro: 'lote falhou' }, null, 2));
    await encerrarPool();
    return;
  }

  // Ações de inatividade dos agentes em relógio PRÓPRIO, nunca dentro do
  // ciclo da fila: "interagir" chama a IA e, com provedor lento, seguraria o
  // lote da clínica e o heartbeat por minutos — e trabalho parado 30 min é
  // escalonado em massa como expirado (achado ALTO 2 da auditoria). Uma
  // passada por minuto, com teto de tempo; falha aqui nunca derruba a fila.
  let varrendoInatividade = false;
  async function varrerInatividadeDeAgentes() {
    if (varrendoInatividade || encerrando) return;
    varrendoInatividade = true;
    try {
      const resumo = await atendimento.processarInatividadeDeAgentes({ limite: 20, orcamentoMs: 20_000 });
      if (resumo.finalizadas || resumo.interacoes || resumo.falhas || resumo.adiadas) {
        console.log('[outbox] inatividade de agentes', JSON.stringify(resumo));
      }
    } catch (erro) {
      console.error(`[outbox] falha na varredura de inatividade de agentes: ${erro.message}`);
    } finally {
      varrendoInatividade = false;
    }
  }

  let cicloEmAndamento = false;
  const cicloCompleto = async () => {
    if (cicloEmAndamento) return;
    cicloEmAndamento = true;
    try {
      const resultado = await umLote();
      await marcarHeartbeat(resultado);
    } finally {
      cicloEmAndamento = false;
    }
  };

  const relogio = setInterval(cicloCompleto, intervaloMs);
  const relogioDeInatividade = setInterval(varrerInatividadeDeAgentes, 60_000);
  await cicloCompleto();

  const encerrar = async (sinal) => {
    if (encerrando) return;
    encerrando = true;
    console.log(`[outbox] ${sinal}: encerrando depois do lote corrente…`);
    clearInterval(relogio);
    clearInterval(relogioDeInatividade);

    // Espera o lote em andamento. Matar no meio deixaria trabalhos em
    // 'processando' — recuperáveis, mas só depois do lease expirar.
    while (rodando || varrendoInatividade) await new Promise((resolve) => setTimeout(resolve, 100));

    await encerrarPool();
    console.log('[outbox] encerrado');
    process.exit(0);
  };

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

main().catch(async (erro) => {
  console.error(`[outbox] falha ao iniciar o worker: ${erro.message}`);
  process.exit(1);
});
