'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TODOS, montarEscopo, veAgente, veConversaDe, veContato,
  recortarPedidoDeAgente, filtroDeEscopo, rotaLiberadaSemClinica,
} = require('../src/seguranca/escopo');

// A regra de "quem vê o quê" (clínica × agentes, migration 047) é pura: estes
// testes provam a decisão. Que cada ROTA a aplica prova
// testes/separacao-clinica-agentes.test.js.

const ADMIN = { papel: 'admin' };
const GESTOR = { papel: 'gestor' };
const ATENDENTE = { papel: 'atendente' };

test('admin vê tudo, com ou sem marca e sem equipe', () => {
  for (const dados of [null, { acesso_clinica: false, agentes: [] }, { acesso_clinica: true, agentes: [9] }]) {
    const escopo = montarEscopo(ADMIN, dados);
    assert.equal(escopo.admin, true);
    assert.equal(escopo.clinica, true);
    assert.equal(escopo.agentes, TODOS);
    assert.ok(veConversaDe(escopo, null));
    assert.ok(veConversaDe(escopo, 1234));
  }
});

test('atendente da clínica fora da equipe: vê a clínica e nenhum agente', () => {
  const escopo = montarEscopo(ATENDENTE, { acesso_clinica: true, agentes: [] });
  assert.equal(escopo.clinica, true);
  assert.deepEqual([...escopo.agentes], []);
  assert.ok(veConversaDe(escopo, null));
  assert.ok(!veConversaDe(escopo, 1));
});

test('colaborador da loja (não vê a clínica, equipe do Alpins): só o Alpins', () => {
  const escopo = montarEscopo(ATENDENTE, { acesso_clinica: false, agentes: [1] });
  assert.equal(escopo.clinica, false);
  assert.ok(!veConversaDe(escopo, null), 'conversa da clínica nunca');
  assert.ok(veConversaDe(escopo, 1));
  assert.ok(!veConversaDe(escopo, 2), 'outro agente não');
});

test('gestor na equipe de um agente vê a clínica e aquele agente', () => {
  const escopo = montarEscopo(GESTOR, { acesso_clinica: true, agentes: ['3', 3, 0, -1, 'x'] });
  assert.deepEqual([...escopo.agentes], [3], 'ids limpos e sem repetição');
  assert.ok(veAgente(escopo, 3));
  assert.ok(veAgente(escopo, '3'));
  assert.ok(!veAgente(escopo, 4));
});

test('falta de dado nega: usuário sem linha no banco não vê clínica nem agente; sem sessão, nada', () => {
  const escopo = montarEscopo(ATENDENTE, null);
  assert.equal(escopo.clinica, false);
  assert.ok(!veConversaDe(escopo, null));
  assert.ok(!veConversaDe(escopo, 1));
  assert.equal(montarEscopo(null, { acesso_clinica: true, agentes: [] }), null);
  assert.ok(!veConversaDe(null, null));
  assert.ok(!veAgente(null, 1));
  assert.ok(!veContato(null, []));
});

test('marca ausente na leitura vale como sim (padrão da coluna); só false explícito tira a clínica', () => {
  assert.equal(montarEscopo(ATENDENTE, { agentes: [] }).clinica, true);
  assert.equal(montarEscopo(ATENDENTE, { acesso_clinica: false }).clinica, false);
});

test('pedido de agente forjado na lista é recortado: o que não se vê vira lista vazia', () => {
  const loja = montarEscopo(ATENDENTE, { acesso_clinica: false, agentes: [1] });
  assert.equal(recortarPedidoDeAgente(loja, null), null, 'loja pedindo "só clínica"');
  assert.equal(recortarPedidoDeAgente(loja, 2), null, 'loja pedindo outro agente');
  assert.deepEqual(recortarPedidoDeAgente(loja, 1), { agenteId: 1 });
  assert.deepEqual(recortarPedidoDeAgente(loja, undefined), { agenteId: undefined });

  const clinica = montarEscopo(ATENDENTE, { acesso_clinica: true, agentes: [] });
  assert.equal(recortarPedidoDeAgente(clinica, 1), null, 'clínica fora da equipe pedindo o Alpins');
  assert.deepEqual(recortarPedidoDeAgente(clinica, null), { agenteId: null });
  assert.equal(recortarPedidoDeAgente(null, undefined), null);
});

test('filtro do repositório espelha o escopo e nunca devolve a referência interna', () => {
  const escopo = montarEscopo(GESTOR, { acesso_clinica: true, agentes: [2] });
  const filtro = filtroDeEscopo(escopo);
  assert.deepEqual(filtro, { clinica: true, agentes: [2] });
  filtro.agentes.push(99);
  assert.deepEqual([...escopo.agentes], [2]);
  assert.deepEqual(filtroDeEscopo(montarEscopo(ADMIN, null)), { clinica: true, agentes: TODOS });
  assert.deepEqual(filtroDeEscopo(null), { clinica: false, agentes: [] });
});

test('contato: da clínica se não tem conversa ou tem alguma da clínica; só de agente → daquele agente', () => {
  const clinica = montarEscopo(ATENDENTE, { acesso_clinica: true, agentes: [] });
  const loja = montarEscopo(ATENDENTE, { acesso_clinica: false, agentes: [1] });
  const admin = montarEscopo(ADMIN, null);

  assert.ok(veContato(clinica, []), 'contato manual sem conversa é da clínica');
  assert.ok(veContato(clinica, [null, 1]), 'paciente que também falou com a loja continua da clínica');
  assert.ok(!veContato(clinica, [1]), 'cliente só da loja não aparece para a clínica fora da equipe');

  assert.ok(!veContato(loja, []), 'loja não vê contato manual da clínica');
  assert.ok(!veContato(loja, [null]), 'loja não vê paciente');
  assert.ok(veContato(loja, [1]));
  assert.ok(veContato(loja, [null, 1]), 'mesma pessoa falando com a loja: a loja vê o contato dela');
  assert.ok(!veContato(loja, [2]));

  assert.ok(veContato(admin, [2]));
});

test('rotas liberadas para quem não vê a clínica: só conta própria, conversas, contato da conversa e agentes', () => {
  const liberadas = [
    '/api/auth/sessao', '/api/auth/refresh', '/api/perfil',
    '/api/usuarios/termos/vigente', '/api/usuarios/termos/3/assinar', '/api/usuarios/onboarding/trilha', '/api/usuarios/ajuda',
    '/api/conversas', '/api/conversas/filas', '/api/conversas/escopo',
    '/api/conversas/eventos', '/api/conversas/eventos/ticket',
    '/api/conversas/12', '/api/conversas/12/mensagens', '/api/conversas/12/anexos', '/api/conversas/12/assumir',
    '/api/conversas/12/etiquetas', '/api/conversas/12/prioridade', '/api/conversas/12/estado',
    '/api/conversas/12/notas', '/api/conversas/12/ficha',
    '/api/contatos/5', '/api/contatos/5/conversas',
    '/api/agentes', '/api/agentes/aguardando', '/api/agentes/1/operacao',
  ];
  for (const rota of liberadas) assert.ok(rotaLiberadaSemClinica(rota), `deveria liberar ${rota}`);

  const clinica = [
    '/api/resumo', '/api/conversas/aguardando', '/api/conversas/liberar-todas', '/api/tarefas', '/api/tarefas/varrer',
    '/api/tarefas/3/concluir', '/api/notificacoes', '/api/notificacoes/3/lida',
    '/api/conversas/12/agenda', '/api/conversas/12/temperatura', '/api/conversas/12/encerrar',
    '/api/leads', '/api/leads/3', '/api/leads/vocabulario', '/api/agenda', '/api/agenda/3/formulario',
    '/api/metricas/resumo', '/api/ia/modelos', '/api/ia/assistente', '/api/serena', '/api/serena/interruptor',
    '/api/serena/voz/sessoes', '/api/diagnostico', '/api/instagram', '/api/auditoria', '/api/bloqueios',
    '/api/sincronia', '/api/lembretes', '/api/contatos', '/api/contatos/gestao', '/api/contatos/duplicatas',
    '/api/contatos/qualidade', '/api/contatos/5/lembretes', '/api/contatos/5/responsavel', '/api/contatos/5/restaurar',
    '/api/usuarios', '/api/usuarios/gestao', '/api/usuarios/7', '/api/usuarios/7/acesso-clinica', '/api/usuarios/termos',
    '/api/conversas/12/../../resumo', '/api/conversasx', '/api/agentesx', '',
  ];
  for (const rota of clinica) assert.ok(!rotaLiberadaSemClinica(rota), `deveria bloquear ${rota}`);
});
