'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarGatewayDeIA, custoEstimado, ErroDeIA } = require('../src/ia/gateway');

// O gateway multi-IA e suas quatro promessas: allowlist do backend, retry
// idempotente, fallback apenas técnico e telemetria completa. Tudo com
// adaptadores falsos — nenhuma chave, nenhuma rede.

function adaptadorFalso({ falha = null, texto = 'resposta gerada' } = {}) {
  const chamadas = [];
  const funcao = async ({ modelo, prompt }) => {
    chamadas.push({ modelo, prompt });
    if (falha) throw falha;
    return { texto, tokensEntrada: 100, tokensSaida: 50 };
  };
  funcao.chamadas = chamadas;
  return funcao;
}

function montar({ adaptadores }) {
  const repositorio = criarRepositorioEmMemoria();
  const gateway = criarGatewayDeIA({
    configuracao: { ia: { timeoutMs: 1000 } },
    repositorio,
    adaptadores,
  });
  return { repositorio, gateway };
}

test('o catálogo agrupa por provedor e diz quem está disponível', async () => {
  const { gateway } = montar({ adaptadores: { anthropic: adaptadorFalso() } });

  const catalogo = await gateway.catalogo();
  const anthropic = catalogo.find((linha) => linha.provedor === 'anthropic');
  const openai = catalogo.find((linha) => linha.provedor === 'openai');

  assert.equal(anthropic.disponivel, true);
  assert.equal(openai.disponivel, false, 'sem chave no servidor, o menu mostra indisponível');
  assert.ok(anthropic.modelos.some((modelo) => modelo.padrao));
});

test('modelo fora do catálogo é recusado — allowlist é do backend, não do cliente', async () => {
  const { gateway } = montar({ adaptadores: { anthropic: adaptadorFalso() } });

  await assert.rejects(
    () => gateway.gerar({
      finalidade: 'teste', prompt: 'olá',
      provedor: 'anthropic', modelo: 'modelo-digitado-livre',
      chaveIdempotencia: 'k1',
    }),
    (erro) => erro.codigo === 'ia_fora_do_catalogo' && erro.status === 400,
  );
});

test('chamada sem chave de idempotência é recusada antes de custar dinheiro', async () => {
  const adaptador = adaptadorFalso();
  const { gateway } = montar({ adaptadores: { anthropic: adaptador } });

  await assert.rejects(
    () => gateway.gerar({ finalidade: 'teste', prompt: 'olá' }),
    (erro) => erro.codigo === 'ia_sem_chave',
  );
  assert.equal(adaptador.chamadas.length, 0);
});

test('sucesso registra a telemetria completa: modelo, latência, tokens, custo', async () => {
  const { repositorio, gateway } = montar({ adaptadores: { anthropic: adaptadorFalso() } });

  const resultado = await gateway.gerar({
    finalidade: 'relatorio_metricas', prompt: 'gerar', chaveIdempotencia: 'k-telemetria',
    promptVersion: 'v1',
  });

  assert.equal(resultado.provedor, 'anthropic');
  assert.ok(resultado.custo_estimado_usd > 0);

  const registro = await repositorio.obterChamadaDeIA('k-telemetria');
  assert.equal(registro.finalidade, 'relatorio_metricas');
  assert.equal(registro.prompt_version, 'v1');
  assert.equal(registro.tokens_entrada, 100);
  assert.equal(registro.tokens_saida, 50);
  assert.equal(registro.erro, null);
});

test('retry com a mesma chave devolve o MESMO resultado sem nova chamada', async () => {
  const adaptador = adaptadorFalso();
  const { gateway } = montar({ adaptadores: { anthropic: adaptador } });

  const primeira = await gateway.gerar({
    finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-retry',
  });
  const segunda = await gateway.gerar({
    finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-retry',
  });

  assert.equal(adaptador.chamadas.length, 1, 'a segunda chamada não paga de novo');
  assert.equal(segunda.de_cache, true);
  assert.equal(segunda.resposta, primeira.resposta);
});

test('falha TÉCNICA cai para o próximo provedor com a mesma chave; fallback fica registrado', async () => {
  const primario = adaptadorFalso({ falha: new ErroDeIA('timeout', 'ia_timeout') });
  const reserva = adaptadorFalso({ texto: 'resposta do reserva' });
  const { repositorio, gateway } = montar({
    adaptadores: { anthropic: primario, openai: reserva },
  });

  const resultado = await gateway.gerar({
    finalidade: 'teste', prompt: 'olá',
    provedor: 'anthropic', modelo: 'claude-haiku-4-5-20251001',
    chaveIdempotencia: 'k-fallback',
  });

  assert.equal(resultado.provedor, 'openai');
  assert.equal(resultado.fallback_de, 'anthropic');
  assert.equal(resultado.resposta, 'resposta do reserva');

  const registro = await repositorio.obterChamadaDeIA('k-fallback');
  assert.equal(registro.fallback_de, 'anthropic', 'a telemetria conta quem falhou primeiro');
});

test('recusa NÃO técnica não é retentada em outro provedor', async () => {
  const primario = adaptadorFalso({
    falha: new ErroDeIA('conteúdo recusado', 'ia_http_400', { tecnico: false }),
  });
  const reserva = adaptadorFalso();
  const { gateway } = montar({ adaptadores: { anthropic: primario, openai: reserva } });

  await assert.rejects(() => gateway.gerar({
    finalidade: 'teste', prompt: 'olá',
    provedor: 'anthropic', modelo: 'claude-haiku-4-5-20251001',
    chaveIdempotencia: 'k-recusa',
  }));

  assert.equal(reserva.chamadas.length, 0, 'fallback é técnico, nunca semântico');
});

test('todos os provedores fora: o erro final vira linha de telemetria', async () => {
  const { repositorio, gateway } = montar({
    adaptadores: { anthropic: adaptadorFalso({ falha: new ErroDeIA('fora', 'ia_rede') }) },
  });

  await assert.rejects(() => gateway.gerar({
    finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-tudo-fora',
  }));

  const registro = await repositorio.obterChamadaDeIA('k-tudo-fora');
  assert.match(registro.erro, /ia_rede/);
});

test('sem nenhum provedor com chave, o erro é claro e de serviço', async () => {
  const { gateway } = montar({ adaptadores: {} });

  await assert.rejects(
    () => gateway.gerar({ finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-vazio' }),
    (erro) => erro.codigo === 'ia_indisponivel' && erro.status === 503,
  );
});

test('o custo estimado usa o preço do catálogo por milhão de tokens', () => {
  const modelo = { custo_entrada_usd_mi: 1.0, custo_saida_usd_mi: 5.0 };
  assert.equal(custoEstimado(modelo, 1_000_000, 0), 1);
  assert.equal(custoEstimado(modelo, 0, 1_000_000), 5);
  assert.equal(custoEstimado(modelo, null, null), null, 'sem tokens não se inventa custo');
});

test('a telemetria listada NUNCA inclui o texto das respostas', async () => {
  const { repositorio, gateway } = montar({ adaptadores: { anthropic: adaptadorFalso() } });
  await gateway.gerar({ finalidade: 'teste', prompt: 'olá', chaveIdempotencia: 'k-lista' });

  const [linha] = await repositorio.listarChamadasDeIA({});
  assert.ok(!('resposta' in linha), 'lista de telemetria é metadado, não conteúdo');
});
