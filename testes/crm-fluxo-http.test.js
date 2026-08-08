'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// As rotas do fluxo comercial por HTTP: sino, fila de SLA, encerramento com
// resumo interno, formulário condicionado e gestão do lead. O que se prova
// aqui é o roteamento e a permissão — a mecânica fina está em crm-fluxo.test.js.

const POST = (corpo) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(corpo ?? {}),
});

async function semearConversa(repositorio, { telefone = '5516900000031', nome = 'Paciente HTTP' } = {}) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome, canal: 'whatsapp' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id, origem: 'WHATSAPP' });
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Gostaria de agendar uma avaliação', autor_tipo: 'contato',
    id_externo: `wa:http:${telefone}`,
  });
  return { contato, conversa, lead };
}

test('fila de SLA: GET /api/conversas/aguardando devolve espera com idade em minutos', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    await semearConversa(repositorio);

    const resposta = await ambiente.pedir('/api/conversas/aguardando');
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.total, 1);
    assert.equal(typeof corpo.conversas[0].minutos_aguardando, 'number');
    assert.ok(corpo.conversas[0].aguardando_resposta_desde);
  } finally {
    await ambiente.encerrar();
  }
});

test('encerrar conversa por HTTP grava o resumo interno e resolve', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const { conversa } = await semearConversa(repositorio);

    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/encerrar`, POST({}));
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.match(corpo.resumo, /Resumo interno do atendimento/);

    const depois = await repositorio.obterConversa(conversa.id);
    assert.equal(depois.status, 'resolvida');
    assert.ok(depois.resumo_interno);
  } finally {
    await ambiente.encerrar();
  }
});

test('atendente não varre o sino; admin varre; tarefas aparecem e se concluem', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio, papel: 'admin' });
  try {
    const recusada = await (await ambiente.entrarComo('atendente')).access_token;
    const comoAtendente = await ambiente.pedirSemAuth('/api/tarefas/varrer', {
      ...POST({}), headers: { ...POST({}).headers, authorization: `Bearer ${recusada}` },
    });
    assert.equal(comoAtendente.status, 403, 'varrer é gestão de fila: atendente não dispara');

    const varrida = await ambiente.pedir('/api/tarefas/varrer', POST({}));
    assert.equal(varrida.status, 200);

    const lista = await (await ambiente.pedir('/api/tarefas')).json();
    assert.ok(Array.isArray(lista.tarefas));

    // Cria uma tarefa direto no repositório e conclui pela rota.
    const { tarefa } = await repositorio.criarTarefa({
      chave: 'manual:teste:1', tipo: 'manual', titulo: 'Ligar de volta',
    });
    const concluida = await ambiente.pedir(`/api/tarefas/${tarefa.id}/concluir`, POST({}));
    assert.equal(concluida.status, 200);

    const denovo = await ambiente.pedir(`/api/tarefas/${tarefa.id}/concluir`, POST({}));
    assert.equal(denovo.status, 404, 'concluir duas vezes não é sucesso silencioso');
  } finally {
    await ambiente.encerrar();
  }
});

test('formulário por HTTP: 409 sem confirmação, 200 depois de confirmar', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const { contato, conversa, lead } = await semearConversa(repositorio);
    const profissional = await repositorio.criarProfissional({ nome: 'Dra. Sintética' });
    const agendamento = await repositorio.criarAgendamento({
      profissionalId: profissional.id, contatoId: contato.id, leadId: lead.id, conversaId: conversa.id,
      inicio: '2026-08-12T14:00:00.000Z', fim: '2026-08-12T14:30:00.000Z',
    });

    const cedo = await ambiente.pedir(`/api/agenda/${agendamento.id}/formulario`, POST({}));
    assert.equal(cedo.status, 409);
    assert.equal((await cedo.json()).codigo, 'agendamento_nao_confirmado');

    await repositorio.atualizarAgendamento(agendamento.id, { status: 'confirmado' });

    const liberado = await ambiente.pedir(`/api/agenda/${agendamento.id}/formulario`, POST({}));
    assert.equal(liberado.status, 200);
    const corpo = await liberado.json();
    assert.equal(corpo.duplicado, false);
    assert.ok(corpo.formulario.token);
  } finally {
    await ambiente.encerrar();
  }
});

test('gestão do lead por HTTP: define dono e próximo passo; kanban devolve aging', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const { lead } = await semearConversa(repositorio);

    const resposta = await ambiente.pedir(`/api/leads/${lead.id}/gestao`, POST({
      proprietario_id: ambiente.sessao.usuario.id,
      proximo_passo: 'Oferecer horário de quinta às 14h',
    }));
    assert.equal(resposta.status, 200);
    const { lead: atualizado } = await resposta.json();
    assert.equal(atualizado.proximo_passo, 'Oferecer horário de quinta às 14h');

    const kanban = await (await ambiente.pedir('/api/leads')).json();
    const coluna = kanban.colunas.find((c) => c.total > 0);
    assert.ok(coluna, 'o lead aparece no kanban');
    assert.ok('dias_no_estagio' in coluna.leads[0], 'o card carrega o aging calculado no servidor');
    assert.ok('aging' in coluna.leads[0]);
  } finally {
    await ambiente.encerrar();
  }
});

test('mover estágio por HTTP sem gestão definida devolve 422 com o código que ensina', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const { lead } = await semearConversa(repositorio);

    const resposta = await ambiente.pedir(`/api/leads/${lead.id}/estagio`, POST({ estagio: 'qualificando', proximo_passo: '' }));
    // O usuário autenticado vira dono por padrão; o que falta é o próximo passo.
    assert.equal(resposta.status, 422);
    assert.equal((await resposta.json()).codigo, 'gestao_obrigatoria');

    const completa = await ambiente.pedir(`/api/leads/${lead.id}/estagio`, POST({
      estagio: 'qualificando', proximo_passo: 'Confirmar convênio e oferecer horário',
    }));
    assert.equal(completa.status, 200);
  } finally {
    await ambiente.encerrar();
  }
});
