'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FILAS,
  TEMPERATURAS,
  ETIQUETA_ATENDIMENTO_HUMANO,
  aplicarTemperatura,
  lerTemperatura,
  decidirAutomacao,
  montarContextoMinimo,
} = require('../src/dominio/conversas');

// Etiquetas que a equipe já usa na conta. Nenhuma operação do CRM pode removê-las.
const ETIQUETAS_DA_EQUIPE = ['avaliacao', 'positiva', 'em_protocolo', 'pagou_sinal'];

test('as três filas do inbox estão declaradas', () => {
  assert.deepEqual(Object.keys(FILAS), ['minhas', 'nao_atribuidas', 'todos']);
  assert.equal(FILAS.minhas.rotulo, 'Minhas');
  assert.equal(FILAS.nao_atribuidas.rotulo, 'Não atribuídas');
  assert.equal(FILAS.todos.rotulo, 'Todos');
});

test('aplicar temperatura preserva todas as etiquetas da equipe', () => {
  const resultado = aplicarTemperatura(ETIQUETAS_DA_EQUIPE, 'quente');

  for (const etiqueta of ETIQUETAS_DA_EQUIPE) {
    assert.ok(resultado.includes(etiqueta), `a etiqueta "${etiqueta}" foi perdida`);
  }
  assert.ok(resultado.includes(TEMPERATURAS.quente));
});

test('trocar de temperatura substitui só a etiqueta de temperatura', () => {
  const comQuente = aplicarTemperatura(ETIQUETAS_DA_EQUIPE, 'quente');
  const comFrio = aplicarTemperatura(comQuente, 'frio');

  assert.ok(comFrio.includes(TEMPERATURAS.frio));
  assert.ok(!comFrio.includes(TEMPERATURAS.quente), 'a temperatura antiga deveria sair');
  assert.ok(!comFrio.includes(TEMPERATURAS.morno));
  for (const etiqueta of ETIQUETAS_DA_EQUIPE) {
    assert.ok(comFrio.includes(etiqueta), `a etiqueta "${etiqueta}" foi perdida`);
  }
  assert.equal(comFrio.length, ETIQUETAS_DA_EQUIPE.length + 1);
});

test('temperatura inválida é recusada', () => {
  assert.throws(() => aplicarTemperatura([], 'morna'), /temperatura inválida/);
});

test('lerTemperatura reconhece a etiqueta e devolve null quando não há', () => {
  assert.equal(lerTemperatura(['avaliacao', TEMPERATURAS.morno]), 'morno');
  assert.equal(lerTemperatura(ETIQUETAS_DA_EQUIPE), null);
  assert.equal(lerTemperatura([]), null);
});

test('a automação responde só quando não há humano na conversa', () => {
  const decisao = decidirAutomacao({ estado: 'open', responsavel: null, etiquetas: [] });
  assert.equal(decisao.responder, true);
  assert.equal(decisao.motivo, 'sem_humano_responsavel');
});

test('a automação cala assim que um humano assume', () => {
  const comResponsavel = decidirAutomacao({
    estado: 'open',
    responsavel: { id: 7, nome: 'Recepção' },
    etiquetas: [],
  });
  assert.equal(comResponsavel.responder, false);
  assert.equal(comResponsavel.motivo, 'humano_responsavel');
});

test('a etiqueta de atendimento humano também silencia a automação', () => {
  const decisao = decidirAutomacao({
    estado: 'open',
    responsavel: null,
    etiquetas: [ETIQUETA_ATENDIMENTO_HUMANO],
  });
  assert.equal(decisao.responder, false);
  assert.equal(decisao.motivo, 'marcada_para_atendimento_humano');
});

test('conversa resolvida, adiada ou pausada não recebe resposta automática', () => {
  const daqui_uma_hora = new Date(Date.now() + 3_600_000).toISOString();

  assert.equal(decidirAutomacao({ estado: 'resolved' }).motivo, 'conversa_resolvida');
  assert.equal(decidirAutomacao({ estado: 'snoozed' }).motivo, 'conversa_adiada');
  assert.equal(decidirAutomacao({ estado: 'open', pausadaAte: daqui_uma_hora }).motivo, 'pausa_temporaria');

  for (const conversa of [{ estado: 'resolved' }, { estado: 'snoozed' }, { estado: 'desconhecido' }]) {
    assert.equal(decidirAutomacao(conversa).responder, false);
  }
});

test('pausa vencida libera a automação de novo', () => {
  const ontem = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(decidirAutomacao({ estado: 'open', pausadaAte: ontem }).responder, true);
});

test('o contexto para o orquestrador é mínimo e sem nota interna', () => {
  const mensagens = [
    { autor: 'contato', texto: 'Oi', criadaEm: '2026-08-01T10:00:00.000Z' },
    { autor: 'equipe', texto: 'Nota interna sobre o paciente', privada: true, criadaEm: '2026-08-01T10:01:00.000Z' },
    { autor: 'equipe', texto: 'Olá! Como posso ajudar?', criadaEm: '2026-08-01T10:02:00.000Z' },
  ];

  const contexto = montarContextoMinimo(
    {
      id: 4678,
      estado: 'open',
      etiquetas: [TEMPERATURAS.quente],
      contato: { nome: 'Marina', telefone: '5516999999999', identificador: 'wa:1', email: 'x@y.z' },
    },
    mensagens,
  );

  assert.equal(contexto.conversa_id, 4678);
  assert.equal(contexto.temperatura, 'quente');
  assert.equal(contexto.mensagens.length, 2, 'a nota interna não pode ir para o orquestrador');
  assert.ok(!JSON.stringify(contexto).includes('Nota interna'));

  // Só identificação operacional atravessa a fronteira.
  assert.deepEqual(Object.keys(contexto.contato).sort(), ['identificador', 'nome', 'telefone']);
});

test('o contexto corta o histórico no limite pedido', () => {
  const muitas = Array.from({ length: 40 }, (_, indice) => ({
    autor: 'contato',
    texto: `mensagem ${indice}`,
    criadaEm: '2026-08-01T10:00:00.000Z',
  }));

  const contexto = montarContextoMinimo({ id: 1, estado: 'open' }, muitas, 5);
  assert.equal(contexto.mensagens.length, 5);
  assert.equal(contexto.mensagens.at(-1).texto, 'mensagem 39', 'deve manter as mais recentes');
});
