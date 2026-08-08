'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarGatewayDeIA } = require('../src/ia/gateway');
const { subirServidor } = require('./auxiliar');

// Retenção mínima e NÃO-VAZAMENTO de ia_chamadas.resposta.
//
// O texto gerado existe para uma finalidade só: o retry idempotente. Estes
// testes provam (a) que ele morre no prazo, com a telemetria intacta, e
// (b) — testes NEGATIVOS — que ele nunca aparece em métricas, auditoria,
// exportação de telemetria ou listagens, nem quando alguém tenta.

// Um marcador improvável de colidir com qualquer texto legítimo.
const MARCADOR = 'CONTEUDO-SENSIVEL-QUE-NUNCA-VAZA-7f3a9';

function ambienteComRelogio(inicio = '2026-08-01T12:00:00.000Z') {
  const relogio = { momento: new Date(inicio) };
  const agora = () => new Date(relogio.momento);
  const repositorio = criarRepositorioEmMemoria({ agora });
  return { relogio, agora, repositorio };
}

// ---------------------------------------------------------------- retenção

test('a retenção anula respostas vencidas e preserva TODA a telemetria da linha', async () => {
  const { relogio, repositorio } = ambienteComRelogio();

  await repositorio.registrarChamadaDeIA({
    chaveIdempotencia: 'k-velha', finalidade: 'teste', provedor: 'anthropic',
    modelo: 'claude-haiku-4-5-20251001', latenciaMs: 900, tokensEntrada: 100,
    tokensSaida: 50, custoEstimadoUsd: 0.00035, resposta: MARCADOR,
  });

  relogio.momento = new Date(relogio.momento.getTime() + 31 * 24 * 3_600_000);
  await repositorio.registrarChamadaDeIA({
    chaveIdempotencia: 'k-nova', finalidade: 'teste', provedor: 'anthropic',
    modelo: 'claude-haiku-4-5-20251001', resposta: 'resposta recente',
  });

  const { anuladas } = await repositorio.limparRespostasDeIA({ retencaoDias: 30 });
  assert.equal(anuladas, 1, 'só a vencida é anulada');

  const velha = await repositorio.obterChamadaDeIA('k-velha');
  assert.equal(velha.resposta, null, 'o conteúdo morreu');
  assert.equal(velha.latencia_ms, 900, 'a telemetria fica');
  assert.equal(velha.custo_estimado_usd, 0.00035);

  const nova = await repositorio.obterChamadaDeIA('k-nova');
  assert.equal(nova.resposta, 'resposta recente', 'dentro da janela, o retry ainda funciona');

  const denovo = await repositorio.limparRespostasDeIA({ retencaoDias: 30 });
  assert.equal(denovo.anuladas, 0, 'a retenção é idempotente');
});

test('após a retenção, o retry com a mesma chave regenera em vez de servir cache vazio', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  let chamadas = 0;
  const gateway = criarGatewayDeIA({
    configuracao: { ia: { timeoutMs: 500 } },
    repositorio,
    adaptadores: {
      anthropic: async () => {
        chamadas += 1;
        return { texto: `geração ${chamadas}`, tokensEntrada: 10, tokensSaida: 5 };
      },
    },
    agora: () => agora().getTime(),
  });

  await gateway.gerar({ finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-pos-retencao' });

  relogio.momento = new Date(relogio.momento.getTime() + 31 * 24 * 3_600_000);
  await repositorio.limparRespostasDeIA({ retencaoDias: 30 });

  const depois = await gateway.gerar({ finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-pos-retencao' });
  assert.equal(depois.de_cache, false, 'cache anulado não é servido como se fosse resultado');
  assert.equal(typeof depois.resposta, 'string');
  assert.ok(depois.resposta.length > 0);
});

// ------------------------------------------------- testes negativos de vazamento

async function semearChamadaComMarcador(repositorio) {
  await repositorio.registrarChamadaDeIA({
    chaveIdempotencia: 'k-marcador', finalidade: 'relatorio_metricas',
    provedor: 'anthropic', modelo: 'claude-haiku-4-5-20251001',
    latenciaMs: 100, tokensEntrada: 10, tokensSaida: 5, resposta: MARCADOR,
  });
}

test('NEGATIVO: a resposta não aparece na API de telemetria nem em nenhuma rota de leitura', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    await semearChamadaComMarcador(repositorio);

    for (const rota of [
      '/api/ia/chamadas',
      '/api/metricas/resumo',
      '/api/ia/avaliacoes',
      '/api/notificacoes',
      '/api/tarefas',
    ]) {
      const resposta = await ambiente.pedir(rota);
      assert.equal(resposta.status, 200, `${rota} deveria responder`);
      const corpo = await resposta.text();
      assert.ok(!corpo.includes(MARCADOR), `${rota} vazou o conteúdo da resposta de IA`);
    }
  } finally {
    await ambiente.encerrar();
  }
});

test('NEGATIVO: a auditoria nunca carrega o texto gerado, mesmo após o ciclo completo do gateway', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const gateway = criarGatewayDeIA({
    configuracao: { ia: { timeoutMs: 500 } },
    repositorio,
    adaptadores: {
      anthropic: async () => ({ texto: MARCADOR, tokensEntrada: 10, tokensSaida: 5 }),
    },
  });

  await gateway.gerar({ finalidade: 'teste', prompt: 'gerar', chaveIdempotencia: 'k-audit' });

  const trilha = JSON.stringify(repositorio._auditoria ?? []);
  assert.ok(!trilha.includes(MARCADOR), 'a trilha de auditoria carregou conteúdo gerado');
});

test('NEGATIVO: a exportação da telemetria (listagem) não tem o campo resposta em NENHUMA linha', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await semearChamadaComMarcador(repositorio);

  const linhas = await repositorio.listarChamadasDeIA({});
  for (const linha of linhas) {
    assert.ok(!('resposta' in linha), 'a listagem exporta metadado, nunca conteúdo');
  }
  assert.ok(!JSON.stringify(linhas).includes(MARCADOR));
});

test('NEGATIVO: o resumo de métricas de IA nunca consulta o texto — só agregados', async () => {
  const { repositorio } = ambienteComRelogio();
  await semearChamadaComMarcador(repositorio);

  const serena = await repositorio.metricasSerena({ de: '2026-07-01', ate: '2026-09-01' });
  assert.ok(!JSON.stringify(serena).includes(MARCADOR));
});
