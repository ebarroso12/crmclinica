'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeMetricas, percentil } = require('../src/dominio/metricas');
const { subirServidor } = require('./auxiliar');

// A camada analítica cumpre o dicionário oficial (docs/METRICAS.md): todo
// resumo carrega período, fuso, filtros e denominadores; dado sintético fica
// fora; mediana não inclui quem ainda espera resposta.

function ambiente(inicio = '2026-08-05T12:00:00.000Z') {
  const relogio = { momento: new Date(inicio) };
  const agora = () => new Date(relogio.momento);
  const repositorio = criarRepositorioEmMemoria({ agora });
  const metricas = criarServicoDeMetricas({ repositorio, agora });
  return { relogio, agora, repositorio, metricas };
}

async function semear(repositorio, { telefone, nome, texto = 'Olá, quero informações' }) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome, canal: 'whatsapp' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id, origem: 'WHATSAPP' });
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: texto, autor_tipo: 'contato', id_externo: `wa:m:${telefone}`,
  });
  return { contato, conversa, lead };
}

const PERIODO = { de: '2026-08-01', ate: '2026-08-08' };

test('percentil: mediana e p90 sem inventar número para lista vazia', () => {
  assert.equal(percentil([], 50), null);
  assert.equal(percentil([10], 50), 10);
  assert.equal(percentil([1, 2, 3, 4], 50), 2);
  assert.equal(percentil([1, 2, 3, 4, 100], 90), 100);
});

test('o resumo carrega período, fuso, filtros e denominadores — as convenções do dicionário', async () => {
  const { repositorio, metricas } = ambiente();
  await semear(repositorio, { telefone: '5511988880001', nome: 'Paciente A' });

  const resumo = await metricas.resumo(PERIODO);

  assert.equal(resumo.periodo.timezone, 'America/Sao_Paulo');
  assert.equal(resumo.periodo.de, '2026-08-01');
  assert.equal(resumo.periodo.intervalo, '[de, ate)');
  assert.match(resumo.filtros.dados_sinteticos, /excluidos/);

  assert.equal(resumo.leads.novos, 1);
  assert.equal(resumo.leads.por_origem[0].denominador, 1, 'taxa sem denominador não é publicável');
  assert.equal(resumo.agenda.comparecimento.denominador, 0);
  assert.equal(resumo.agenda.comparecimento.taxa, null, 'sem consultas, a taxa é nula — não 0%');
});

test('dado sintético (faixa 5516900000xx) fica fora de TODAS as agregações', async () => {
  const { repositorio, metricas } = ambiente();
  await semear(repositorio, { telefone: '5511988880002', nome: 'Paciente Real' });
  await semear(repositorio, { telefone: '5516900000099', nome: 'Ensaio Sintético' });

  const resumo = await metricas.resumo(PERIODO);

  assert.equal(resumo.leads.novos, 1, 'o lead sintético não conta');
  assert.equal(resumo.conversas.com_inbound, 1, 'a conversa sintética não conta');
});

test('mediana da primeira resposta só considera quem FOI respondido; o resto é backlog', async () => {
  const { relogio, repositorio, metricas } = ambiente();

  const a = await semear(repositorio, { telefone: '5511988880003', nome: 'Respondida' });
  relogio.momento = new Date(relogio.momento.getTime() + 10 * 60_000);
  await repositorio.registrarMensagem(a.conversa.id, {
    direcao: 'saida', conteudo: 'Bom dia! Podemos ajudar?', autor_tipo: 'equipe',
  });

  await semear(repositorio, { telefone: '5511988880004', nome: 'Esperando' });

  const resumo = await metricas.resumo(PERIODO);

  assert.equal(resumo.conversas.com_inbound, 2);
  assert.equal(resumo.conversas.respondidas, 1);
  assert.equal(resumo.conversas.sem_resposta_no_periodo, 1);
  assert.equal(resumo.conversas.primeira_resposta_minutos.mediana, 10);
  assert.equal(resumo.conversas.primeira_resposta_minutos.base, 1,
    'a base da mediana é declarada — quem espera não entra');
  assert.equal(resumo.conversas.backlog_aguardando, 1);
});

test('handoff e silêncio da Serena saem da trilha de auditoria', async () => {
  const { repositorio, metricas } = ambiente();
  const { conversa } = await semear(repositorio, { telefone: '5511988880005', nome: 'Com handoff' });

  await repositorio.registrarAuditoria({
    entidade: 'conversa', entidadeId: conversa.id, acao: 'assumida_por_humano', detalhe: {},
  });
  await repositorio.registrarAuditoria({
    entidade: 'conversa', entidadeId: conversa.id, acao: 'automacao_silenciada',
    detalhe: { motivo: 'serena_desligada' },
  });

  const resumo = await metricas.resumo(PERIODO);
  assert.equal(resumo.serena.handoffs, 1);
  assert.equal(resumo.serena.silencios, 1);
  assert.ok(resumo.serena.por_acao.some(
    (linha) => linha.acao === 'automacao_silenciada' && linha.motivo === 'serena_desligada',
  ));
});

test('período inválido é recusado com erro que aponta o campo', async () => {
  const { metricas } = ambiente();

  await assert.rejects(() => metricas.resumo({ de: '07/08/2026', ate: '2026-08-08' }), /YYYY-MM-DD/);
  await assert.rejects(() => metricas.resumo({ de: '2026-08-08', ate: '2026-08-01' }), /antes do fim/);
});

test('GET /api/metricas/resumo responde por HTTP com o resumo completo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambienteHttp = await subirServidor({ repositorio });
  try {
    await semear(repositorio, { telefone: '5511988880006', nome: 'Via HTTP' });

    const resposta = await ambienteHttp.pedir('/api/metricas/resumo');
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.periodo.timezone, 'America/Sao_Paulo');
    assert.ok(corpo.leads);
    assert.ok(corpo.conversas);
    assert.ok(corpo.agenda);
    assert.ok(corpo.serena);

    const semAuth = await ambienteHttp.pedirSemAuth('/api/metricas/resumo');
    assert.equal(semAuth.status, 401);
  } finally {
    await ambienteHttp.encerrar();
  }
});
