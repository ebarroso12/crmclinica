'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarGeradorDeResumo, montarPromptDoResumo, interpretarResumo } = require('../src/dominio/resumo-ia');
const { criarResumoDeAtendimento } = require('../src/dominio/resumo-atendimento');

// Nenhum teste aqui abre rede: o gateway é sempre um dublê.

const MENSAGENS = [
  { autor_tipo: 'contato', conteudo: 'Boa tarde, queria marcar uma consulta' },
  { autor_tipo: 'automacao', conteudo: 'Claro! É sua primeira consulta?' },
  { autor_tipo: 'contato', conteudo: 'Sim, venho por encaminhamento do psicólogo, tenho 31 anos' },
];

// ------------------------------------------------------------------ prompt

test('o prompt leva a conversa com papéis e a qualificação como apoio', () => {
  const prompt = montarPromptDoResumo({
    contato: { nome: 'Rafael' },
    mensagens: MENSAGENS,
    qualificacao: { interesse: 'consulta', pagamento: 'convenio', primeira_consulta: true },
  });

  assert.match(prompt, /Contato: Rafael/);
  assert.match(prompt, /interesse: consulta/);
  assert.match(prompt, /primeira_consulta: sim/);
  assert.match(prompt, /Paciente: Boa tarde, queria marcar uma consulta/);
  assert.match(prompt, /Clínica: Claro! É sua primeira consulta\?/);
});

test('mensagem gigante entra truncada no prompt — o modelo não precisa do livro inteiro', () => {
  const prompt = montarPromptDoResumo({
    mensagens: [{ autor_tipo: 'contato', conteudo: 'x'.repeat(2000) }],
  });
  assert.ok(!prompt.includes('x'.repeat(400)), 'o texto precisa ter sido cortado');
});

// ------------------------------------------------------------------ interpretação

test('resposta curta demais não é resumo — é falha do modelo, e vira null', () => {
  assert.equal(interpretarResumo(''), null);
  assert.equal(interpretarResumo('ok'), null);
  assert.equal(interpretarResumo(null), null);
});

test('resposta normal passa e a tagarela é cortada no teto', () => {
  const normal = 'Nome: Rafael\nConversa: pediu consulta por encaminhamento do psicólogo.';
  assert.equal(interpretarResumo(normal), normal);
  assert.ok(interpretarResumo('a'.repeat(3000)).length <= 1500);
});

// ------------------------------------------------------------------ gerador

test('o gerador nunca lança: gateway quebrado devolve null', async () => {
  const gerador = criarGeradorDeResumo({
    gateway: { async gerar() { throw new Error('gateway fora do ar'); } },
  });
  assert.equal(await gerador.gerar({ mensagens: MENSAGENS, chaveIdempotencia: 'r:1' }), null);
});

test('sem chave de idempotência ou sem conversa, nem chama o gateway', async () => {
  let chamadas = 0;
  const gerador = criarGeradorDeResumo({
    gateway: { async gerar() { chamadas += 1; return { resposta: 'x'.repeat(60) }; } },
  });
  assert.equal(await gerador.gerar({ mensagens: MENSAGENS }), null);
  assert.equal(await gerador.gerar({ mensagens: [], chaveIdempotencia: 'r:2' }), null);
  assert.equal(chamadas, 0);
});

// --------------------------------------------- resumo de atendimento com IA

function montarAmbiente({ respostaDaIa } = {}) {
  const envios = [];
  const marcadas = [];

  const repositorio = {
    async listarConversasSemResumo() { return [{ id: 7, contato_id: 3 }]; },
    async obterContato() { return { id: 3, nome: 'Rafael', telefone: '5516900000001' }; },
    async listarMensagens() { return MENSAGENS; },
    async obterAgendamentoDoContato() { return null; },
    async obterLeadPorContato() {
      return { interesse: 'consulta', temperatura: 'quente', score: 71, estagio: 'agendado' };
    },
    async marcarResumoEnviado(id) { marcadas.push(id); },
  };

  const resumo = criarResumoDeAtendimento({
    repositorio,
    canal: { async enviar(pedido) { envios.push(pedido); } },
    destinatarios: ['5516911111111', '5516922222222'],
    gerador: respostaDaIa === undefined ? null : {
      async gerar() { return respostaDaIa; },
    },
  });

  return { resumo, envios, marcadas };
}

test('com a IA no ar, a equipe recebe o RESUMO DE LEAD: nome no título e dados do banco', async () => {
  const daIa = 'Procura: consulta por encaminhamento do psicólogo\nSituacao: perguntou sobre Unimed e valores.\nFalta: confirmar horário com a equipe.';
  const { resumo, envios } = montarAmbiente({ respostaDaIa: daIa });

  await resumo.enviarPendentes();

  assert.equal(envios.length, 2, 'um envio por destinatário');
  assert.match(envios[0].texto, /^RESUMO DE LEAD — Rafael/, 'o título leva o NOME da pessoa');
  assert.match(envios[0].texto, /Telefone: 5516900000001/, 'telefone vem do banco, não do modelo');
  assert.match(envios[0].texto, /Qualificacao: quente \(score 71\)/, 'qualificação vem do lead');
  assert.match(envios[0].texto, /Estagio: agendado/);
  assert.match(envios[0].texto, /encaminhamento do psicólogo/, 'o contexto da conversa está no corpo');
  assert.match(envios[0].texto, /Mensagens trocadas: 3/, 'o rodapé conta as mensagens');
});

test('IA falhando (null), o recorte determinístico continua saindo — nunca silêncio', async () => {
  const { resumo, envios, marcadas } = montarAmbiente({ respostaDaIa: null });

  await resumo.enviarPendentes();

  assert.equal(envios.length, 2);
  assert.match(envios[0].texto, /Atendimento encerrado/);
  assert.match(envios[0].texto, /Queixa:/, 'formato do recorte — a reserva de sempre');
  assert.deepEqual(marcadas, [7]);
});
