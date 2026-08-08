'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeFluxo, montarResumoInterno, chaveDeAcompanhamento } = require('../src/dominio/crm-fluxo');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');
const { agingDoLead } = require('../src/dominio/leads');

// Provas do fluxo comercial:
//
//   • o sino de 15 dias é idempotente — rodar o worker mil vezes cria UMA tarefa;
//   • o resumo interno nasce ao encerrar e NUNCA passa pelo canal;
//   • o formulário de pré-consulta só sai com agendamento CONFIRMADO;
//   • mover lead pela equipe exige dono e próximo passo; perder exige motivo.
//
// Tudo com dados sintéticos e relógio controlado.

const DIA = 24 * 3_600_000;

function ambienteComRelogio(inicio = '2026-08-01T12:00:00.000Z') {
  const relogio = { momento: new Date(inicio) };
  const agora = () => new Date(relogio.momento);
  const repositorio = criarRepositorioEmMemoria({ agora });
  return { relogio, agora, repositorio };
}

async function criarLeadSintetico(repositorio, { telefone = '5516900000010', nome = 'Lead Sintético' } = {}) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome, canal: 'whatsapp' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id, origem: 'WHATSAPP' });
  return { contato, conversa, lead };
}

// ---------------------------------------------------------------- sino 15 dias

test('lead parado há 15 dias gera UMA tarefa, por mais vezes que o worker rode', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  await criarLeadSintetico(repositorio);

  relogio.momento = new Date(relogio.momento.getTime() + 16 * DIA);

  const primeira = await fluxo.gerarTarefasDeAcompanhamento();
  assert.equal(primeira.criadas, 1);

  // O worker roda de minuto em minuto. Simula três ciclos seguidos.
  for (let ciclo = 0; ciclo < 3; ciclo += 1) {
    const repetida = await fluxo.gerarTarefasDeAcompanhamento();
    assert.equal(repetida.criadas, 0, 'a mesma inatividade não pode virar segunda tarefa');
  }

  const tarefas = await repositorio.listarTarefas({ abertas: true });
  assert.equal(tarefas.length, 1);
  assert.equal(tarefas[0].tipo, 'acompanhamento_15d');
});

test('lead com atividade recente não gera tarefa', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  await criarLeadSintetico(repositorio);

  relogio.momento = new Date(relogio.momento.getTime() + 5 * DIA);

  const resultado = await fluxo.gerarTarefasDeAcompanhamento();
  assert.equal(resultado.criadas, 0);
});

test('atividade nova muda a âncora: um novo ciclo de silêncio permite um novo sino', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  const { conversa, lead } = await criarLeadSintetico(repositorio);

  relogio.momento = new Date(relogio.momento.getTime() + 16 * DIA);
  await fluxo.gerarTarefasDeAcompanhamento();

  const chaveAntes = chaveDeAcompanhamento(await repositorio.obterLead(lead.id));

  // O paciente volta a falar; depois, mais 16 dias de silêncio.
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Oi, ainda tenho interesse', autor_tipo: 'contato', id_externo: 'wa:volta:1',
  });
  relogio.momento = new Date(relogio.momento.getTime() + 16 * DIA);

  const segunda = await fluxo.gerarTarefasDeAcompanhamento();
  assert.equal(segunda.criadas, 1, 'novo ciclo de silêncio, novo sino');

  const chaveDepois = chaveDeAcompanhamento(await repositorio.obterLead(lead.id));
  assert.notEqual(chaveAntes, chaveDepois, 'a âncora acompanha a última atividade');
});

test('convertido e perdido não recebem sino de acompanhamento', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  const { lead } = await criarLeadSintetico(repositorio);

  await repositorio.atualizarLead(lead.id, { estagio: 'perdido' });
  relogio.momento = new Date(relogio.momento.getTime() + 30 * DIA);

  const resultado = await fluxo.gerarTarefasDeAcompanhamento();
  assert.equal(resultado.criadas, 0, 'quem saiu do funil não é cobrado');
});

// ------------------------------------------------------------ resumo interno

test('encerrar gera resumo interno com os cinco campos e resolve a conversa', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  const { conversa } = await criarLeadSintetico(repositorio);

  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Quero avaliar um implante dentário', autor_tipo: 'contato', id_externo: 'wa:r:1',
  });

  const resultado = await fluxo.encerrarConversa(conversa.id, { usuarioId: 7 });

  assert.match(resultado.resumo, /Nome: Lead Sintético/);
  assert.match(resultado.resumo, /Telefone: 5516900000010/);
  assert.match(resultado.resumo, /Síntese: Quero avaliar um implante dentário/);
  assert.match(resultado.resumo, /Agendou: NÃO/);
  assert.match(resultado.resumo, /Pendência:/);

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.status, 'resolvida');
  assert.equal(depois.resumo_interno, resultado.resumo);
});

test('o resumo interno NUNCA passa pelo canal — encerrar não envia nada ao paciente', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const envios = [];
  const canal = { enviar: async (envelope) => { envios.push(envelope); return {}; } };
  const fluxo = criarServicoDeFluxo({ repositorio, canal, agora });
  const { conversa } = await criarLeadSintetico(repositorio);

  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Qual o valor da consulta?', autor_tipo: 'contato', id_externo: 'wa:r:2',
  });

  await fluxo.encerrarConversa(conversa.id);

  assert.equal(envios.length, 0, 'o resumo é da equipe; o paciente não recebe nada no encerramento');

  // E a mensagem gravada com o resumo é privada: fora do contexto da IA.
  const mensagens = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: true });
  const doResumo = mensagens.find((mensagem) => /Resumo interno/.test(mensagem.conteudo ?? ''));
  assert.equal(doResumo.privada, true);

  const visiveis = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: false });
  assert.ok(!visiveis.some((mensagem) => /Resumo interno/.test(mensagem.conteudo ?? '')));
});

test('resumo com agendamento confirma o SIM e a data', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const { contato, conversa, lead } = await criarLeadSintetico(repositorio);
  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Sintético' });
  await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id, leadId: lead.id, conversaId: conversa.id,
    inicio: '2026-08-10T14:00:00.000Z', fim: '2026-08-10T14:30:00.000Z',
  });

  const mensagens = await repositorio.listarMensagens(conversa.id);
  const agendamento = await repositorio.obterAgendamento(1);
  const resumo = montarResumoInterno({ contato, mensagens, agendamento, lead, agora: agora() });

  assert.match(resumo, /Agendou: SIM/);
});

// ---------------------------------------------- formulário de pré-consulta

test('formulário é RECUSADO enquanto o agendamento não está confirmado', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const fluxo = criarServicoDeFluxo({ repositorio, agora });
  const { contato, conversa, lead } = await criarLeadSintetico(repositorio);
  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Sintético' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id, leadId: lead.id, conversaId: conversa.id,
    inicio: '2026-08-10T14:00:00.000Z', fim: '2026-08-10T14:30:00.000Z',
  });

  // Nasce 'agendado' — ainda sem o aceite explícito.
  await assert.rejects(
    () => fluxo.enviarFormularioPreConsulta(agendamento.id),
    (erro) => {
      assert.equal(erro.codigo, 'agendamento_nao_confirmado');
      assert.equal(erro.status, 409);
      return true;
    },
  );

  assert.equal(await repositorio.obterFormularioPorAgendamento(agendamento.id), null,
    'a recusa não deixa formulário pela metade');
});

test('agendamento confirmado libera o formulário — e um por agendamento, sempre', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const envios = [];
  const canal = { enviar: async (envelope) => { envios.push(envelope); return {}; } };
  const fluxo = criarServicoDeFluxo({ repositorio, canal, agora });
  const { contato, conversa, lead } = await criarLeadSintetico(repositorio);
  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Sintético' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id, leadId: lead.id, conversaId: conversa.id,
    inicio: '2026-08-10T14:00:00.000Z', fim: '2026-08-10T14:30:00.000Z',
  });
  await repositorio.atualizarAgendamento(agendamento.id, { status: 'confirmado' });

  const primeiro = await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });
  assert.equal(primeiro.duplicado, false);
  assert.equal(primeiro.entrega.enviada, true);

  const segundo = await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });
  assert.equal(segundo.duplicado, true, 'reenviar reaproveita, não recria');
  assert.equal(segundo.formulario.id, primeiro.formulario.id);

  // As duas entregas usam a MESMA chave: o gateway deduplica.
  assert.equal(new Set(envios.map((envio) => envio.chave)).size, 1);
});

// ------------------------------------------------- dono e próximo passo

test('mover lead pela equipe sem dono e sem próximo passo é recusado com erro que ensina', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const leads = criarServicoDeLeads({ repositorio, agora });
  const { lead } = await criarLeadSintetico(repositorio);

  await assert.rejects(
    () => leads.moverEstagio(lead.id, 'qualificando', { origem: 'equipe' }),
    (erro) => {
      assert.equal(erro.codigo, 'gestao_obrigatoria');
      assert.equal(erro.status, 422);
      assert.match(erro.message, /proprietário/);
      return true;
    },
  );
});

test('mover com dono e próximo passo funciona e zera o relógio do aging', async () => {
  const { relogio, agora, repositorio } = ambienteComRelogio();
  const leads = criarServicoDeLeads({ repositorio, agora });
  const { lead } = await criarLeadSintetico(repositorio);

  relogio.momento = new Date(relogio.momento.getTime() + 10 * DIA);

  const resultado = await leads.moverEstagio(lead.id, 'qualificando', {
    origem: 'equipe', usuarioId: 5, proximoPasso: 'Ligar para oferecer horário de quinta',
  });

  assert.equal(resultado.lead.estagio, 'qualificando');
  assert.equal(resultado.lead.proprietario_id, 5);
  assert.equal(resultado.lead.proximo_passo, 'Ligar para oferecer horário de quinta');

  const { dias_no_estagio } = agingDoLead(resultado.lead, relogio.momento.getTime());
  assert.equal(dias_no_estagio, 0, 'mudou de coluna agora: o aging recomeça');
});

test('a automação continua livre para avançar novo → qualificando sem dono', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const leads = criarServicoDeLeads({ repositorio, agora });
  const { lead } = await criarLeadSintetico(repositorio);

  const resultado = await leads.moverEstagio(lead.id, 'qualificando', { origem: 'automacao' });
  assert.equal(resultado.lead.estagio, 'qualificando');
});

test('perder sem motivo é recusado; com motivo, o motivo fica no lead', async () => {
  const { agora, repositorio } = ambienteComRelogio();
  const leads = criarServicoDeLeads({ repositorio, agora });
  const { lead } = await criarLeadSintetico(repositorio);

  await assert.rejects(
    () => leads.moverEstagio(lead.id, 'perdido', { origem: 'equipe' }),
    (erro) => erro.codigo === 'motivo_obrigatorio',
  );

  const resultado = await leads.moverEstagio(lead.id, 'perdido', {
    origem: 'equipe', motivo: 'optou por outra clínica',
  });
  assert.equal(resultado.lead.perdido_motivo, 'optou por outra clínica');
});

// ---------------------------------------------------------------- aging

test('aging classifica por faixas e não inventa zero para lead sem estagio_desde', () => {
  const agora = new Date('2026-08-20T12:00:00.000Z').getTime();

  assert.deepEqual(
    agingDoLead({ estagio_desde: '2026-08-19T12:00:00.000Z' }, agora),
    { dias_no_estagio: 1, aging: 'recente' },
  );
  assert.deepEqual(
    agingDoLead({ estagio_desde: '2026-08-14T12:00:00.000Z' }, agora),
    { dias_no_estagio: 6, aging: 'atencao' },
  );
  assert.deepEqual(
    agingDoLead({ estagio_desde: '2026-08-08T12:00:00.000Z' }, agora),
    { dias_no_estagio: 12, aging: 'esfriando' },
  );
  assert.deepEqual(
    agingDoLead({ estagio_desde: '2026-07-01T12:00:00.000Z' }, agora),
    { dias_no_estagio: 50, aging: 'abandonado' },
  );
  assert.deepEqual(agingDoLead({}, agora), { dias_no_estagio: null, aging: null });
});

// ---------------------------------------------------------------- SLA

test('inbound abre a espera de SLA; resposta da equipe encerra; nota privada não mexe', async () => {
  const { repositorio } = ambienteComRelogio();
  const { conversa } = await criarLeadSintetico(repositorio);

  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Olá!', autor_tipo: 'contato', id_externo: 'wa:sla:1',
  });
  let atual = await repositorio.obterConversa(conversa.id);
  assert.ok(atual.aguardando_resposta_desde, 'paciente falou: a espera abre');
  const inicioDaEspera = atual.aguardando_resposta_desde;

  // Segunda mensagem do paciente NÃO reinicia a espera: a fila mede desde a primeira.
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Alguém aí?', autor_tipo: 'contato', id_externo: 'wa:sla:2',
  });
  atual = await repositorio.obterConversa(conversa.id);
  assert.equal(atual.aguardando_resposta_desde, inicioDaEspera);

  // Nota privada não é resposta.
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida', conteudo: 'nota interna', autor_tipo: 'sistema', privada: true,
  });
  atual = await repositorio.obterConversa(conversa.id);
  assert.equal(atual.aguardando_resposta_desde, inicioDaEspera, 'nota privada não encerra a espera');

  // Resposta de verdade encerra.
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida', conteudo: 'Bom dia! Podemos ajudar?', autor_tipo: 'equipe',
  });
  atual = await repositorio.obterConversa(conversa.id);
  assert.equal(atual.aguardando_resposta_desde, null, 'respondeu: ninguém mais espera');
});

test('a fila de SLA lista da espera mais antiga para a mais nova', async () => {
  const { relogio, repositorio } = ambienteComRelogio();

  const a = await criarLeadSintetico(repositorio, { telefone: '5516900000021', nome: 'Espera Antiga' });
  await repositorio.registrarMensagem(a.conversa.id, {
    direcao: 'entrada', conteudo: 'primeiro', autor_tipo: 'contato', id_externo: 'wa:f:1',
  });

  relogio.momento = new Date(relogio.momento.getTime() + 3_600_000);

  const b = await criarLeadSintetico(repositorio, { telefone: '5516900000022', nome: 'Espera Nova' });
  await repositorio.registrarMensagem(b.conversa.id, {
    direcao: 'entrada', conteudo: 'segundo', autor_tipo: 'contato', id_externo: 'wa:f:2',
  });

  const fila = await repositorio.listarConversasAguardando({});
  assert.equal(fila.length, 2);
  assert.equal(fila[0].contato_nome, 'Espera Antiga');
  assert.equal(fila[1].contato_nome, 'Espera Nova');
});
