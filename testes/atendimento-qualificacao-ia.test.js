'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeLeads } = require('../src/dominio/leads-servico');
const { criarAtendimento } = require('../src/dominio/atendimento');

// Extrator de qualificação simulado: nenhuma rede, nenhuma credencial real.
function qualificacaoIaFalsa(campos = {}) {
  const chamadas = [];
  return {
    chamadas,
    async extrair(pedido) {
      chamadas.push(pedido);
      return campos;
    },
  };
}

function orquestradorFalso(resposta = { resposta: 'Claro, posso te ajudar com isso.' }) {
  return { disponivel: true, despacharEvento: async () => resposta };
}

async function montarComLead({ campos, resposta } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const servicoDeLeads = criarServicoDeLeads({ repositorio });
  const orquestrador = orquestradorFalso(resposta);
  const qualificacaoIa = qualificacaoIaFalsa(campos);
  const atendimento = criarAtendimento({
    repositorio, orquestrador, leads: servicoDeLeads, qualificacaoIa,
  });

  const resultado = await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:qualificacao-1',
    remetente: '5516999990000',
    nome: 'Marina Souza',
    texto: 'Oi, gostaria de saber sobre uma avaliação de rotina, particular',
  });

  const lead = await repositorio.obterLeadPorContato(
    (await repositorio.encontrarOuCriarContato({ telefone: '5516999990000' })).id,
  );

  return {
    repositorio, qualificacaoIa, resultado, lead,
  };
}

test('sem qualificacaoIa, o comportamento é idêntico ao de antes (lead fica sem interesse)', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const servicoDeLeads = criarServicoDeLeads({ repositorio });
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, leads: servicoDeLeads });

  await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:sem-extrator-1',
    remetente: '5516999990001',
    nome: 'Marina Souza',
    texto: 'Oi, gostaria de saber sobre uma avaliação de rotina',
  });

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990001' });
  const lead = await repositorio.obterLeadPorContato(contato.id);
  assert.equal(lead.interesse, null);
});

test('com qualificacaoIa, o que a IA extrai é gravado no lead', async () => {
  const { qualificacaoIa, lead } = await montarComLead({
    campos: { interesse: 'avaliação de rotina', pagamento: 'particular' },
  });

  assert.equal(lead.interesse, 'avaliação de rotina');
  assert.equal(lead.pagamento, 'particular');
  // A próxima pergunta já não é mais a primeira da lista — a conversa avançou.
  assert.equal(qualificacaoIa.chamadas.length, 1);
  assert.equal(qualificacaoIa.chamadas[0].qualificacaoAtual.id, lead.id);
});

test('extração roda com chave de idempotência derivada da mensagem de entrada', async () => {
  const { qualificacaoIa, lead } = await montarComLead({ campos: { pagamento: 'convenio' } });
  const [pedido] = qualificacaoIa.chamadas;
  assert.match(pedido.chaveIdempotencia, new RegExp(`^qualificacao:\\d+:\\d+$`));
  assert.equal(lead.pagamento, 'convenio');
});

test('quando a extração não devolve nada, o lead segue como estava', async () => {
  const { lead } = await montarComLead({ campos: {} });
  assert.equal(lead.interesse, null);
});

test('quando a extração falha, a resposta ao paciente segue normalmente', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const servicoDeLeads = criarServicoDeLeads({ repositorio });
  const orquestrador = orquestradorFalso({ resposta: 'Tudo bem, posso ajudar.' });
  const qualificacaoIa = { extrair: async () => { throw new Error('gateway indisponível'); } };
  const atendimento = criarAtendimento({
    repositorio, orquestrador, leads: servicoDeLeads, qualificacaoIa,
  });

  const resultado = await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:extracao-falha-1',
    remetente: '5516999990002',
    nome: 'Marina Souza',
    texto: 'Oi, gostaria de agendar',
  });

  assert.equal(resultado.acao, 'respondida_pela_automacao');
});

test('qualificação já completa não aciona a extração de novo', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const servicoDeLeads = criarServicoDeLeads({ repositorio });
  const orquestrador = orquestradorFalso();
  let chamou = false;
  const qualificacaoIa = { extrair: async () => { chamou = true; return {}; } };
  const atendimento = criarAtendimento({
    repositorio, orquestrador, leads: servicoDeLeads, qualificacaoIa,
  });

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990003' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id });
  await servicoDeLeads.qualificar(lead.id, {
    interesse: 'avaliação', primeira_consulta: true, pagamento: 'particular',
    urgencia: 'imediata', disponibilidade: 'tarde',
  }, { conversaId: conversa.id });

  await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:completa-1',
    remetente: '5516999990003',
    nome: 'Marina Souza',
    texto: 'Combinado, até lá!',
  });

  assert.equal(chamou, false);
});
