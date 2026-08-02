'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ETAPAS, transicaoPermitida, estagioSugerido, resumir, ErroDeJornada } = require('../src/dominio/jornada');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const leads = criarServicoDeLeads({ repositorio });

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id });

  return { repositorio, leads, contato, conversa, lead };
}

// ---------------------------------------------------------------- transições

test('as cinco etapas estão declaradas', () => {
  assert.deepEqual(ETAPAS, ['novo', 'qualificando', 'agendado', 'convertido', 'perdido']);
});

test('o caminho normal da jornada é permitido', () => {
  assert.equal(transicaoPermitida('novo', 'qualificando'), true);
  assert.equal(transicaoPermitida('qualificando', 'agendado'), true);
  assert.equal(transicaoPermitida('agendado', 'convertido'), true);
});

test('salto de novo direto para convertido é recusado', () => {
  // Quase sempre é erro de clique, não milagre.
  assert.equal(transicaoPermitida('novo', 'convertido'), false);
  assert.equal(transicaoPermitida('qualificando', 'convertido'), false);
});

test('desmarcar volta para qualificando; retorno reabre a jornada', () => {
  assert.equal(transicaoPermitida('agendado', 'qualificando'), true);
  assert.equal(transicaoPermitida('convertido', 'qualificando'), true, 'retorno é lead novo da mesma pessoa');
  assert.equal(transicaoPermitida('perdido', 'qualificando'), true, 'quem some pode voltar');
});

test('mover para a mesma etapa e para etapa inexistente é recusado', () => {
  assert.equal(transicaoPermitida('novo', 'novo'), false);
  assert.equal(transicaoPermitida('novo', 'inventada'), false);
});

test('estagioSugerido só empurra para frente', () => {
  assert.equal(estagioSugerido({ estagio: 'novo' }, [1, 2, 3, 4, 5]), 'novo');
  assert.equal(estagioSugerido({ estagio: 'novo' }, [1, 2, 3]), 'qualificando');

  // Já agendado ou convertido não é puxado para trás por um cálculo.
  assert.equal(estagioSugerido({ estagio: 'agendado' }, [1, 2, 3, 4, 5]), 'agendado');
  assert.equal(estagioSugerido({ estagio: 'convertido' }, [1, 2, 3, 4, 5]), 'convertido');
  assert.equal(estagioSugerido({ estagio: 'perdido' }, []), 'perdido');
});

// ---------------------------------------------------------------- serviço

test('qualificar grava, deixa evento na jornada e audita', async () => {
  const { repositorio, leads, lead, conversa } = await montar();

  const resultado = await leads.qualificar(lead.id, {
    interesse: 'preenchimento facial', urgencia: 'imediata',
  }, { conversaId: conversa.id, origem: 'automacao' });

  assert.deepEqual(resultado.alterados.sort(), ['interesse', 'urgencia']);
  assert.equal(resultado.lead.interesse, 'preenchimento facial');

  const eventos = await repositorio.listarEventosDoLead(lead.id);
  assert.ok(eventos.some((evento) => evento.tipo === 'qualificacao'));
  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'lead_qualificado'));
});

test('qualificar avança o estágio de novo para qualificando', async () => {
  const { repositorio, leads, lead } = await montar();
  assert.equal(lead.estagio, 'novo');

  const resultado = await leads.qualificar(lead.id, { interesse: 'botox' });
  assert.equal(resultado.lead.estagio, 'qualificando');

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'estagio' });
  assert.equal(eventos[0].de, 'novo');
  assert.equal(eventos[0].para, 'qualificando');
});

test('regravar o mesmo valor não polui a jornada', async () => {
  const { repositorio, leads, lead } = await montar();

  await leads.qualificar(lead.id, { interesse: 'botox' });
  const antes = (await repositorio.listarEventosDoLead(lead.id)).length;

  const repetido = await leads.qualificar(lead.id, { interesse: 'botox' });
  assert.deepEqual(repetido.alterados, []);
  assert.equal((await repositorio.listarEventosDoLead(lead.id)).length, antes);
});

test('a qualificação é gradual: uma resposta por vez', async () => {
  const { leads, lead } = await montar();

  let atual = await leads.qualificar(lead.id, { interesse: 'avaliação' });
  assert.equal(atual.proxima.campo, 'primeira_consulta');
  assert.equal(atual.pendentes.length, 4);

  atual = await leads.qualificar(lead.id, { primeira_consulta: true });
  assert.equal(atual.proxima.campo, 'urgencia');

  atual = await leads.qualificar(lead.id, { urgencia: 'imediata' });
  atual = await leads.qualificar(lead.id, { pagamento: 'particular' });
  atual = await leads.qualificar(lead.id, { disponibilidade: 'manha' });

  assert.equal(atual.proxima, null);
  assert.deepEqual(atual.pendentes, []);
  assert.ok(atual.lead.qualificado_em, 'o momento da qualificação completa fica registrado');
});

test('o score sobe conforme a qualificação avança', async () => {
  const { leads, lead } = await montar();

  const inicial = (await leads.descrever(lead.id)).score;
  await leads.qualificar(lead.id, { interesse: 'botox', urgencia: 'imediata' });
  const depois = (await leads.descrever(lead.id)).score;

  assert.ok(depois > inicial, `score deveria subir: ${inicial} → ${depois}`);
});

test('a temperatura acompanha o score e deixa evento', async () => {
  const { repositorio, leads, lead } = await montar();

  await leads.qualificar(lead.id, {
    interesse: 'botox', primeira_consulta: true, urgencia: 'imediata',
    pagamento: 'particular', disponibilidade: 'manha',
  });

  const atual = await repositorio.obterLead(lead.id);
  assert.equal(atual.temperatura, 'quente');

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'temperatura' });
  assert.ok(eventos.length > 0, 'mudança de temperatura precisa deixar rastro');
});

test('temperatura fixada na mão não é sobrescrita pelo cálculo', async () => {
  const { repositorio, leads, lead, conversa } = await montar();

  await leads.definirTemperaturaManual(lead.id, 'frio', { conversaId: conversa.id, usuarioId: null });

  // Qualificação completa que daria "quente" não desfaz a decisão da equipe.
  await leads.qualificar(lead.id, {
    interesse: 'botox', primeira_consulta: true, urgencia: 'imediata',
    pagamento: 'particular', disponibilidade: 'manha',
  });

  const atual = await repositorio.obterLead(lead.id);
  assert.equal(atual.temperatura, 'frio');
  assert.equal(atual.temperatura_manual, true);
});

test('a temperatura manual sincroniza a etiqueta da conversa', async () => {
  const { repositorio, leads, lead, conversa } = await montar();

  await repositorio.definirEtiquetasDaConversa(conversa.id, ['pagou_sinal', 'avaliacao']);
  await leads.definirTemperaturaManual(lead.id, 'quente', { conversaId: conversa.id });

  const etiquetas = await repositorio.listarEtiquetasDaConversa(conversa.id);
  assert.ok(etiquetas.includes('lead_quente'), 'a lista e o kanban não podem discordar');
  assert.ok(etiquetas.includes('pagou_sinal'), 'as etiquetas da equipe ficam onde estão');
  assert.ok(etiquetas.includes('avaliacao'));
});

test('mover de etapa registra de-para e audita', async () => {
  const { repositorio, leads, lead } = await montar();

  await leads.moverEstagio(lead.id, 'qualificando', { origem: 'equipe', usuarioId: null });
  const resultado = await leads.moverEstagio(lead.id, 'agendado', { origem: 'equipe' });

  assert.equal(resultado.de, 'qualificando');
  assert.equal(resultado.para, 'agendado');

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'estagio' });
  assert.equal(eventos[0].para, 'agendado');
  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'lead_estagio_alterado'));
});

test('salto inválido é recusado com as opções possíveis', async () => {
  const { leads, lead } = await montar();

  await assert.rejects(
    () => leads.moverEstagio(lead.id, 'convertido'),
    (erro) => {
      assert.ok(erro instanceof ErroDeJornada);
      assert.equal(erro.status, 409);
      assert.deepEqual(erro.permitidas, ['qualificando', 'agendado', 'perdido']);
      return true;
    },
  );
});

test('perder o lead guarda o motivo', async () => {
  const { repositorio, leads, lead } = await montar();

  await leads.moverEstagio(lead.id, 'perdido', { motivo: 'foi para outra clínica' });

  const atual = await repositorio.obterLead(lead.id);
  assert.equal(atual.perdido_motivo, 'foi para outra clínica');
});

test('o primeiro contato é registrado uma vez só', async () => {
  const { repositorio, leads, lead, conversa } = await montar();

  await leads.registrarPrimeiroContato(lead.id, { conversaId: conversa.id, canal: 'whatsapp' });
  await leads.registrarPrimeiroContato(lead.id, { conversaId: conversa.id, canal: 'whatsapp' });

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'primeiro_contato' });
  assert.equal(eventos.length, 1);
});

test('descrever traz score explicado, próxima ação e jornada', async () => {
  const { leads, lead } = await montar();

  await leads.qualificar(lead.id, { interesse: 'botox', urgencia: 'imediata' });
  const retrato = await leads.descrever(lead.id);

  assert.ok(retrato.score > 0);
  assert.ok(retrato.score_motivos.length > 0, 'o número precisa se explicar');
  assert.match(retrato.proxima_acao, /Perguntar/);
  assert.equal(retrato.proxima_pergunta.campo, 'primeira_consulta');
  assert.ok(retrato.jornada.length > 0);
});

test('a origem do evento distingue equipe de automação', async () => {
  const { repositorio, leads, lead } = await montar();

  await leads.qualificar(lead.id, { interesse: 'botox' }, { origem: 'automacao' });
  await leads.qualificar(lead.id, { pagamento: 'particular' }, { origem: 'equipe', usuarioId: 7 });

  const eventos = await repositorio.listarEventosDoLead(lead.id, { tipo: 'qualificacao' });
  const origens = eventos.map((evento) => evento.origem);

  assert.ok(origens.includes('automacao'));
  assert.ok(origens.includes('equipe'));
});

// ---------------------------------------------------------------- resumo

test('o resumo da jornada mostra início, fim e duração', () => {
  const resumo = resumir([
    { tipo: 'estagio', para: 'novo', criado_em: '2026-08-01T10:00:00.000Z' },
    { tipo: 'qualificacao', criado_em: '2026-08-01T11:00:00.000Z' },
    { tipo: 'estagio', para: 'agendado', criado_em: '2026-08-01T16:00:00.000Z' },
  ]);

  assert.equal(resumo.etapas, 2);
  assert.equal(resumo.primeiro.para, 'novo');
  assert.equal(resumo.ultimo.para, 'agendado');
  assert.equal(resumo.duracaoHoras, 6);
});

test('jornada sem mudança de etapa resume sem quebrar', () => {
  assert.deepEqual(resumir([]), { etapas: 0, primeiro: null, ultimo: null, duracaoHoras: null });
});
