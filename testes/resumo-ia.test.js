'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  criarGeradorDeResumo, montarPromptDoResumo, interpretarResumo, SISTEMA, SISTEMA_AGENTE, PROMPT_VERSION_AGENTE,
} = require('../src/dominio/resumo-ia');
const { criarResumoDeAtendimento } = require('../src/dominio/resumo-atendimento');

// Nenhum teste aqui abre rede: o gateway é sempre um dublê.

const MENSAGENS = [
  { autor_tipo: 'contato', conteudo: 'Boa tarde, queria marcar uma consulta' },
  { autor_tipo: 'automacao', conteudo: 'Claro! É sua primeira consulta?' },
  { autor_tipo: 'contato', conteudo: 'Sim, venho por encaminhamento do psicólogo, tenho 31 anos' },
];

// Duas pessoas da equipe da clínica com WhatsApp autorizado (docs/RESUMOS.md).
const EQUIPE_DA_CLINICA = [
  {
    id: 1, nome: 'Admin', papel: 'admin', acesso_clinica: true, recebe_resumo: true, agentes: [],
    whatsapp_ddi: '55', whatsapp_ddd: '16', whatsapp_numero: '911111111', whatsapp_particular_autorizado: true,
  },
  {
    id: 2, nome: 'Atendente', papel: 'atendente', acesso_clinica: true, recebe_resumo: true, agentes: [],
    whatsapp_ddi: '55', whatsapp_ddd: '16', whatsapp_numero: '922222222', whatsapp_particular_autorizado: true,
  },
];

// ------------------------------------------------------------------ prompt

test('o prompt leva a conversa com papéis e a qualificação como apoio — nunca o nome do cadastro', () => {
  const prompt = montarPromptDoResumo({
    mensagens: MENSAGENS,
    qualificacao: { interesse: 'consulta', pagamento: 'convenio', primeira_consulta: true },
  });

  assert.match(prompt, /interesse: consulta/);
  assert.match(prompt, /primeira_consulta: sim/);
  assert.match(prompt, /Paciente: Boa tarde, queria marcar uma consulta/);
  assert.match(prompt, /Clínica: Claro! É sua primeira consulta\?/);
  assert.ok(!prompt.includes('Contato:'),
    'injetar o nome do cadastro fazia o modelo repeti-lo no corpo — o cabeçalho já o carrega');
});

test('o prompt novo tem versão própria, e a versão compõe a chave do cache', async () => {
  const { PROMPT_VERSION } = require('../src/dominio/resumo-ia');
  const chamadas = [];
  const gerador = criarGeradorDeResumo({
    gateway: { async gerar(pedido) { chamadas.push(pedido); return { resposta: 'x'.repeat(60) }; } },
  });

  await gerador.gerar({ mensagens: MENSAGENS, chaveIdempotencia: 'resumo:conversa:7:entrada:3' });

  assert.notEqual(PROMPT_VERSION, 'resumo-v1', 'mudou o prompt, muda a versão');
  assert.equal(chamadas[0].promptVersion, PROMPT_VERSION);
  assert.equal(chamadas[0].sistema, SISTEMA, 'a clínica continua com o prompt aprovado');
  assert.equal(chamadas[0].chaveIdempotencia, `resumo:conversa:7:entrada:3:${PROMPT_VERSION}`,
    'sem a versão na chave, o cache devolveria para sempre o corpo no formato velho');
});

test('conversa de agente: prompt, papéis e versão próprios — sem "paciente", sem qualificação da clínica', async () => {
  const prompt = montarPromptDoResumo({
    mensagens: MENSAGENS, qualificacao: { interesse: 'consulta' }, contexto: 'agente',
  });
  assert.match(prompt, /Cliente: Boa tarde/);
  assert.match(prompt, /Atendimento: Claro!/);
  assert.ok(!/Paciente|Clínica|interesse/.test(prompt));

  const chamadas = [];
  const gerador = criarGeradorDeResumo({
    gateway: { async gerar(pedido) { chamadas.push(pedido); return { resposta: 'y'.repeat(60) }; } },
  });
  await gerador.gerar({ mensagens: MENSAGENS, chaveIdempotencia: 'resumo:conversa:9:entrada:4', contexto: 'agente' });

  assert.equal(chamadas[0].sistema, SISTEMA_AGENTE);
  assert.ok(!/psiquiatria|paciente/i.test(SISTEMA_AGENTE));
  assert.equal(chamadas[0].chaveIdempotencia, `resumo:conversa:9:entrada:4:${PROMPT_VERSION_AGENTE}`);
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
  // Conferência final, item 2: o corte é o mesmo limite que o prompt pede.
  assert.match(SISTEMA, /Máximo de 700 caracteres/);
  assert.match(SISTEMA_AGENTE, /Máximo de 700 caracteres/);
  const cortado = interpretarResumo('a'.repeat(3000));
  assert.equal(cortado.length, 700);
  assert.ok(cortado.endsWith('…'));
});

test('o corte no teto não parte emoji ao meio (conferência final sobre ee2faaa, B3)', () => {
  // 698 unidades e um emoji (par substituto) cruzando a posição 699: o corte por
  // unidade UTF-16 deixava a metade alta do par solta antes da reticência.
  const cortado = interpretarResumo(`${'a'.repeat(698)}😀${'b'.repeat(100)}`);
  assert.ok(cortado.length <= 700, 'o teto em unidades continua valendo');
  assert.ok(cortado.endsWith('…'));
  assert.doesNotMatch(cortado, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'nenhuma metade de par substituto solta');
  assert.equal(interpretarResumo(`${'a'.repeat(697)}😀${'b'.repeat(100)}`), `${'a'.repeat(697)}😀…`,
    'o emoji que cabe inteiro fica');
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

function repositorioDeUmaConversa({ conversa, contato, lead }) {
  const marcadas = [];
  return {
    marcadas,
    async listarConversasSemResumo() { return [conversa]; },
    async listarDestinatariosDeResumo() { return EQUIPE_DA_CLINICA; },
    async obterContato() { return contato; },
    async listarMensagens() { return MENSAGENS; },
    async obterAgendamentoDoContato() { return null; },
    async obterLeadPorContato() { return lead; },
    async marcarResumoEnviado(id) { marcadas.push(id); return true; },
  };
}

function montarAmbiente({ respostaDaIa } = {}) {
  const envios = [];
  const repositorio = repositorioDeUmaConversa({
    conversa: { id: 7, contato_id: 3, agente_id: null, ultima_entrada_id: 3 },
    contato: { id: 3, nome: 'Rafael', telefone: '5516900000001' },
    lead: { interesse: 'consulta', temperatura: 'quente', score: 71, estagio: 'agendado' },
  });

  const resumo = criarResumoDeAtendimento({
    repositorio,
    canal: { async enviar(pedido) { envios.push(pedido); } },
    gerador: respostaDaIa === undefined ? null : {
      async gerar() { return respostaDaIa; },
    },
  });

  return { resumo, envios, marcadas: repositorio.marcadas };
}

test('com a IA no ar, a equipe recebe o RESUMO DE LEAD: nome no título e dados do banco', async () => {
  const daIa = 'Procura: consulta por encaminhamento do psicólogo\nSituacao: perguntou sobre Unimed e valores.\nFalta: confirmar horário com a equipe.';
  const { resumo, envios } = montarAmbiente({ respostaDaIa: daIa });

  await resumo.enviarPendentes();

  assert.equal(envios.length, 2, 'um envio por pessoa da equipe');
  assert.match(envios[0].texto, /^RESUMO DA CLÍNICA[\s\S]*RESUMO DE LEAD — Rafael/, 'o bloco leva o NOME da pessoa');
  assert.match(envios[0].texto, /Telefone: 5516900000001/, 'telefone vem do banco, não do modelo');
  assert.match(envios[0].texto, /Qualificacao: quente \(score 71\)/, 'qualificação vem do lead');
  assert.match(envios[0].texto, /Estagio: agendado/);
  assert.match(envios[0].texto, /encaminhamento do psicólogo/, 'o contexto da conversa está no corpo');
  assert.match(envios[0].texto, /Mensagens trocadas: 3/, 'o bloco conta as mensagens');
});

test('IA falhando (null), a reserva sai NO MESMO layout — muda a profundidade, não o formato', async () => {
  const { resumo, envios, marcadas } = montarAmbiente({ respostaDaIa: null });

  await resumo.enviarPendentes();

  assert.equal(envios.length, 2);
  assert.match(envios[0].texto, /RESUMO DE LEAD — Rafael/, 'o cabeçalho aprovado vale também no degradado');
  assert.match(envios[0].texto, /Idade: 31/, 'o recorte determinístico preenche o miolo');
  assert.match(envios[0].texto, /Procura: Boa tarde, queria marcar uma consulta/);
  assert.match(envios[0].texto, /Mensagens trocadas: 3/);
  assert.deepEqual(marcadas, [7]);
});

test('"Agendou: NÃO" é explícito — estágio preso em "agendado" não pode virar consulta de pé', async () => {
  const daIa = 'Procura: consulta.\nSituacao: cancelou a consulta que tinha.';
  const { resumo, envios } = montarAmbiente({ respostaDaIa: daIa });

  await resumo.enviarPendentes();

  assert.match(envios[0].texto, /Agendou: NÃO/,
    'sem agendamento futuro no banco, o NÃO tem de estar escrito — silêncio lê-se como SIM');
});

test('lead nunca avaliado não sai como "frio (score 0)" — default do banco não é veredito', async () => {
  const envios = [];
  const resumo = criarResumoDeAtendimento({
    repositorio: repositorioDeUmaConversa({
      conversa: { id: 8, contato_id: 4, agente_id: null, ultima_entrada_id: 5 },
      contato: { id: 4, nome: 'Maria', telefone: '5516900000002' },
      // Como o Postgres devolve um lead que ninguém avaliou: defaults NOT NULL.
      lead: { temperatura: 'frio', score: 0, estagio: 'novo' },
    }),
    canal: { async enviar(pedido) { envios.push(pedido); } },
    gerador: { async gerar() { return 'Procura: consulta.'; } },
  });

  await resumo.enviarPendentes();

  assert.match(envios[0].texto, /Qualificacao: ainda não avaliada/);
  assert.ok(!envios[0].texto.includes('score 0'), 'score 0 com cara de fato despriorizaria lead quente');
});
