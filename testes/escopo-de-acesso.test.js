'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TODOS, montarEscopo, veAgente, veConversaDe, veContato, selosDoContato,
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

test('contato: base compartilhada para quem vê a clínica; colaborador da loja só vê cliente dos agentes dele', () => {
  const clinica = montarEscopo(ATENDENTE, { acesso_clinica: true, agentes: [] });
  const loja = montarEscopo(ATENDENTE, { acesso_clinica: false, agentes: [1] });
  const admin = montarEscopo(ADMIN, null);

  assert.ok(veContato(clinica, []), 'contato manual sem conversa');
  assert.ok(veContato(clinica, [null, 1]));
  assert.ok(veContato(clinica, [1]), 'decisão 11/09: quem vê a clínica vê todo contato, inclusive o só da loja');

  assert.ok(!veContato(loja, []), 'loja não vê contato manual da clínica');
  assert.ok(!veContato(loja, [null]), 'loja não vê paciente');
  assert.ok(veContato(loja, [1]));
  assert.ok(veContato(loja, [null, 1]), 'mesma pessoa falando com a loja: a loja vê o contato dela');
  assert.ok(!veContato(loja, [2]));

  assert.ok(veContato(admin, [2]));
});

test('selos do contato: "Clínica" só para quem vê a clínica; agentes de todos para a clínica, só os da equipe para a loja', () => {
  const nomes = new Map([[1, 'Agente Alpins'], [2, 'Agente Bravo']]);
  const clinica = montarEscopo(ATENDENTE, { acesso_clinica: true, agentes: [] });
  const loja = montarEscopo(ATENDENTE, { acesso_clinica: false, agentes: [1] });

  assert.deepEqual(selosDoContato(clinica, { clinica: true, agentes: [2, 1, 1] }, nomes), {
    clinica: true, agentes: [{ id: 1, nome: 'Agente Alpins' }, { id: 2, nome: 'Agente Bravo' }],
  }, 'clínica fora da equipe vê o selo do Alpins (sem ver a conversa)');
  assert.deepEqual(selosDoContato(clinica, { clinica: false, agentes: [1] }, nomes), {
    clinica: false, agentes: [{ id: 1, nome: 'Agente Alpins' }],
  });

  assert.deepEqual(selosDoContato(loja, { clinica: true, agentes: [1, 2] }, nomes), {
    clinica: false, agentes: [{ id: 1, nome: 'Agente Alpins' }],
  }, 'para a loja, nunca "Clínica" (seria dizer que o cliente é paciente) nem agente de fora da equipe');

  assert.deepEqual(selosDoContato(null, { clinica: true, agentes: [1] }, nomes), { clinica: false, agentes: [] });
  assert.deepEqual(selosDoContato(clinica, { clinica: true, agentes: [3] }), { clinica: true, agentes: [{ id: 3, nome: null }] });
});

test('rotas liberadas para quem não vê a clínica: conta própria, conversas, contatos dos agentes dele e agentes', () => {
  const liberadas = [
    ['GET', '/api/auth/sessao'], ['POST', '/api/auth/refresh'], ['PUT', '/api/perfil'],
    ['GET', '/api/usuarios/termos/vigente'], ['POST', '/api/usuarios/termos/3/assinar'],
    ['GET', '/api/usuarios/onboarding/trilha'], ['GET', '/api/usuarios/ajuda'],
    ['GET', '/api/conversas'], ['GET', '/api/conversas/filas'], ['GET', '/api/conversas/escopo'],
    ['GET', '/api/conversas/eventos'], ['POST', '/api/conversas/eventos/ticket'],
    ['GET', '/api/conversas/12'], ['GET', '/api/conversas/12/mensagens'], ['POST', '/api/conversas/12/mensagens'],
    ['POST', '/api/conversas/12/anexos'], ['POST', '/api/conversas/12/assumir'], ['POST', '/api/conversas/12/etiquetas'],
    ['POST', '/api/conversas/12/prioridade'], ['POST', '/api/conversas/12/estado'],
    ['GET', '/api/contatos'], ['GET', '/api/contatos/gestao'], ['GET', '/api/contatos/5'],
    ['GET', '/api/contatos/5/conversas'],
    ['GET', '/api/agentes'], ['GET', '/api/agentes/aguardando'], ['GET', '/api/agentes/1/operacao'],
  ];
  for (const [metodo, rota] of liberadas) assert.ok(rotaLiberadaSemClinica(rota, metodo), `deveria liberar ${metodo} ${rota}`);

  const clinica = [
    ['GET', '/api/resumo'], ['GET', '/api/conversas/aguardando'], ['POST', '/api/conversas/liberar-todas'],
    ['GET', '/api/tarefas'], ['POST', '/api/tarefas/varrer'], ['POST', '/api/tarefas/3/concluir'],
    ['GET', '/api/notificacoes'], ['POST', '/api/notificacoes/3/lida'],
    ['GET', '/api/conversas/12/agenda'], ['POST', '/api/conversas/12/temperatura'], ['POST', '/api/conversas/12/encerrar'],
    ['GET', '/api/leads'], ['GET', '/api/leads/3'], ['GET', '/api/leads/vocabulario'], ['GET', '/api/agenda'],
    ['POST', '/api/agenda/3/formulario'], ['GET', '/api/metricas/resumo'], ['GET', '/api/ia/modelos'],
    ['POST', '/api/ia/assistente'], ['GET', '/api/serena'], ['POST', '/api/serena/interruptor'],
    ['POST', '/api/serena/voz/sessoes'], ['GET', '/api/diagnostico'], ['GET', '/api/instagram'], ['GET', '/api/auditoria'],
    ['GET', '/api/bloqueios'], ['GET', '/api/sincronia'], ['GET', '/api/lembretes'],
    // Auditoria de acesso A3: escrita em cadastro de contato é da clínica.
    ['PUT', '/api/contatos/5'], ['PUT', '/api/conversas/12/ficha'],
    // Auditoria de acesso B3: a nota é gravada na ficha do contato.
    ['POST', '/api/conversas/12/notas'],
    ['POST', '/api/contatos'], ['DELETE', '/api/contatos/5'], ['POST', '/api/contatos/5/restaurar'],
    ['GET', '/api/contatos/duplicatas'], ['GET', '/api/contatos/qualidade'], ['POST', '/api/contatos/5/lembretes'],
    ['POST', '/api/contatos/5/responsavel'], ['POST', '/api/conversas'],
    ['GET', '/api/usuarios'], ['GET', '/api/usuarios/gestao'], ['GET', '/api/usuarios/7'],
    ['POST', '/api/usuarios/7/acesso-clinica'], ['GET', '/api/usuarios/termos'], ['POST', '/api/usuarios/termos'],
    ['GET', '/api/conversas/12/../../resumo'], ['GET', '/api/conversasx'], ['GET', '/api/agentesx'], ['GET', ''],
  ];
  for (const [metodo, rota] of clinica) assert.ok(!rotaLiberadaSemClinica(rota, metodo), `deveria bloquear ${metodo} ${rota}`);
});
