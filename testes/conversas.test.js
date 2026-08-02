'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FILAS,
  ESTADOS,
  PRIORIDADES,
  TEMPERATURAS,
  ETIQUETA_POR_TEMPERATURA,
  aplicarTemperatura,
  lerTemperatura,
  decidirAutomacao,
  montarContextoMinimo,
} = require('../src/dominio/conversas');

// Etiquetas operacionais que a equipe usa. Nenhuma operação do CRM pode removê-las.
const ETIQUETAS_DA_EQUIPE = ['avaliacao', 'positiva', 'em_protocolo', 'pagou_sinal'];

test('o vocabulário do inbox está declarado', () => {
  assert.deepEqual(Object.keys(FILAS), ['minhas', 'nao_atribuidas', 'todos']);
  assert.deepEqual(ESTADOS, ['aberta', 'pendente', 'resolvida']);
  assert.deepEqual(PRIORIDADES, ['baixa', 'media', 'alta', 'urgente']);
  assert.deepEqual(TEMPERATURAS, ['quente', 'morno', 'frio']);
});

test('aplicar temperatura preserva todas as etiquetas da equipe', () => {
  const resultado = aplicarTemperatura(ETIQUETAS_DA_EQUIPE, 'quente');

  for (const etiqueta of ETIQUETAS_DA_EQUIPE) {
    assert.ok(resultado.includes(etiqueta), `a etiqueta "${etiqueta}" foi perdida`);
  }
  assert.ok(resultado.includes(ETIQUETA_POR_TEMPERATURA.quente));
});

test('trocar de temperatura substitui só a etiqueta de temperatura', () => {
  const comQuente = aplicarTemperatura(ETIQUETAS_DA_EQUIPE, 'quente');
  const comFrio = aplicarTemperatura(comQuente, 'frio');

  assert.ok(comFrio.includes('lead_frio'));
  assert.ok(!comFrio.includes('lead_quente'), 'a temperatura antiga deveria sair');
  assert.ok(!comFrio.includes('lead_morno'));
  for (const etiqueta of ETIQUETAS_DA_EQUIPE) {
    assert.ok(comFrio.includes(etiqueta), `a etiqueta "${etiqueta}" foi perdida`);
  }
  assert.equal(comFrio.length, ETIQUETAS_DA_EQUIPE.length + 1);
});

test('temperatura inválida é recusada', () => {
  assert.throws(() => aplicarTemperatura([], 'morna'), /temperatura inválida/);
});

test('lerTemperatura reconhece a etiqueta e devolve null quando não há', () => {
  assert.equal(lerTemperatura(['avaliacao', 'lead_morno']), 'morno');
  assert.equal(lerTemperatura(ETIQUETAS_DA_EQUIPE), null);
  assert.equal(lerTemperatura([]), null);
});

test('a automação responde só quando não há humano na conversa', () => {
  const decisao = decidirAutomacao({ status: 'aberta', assumida_por_humano: false, atribuido_a: null });
  assert.equal(decisao.responder, true);
  assert.equal(decisao.motivo, 'sem_humano_responsavel');
});

test('a automação cala assim que a conversa é assumida', () => {
  const assumida = decidirAutomacao({ status: 'aberta', assumida_por_humano: true });
  assert.equal(assumida.responder, false);
  assert.equal(assumida.motivo, 'assumida_por_humano');

  const atribuida = decidirAutomacao({ status: 'aberta', assumida_por_humano: false, atribuido_a: 7 });
  assert.equal(atribuida.responder, false);
  assert.equal(atribuida.motivo, 'humano_responsavel');
});

test('conversa resolvida ou pausada não recebe resposta automática', () => {
  const daquiUmaHora = new Date(Date.now() + 3_600_000).toISOString();

  assert.equal(decidirAutomacao({ status: 'resolvida' }).motivo, 'conversa_resolvida');
  assert.equal(decidirAutomacao({ status: 'aberta', ia_pausada_ate: daquiUmaHora }).motivo, 'pausa_temporaria');
  assert.equal(decidirAutomacao({ status: 'arquivada' }).motivo, 'estado_desconhecido');

  for (const conversa of [{ status: 'resolvida' }, { status: 'arquivada' }]) {
    assert.equal(decidirAutomacao(conversa).responder, false);
  }
});

test('pausa vencida libera a automação de novo', () => {
  const ontem = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(decidirAutomacao({ status: 'aberta', ia_pausada_ate: ontem }).responder, true);
});

test('o contexto para o orquestrador é mínimo e sem nota interna', () => {
  const mensagens = [
    { autor_tipo: 'contato', conteudo: 'Oi', criado_em: '2026-08-01T10:00:00.000Z' },
    { autor_tipo: 'sistema', conteudo: 'Nota interna sobre o paciente', privada: true, criado_em: '2026-08-01T10:01:00.000Z' },
    { autor_tipo: 'sistema', tipo: 'sistema', conteudo: 'Conversa assumida', criado_em: '2026-08-01T10:01:30.000Z' },
    { autor_tipo: 'equipe', conteudo: 'Olá! Como posso ajudar?', criado_em: '2026-08-01T10:02:00.000Z' },
  ];

  const contexto = montarContextoMinimo(
    {
      id: 42,
      status: 'aberta',
      etiquetas: ['lead_quente'],
      contato: { nome: 'Marina', telefone: '5516999999999', identificador: 'wa:1', email: 'x@y.z' },
    },
    mensagens,
  );

  assert.equal(contexto.conversa_id, 42);
  assert.equal(contexto.temperatura, 'quente');
  assert.equal(contexto.mensagens.length, 2, 'nota interna e evento de sistema não vão ao orquestrador');
  assert.ok(!JSON.stringify(contexto).includes('Nota interna'));
  assert.ok(!JSON.stringify(contexto).includes('Conversa assumida'));

  // Só identificação operacional atravessa a fronteira.
  assert.deepEqual(Object.keys(contexto.contato).sort(), ['identificador', 'nome', 'telefone']);
});

test('o contexto corta o histórico no limite pedido', () => {
  const muitas = Array.from({ length: 40 }, (_, indice) => ({
    autor_tipo: 'contato',
    conteudo: `mensagem ${indice}`,
    criado_em: '2026-08-01T10:00:00.000Z',
  }));

  const contexto = montarContextoMinimo({ id: 1, status: 'aberta' }, muitas, 5);
  assert.equal(contexto.mensagens.length, 5);
  assert.equal(contexto.mensagens.at(-1).texto, 'mensagem 39', 'deve manter as mais recentes');
});
