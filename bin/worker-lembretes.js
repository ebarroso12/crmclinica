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
const { carregarConfiguracao, validarTransporteWhatsapp } = require('../src/config');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { criarSincronizadorDaSerena } = require('../src/dominio/sincronia-serena');
const { criarPoliticaDoCanal } = require('../src/integracoes/openclaw-politica');
const { executarDiagnostico } = require('../src/dominio/diagnostico');
const { sondaDoBanco, sondaDaFila, sondaDoCanal, sondaDaSerena } = require('../src/dominio/diagnostico-sondas');
const { decidirAtendimento } = require('../src/dominio/sincronia-serena');
const { criarVinculoDeCanal } = require('../src/integracoes/openclaw-vinculo');
const { conferirConexao } = require('../src/dados/conferir-conexao');
const { criarSincronizadorDeConversas } = require('../src/dominio/sincronia-conversas');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');
const { criarCanalDeConversas } = require('../src/integracoes/canal-conversas');
const { criarResumoDeAtendimento } = require('../src/dominio/resumo-atendimento');
const { criarClienteGateway, carregarOuCriarIdentidade, ESCOPOS_DE_CANAL } = require('../src/integracoes/openclaw-gateway');
const { OBJETOS_ESPERADOS } = require('../src/servidor/rotas-diagnostico');
const { criarAdaptadorDeLembretes } = require('../src/integracoes/openclaw-lembretes');
const { criarClienteOpenClaw } = require('../src/integracoes/openclaw');

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

  const problemasDoTransporte = validarTransporteWhatsapp(configuracao);
  if (problemasDoTransporte.length > 0) {
    for (const problema of problemasDoTransporte) {
      console.error(`[serena] configuração recusada: ${problema}`);
    }
    process.exit(1);
  }

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

  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const crmDespachaWhatsapp = configuracao.serena.transporteWhatsapp === 'crm_despacha';

  // Sem gateway do canal configurado não há o que sincronizar — e é melhor o
  // worker rodar a fila sem a sincronia do que não rodar de jeito nenhum.
  const sincronia = configuracao.openclaw.canalClinica?.url
    ? criarPoliticaDoCanal(configuracao.openclaw.canalClinica)
    : null;
  if (!sincronia) {
    console.warn('[serena] canal da clínica não configurado: o horário e a pausa não valem no WhatsApp.');
  }

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

  // No modo anterior, a Serena do OpenClaw responde ao paciente sem passar por
  // aqui. Sem esta sincronia, o interruptor, a pausa e a grade de horário do
  // painel seriam controles que não desligam nada — a tela diria "desligada" e
  // o paciente continuaria recebendo resposta automática. Na Arquitetura B, a
  // mesma política é mantida sempre calada e a decisão passa a ser do CRM.
  //
  // Fica no worker porque a decisão muda sozinha com a hora: às 18h a grade
  // abre, e ninguém vai estar no painel naquele minuto para aplicar.
  const sincronizador = sincronia && !crmDespachaWhatsapp
    ? criarSincronizadorDaSerena({ serena: servicoDaSerena, politica: sincronia })
    : null;

  async function sincronizarSerena() {
    if (!sincronia) return false;

    // Arquitetura B: o canal recebe mensagens, mas o agente conectado jamais
    // responde diretamente. Se não conseguirmos confirmar esse silêncio, o
    // ciclo não importa nem despacha nada — duplicidade falha fechada.
    if (crmDespachaWhatsapp) {
      try {
        await sincronia.definir(false);
        return true;
      } catch (erro) {
        console.error(`[serena] não foi possível confirmar o canal silencioso: ${erro.message}`);
        return false;
      }
    }

    if (!sincronizador) return true;
    const resultado = await sincronizador.sincronizar();
    if (resultado?.erro) console.error(`[serena] sincronia falhou: ${resultado.erro}`);
    return true;
  }


  // Varredura semanal. Roda no worker porque é o único processo que fica de pé
  // o tempo todo — a Vercel dorme entre requisições e nunca acordaria sozinha
  // num domingo de madrugada para conferir se o sistema ainda está inteiro.
  //
  // Ela relata, não conserta. Um reparo automático decide sozinho que entendeu
  // o problema, e quando erra, erra sem ninguém olhando, sobre dado de paciente.
  const UMA_SEMANA = 7 * 24 * 60 * 60 * 1000;

  async function varreduraSemanal() {
    try {
      const laudo = await executarDiagnostico({
        banco: sondaDoBanco(repositorio, OBJETOS_ESPERADOS, () => conferirConexao(pool)),
        fila: sondaDaFila(repositorio),
        canal: sondaDoCanal(configuracao.openclaw.canalClinica?.url
          ? criarVinculoDeCanal(configuracao.openclaw.canalClinica) : null),
        serena: sondaDaSerena(servicoDaSerena, sincronia, decidirAtendimento),
      });

      console.log('[diagnostico]', laudo.nivel + ':', laudo.resumo);
      for (const item of laudo.achados) {
        console.log(`[diagnostico]   [${item.nivel}] ${item.area}: ${item.titulo}`);
      }

      // Vai para a auditoria: um relatório que só existe no log do systemd some
      // na primeira rotação, e ninguém compara a semana passada com esta.
      await repositorio.registrarAuditoria({
        entidade: 'sistema', entidadeId: 1, acao: 'diagnostico_semanal',
        detalhe: { nivel: laudo.nivel, resumo: laudo.resumo, achados: laudo.achados },
      }).catch(() => {});
    } catch (erro) {
      // A varredura falhando não pode derrubar o worker: a fila de lembretes
      // que já estava pronta precisa continuar saindo.
      console.error(`[diagnostico] varredura falhou: ${erro.message}`);
    }
  }


  // Traz para o CRM as conversas que acontecem no WhatsApp. O OpenClaw desta
  // versao nao expoe webhook de saida, entao a leitura e por consulta:
  // sessions.list devolve as conversas, chat.history as mensagens de cada uma.
  //
  // Fica no worker porque ele ja vive conectado ao gateway e ja roda a cada
  // minuto — e porque a Vercel dorme entre requisicoes e nunca leria sozinha.
  let conversasDoCanal = null;
  function montarLeitorDeConversas() {
    if (conversasDoCanal !== null) return conversasDoCanal;
    if (!configuracao.openclaw.canalClinica?.url) return (conversasDoCanal = false);

    try {
      conversasDoCanal = criarSincronizadorDeConversas({
      gateway: criarClienteGateway({
        url: configuracao.openclaw.canalClinica.url,
        token: configuracao.openclaw.canalClinica.token || null,
        deviceToken: configuracao.openclaw.canalClinica.deviceToken || null,
        identidade: carregarOuCriarIdentidade(
          configuracao.openclaw.canalClinica.identidadePath,
          configuracao.openclaw.canalClinica.chavePrivada,
        ),
        timeoutMs: 45000,
        escopos: ESCOPOS_DE_CANAL,
      }),
      atendimento: criarAtendimento({
        repositorio,
        orquestrador: crmDespachaWhatsapp ? criarClienteOpenClaw(configuracao.openclaw) : null,
        leads: criarServicoDeLeads({ repositorio }),
        lembretes,
        serena: servicoDaSerena,
        canal: criarCanalDeConversas(configuracao.openclaw.canalClinica),
      }),
      repositorio,
      estrategiaIa: configuracao.serena.transporteWhatsapp,
      // Os administradores comandam a Serena e recebem os resumos: o que eles
      // escrevem não é atendimento, não vira contato e não entra no funil.
      numerosInternos: configuracao.numerosInternos,
      registrar: (m, d) => console.error(`[conversas] ${m}`, JSON.stringify(d)),
    });
    } catch (erro) {
      // Sem leitura de conversas o worker ainda entrega lembretes, que e a
      // razao de ele existir. Derrubar tudo por isto seria pior.
      console.error(`[conversas] leitor indisponivel: ${erro.message}`);
      conversasDoCanal = false;
    }
    return conversasDoCanal;
  }

  async function sincronizarConversas({ canalSeguro = true } = {}) {
    if (crmDespachaWhatsapp && !canalSeguro) return;
    const leitor = montarLeitorDeConversas();
    if (!leitor) return;
    try {
      await leitor.sincronizar();
    } catch (erro) {
      // Falha aqui não pode parar a fila de lembretes que já estava pronta.
      console.error(`[conversas] sincronia falhou: ${erro.message}`);
    }
  }

  // Resumo do atendimento para a equipe. Fica no worker porque o gatilho e o
  // silencio: ninguem se despede no WhatsApp, e so um processo que roda sozinho
  // percebe que a conversa esfriou.
  const resumoParaEquipe = criarResumoDeAtendimento({
    repositorio,
    canal: configuracao.openclaw.canalClinica?.url
      ? criarCanalDeConversas(configuracao.openclaw.canalClinica) : null,
    destinatarios: configuracao.resumoDeAtendimento.destinatarios,
    silencioMin: configuracao.resumoDeAtendimento.silencioMin,
  });

  if (!resumoParaEquipe.ativo) {
    console.warn('[resumo] sem destinatarios configurados: a equipe nao recebe resumo de atendimento.');
  }

  async function enviarResumos() {
    if (!resumoParaEquipe.ativo) return;
    try {
      await resumoParaEquipe.enviarPendentes();
    } catch (erro) {
      console.error(`[resumo] falhou: ${erro.message}`);
    }
  }
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

  let cicloEmAndamento = false;
  const cicloCompleto = async () => {
    if (cicloEmAndamento) return;
    cicloEmAndamento = true;
    try {
      const canalSeguro = await sincronizarSerena();
      await sincronizarConversas({ canalSeguro });
      await umLote();
      await enviarResumos();
    } finally {
      cicloEmAndamento = false;
    }
  };

  const relogioDaVarredura = setInterval(varreduraSemanal, UMA_SEMANA);
  relogioDaVarredura.unref();
  // Uma agora, para o primeiro laudo não esperar sete dias.
  varreduraSemanal();

  const relogio = setInterval(cicloCompleto, intervaloMs);
  await cicloCompleto();

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
