'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// A porta da Serena, do jeito que ela usa.
//
// Esta suíte nasce de uma auditoria: 34 consultas foram marcadas por aqui e
// nenhum lead saiu do lugar no kanban. A rota avançava o lead para uma etapa
// que não existe ('agendamento', o ato, em vez de 'agendado', a coluna), e o
// catch engolia a recusa da jornada. Nenhum teste cobria a porta do agente —
// era a única porta do servidor sem suíte própria.
//
// O teste que mais importa aqui é o do circuito completo: consultar um horário
// devolvido pela própria API, marcar com ele, e então exigir que a consulta
// exista E que o card tenha se movido. Marcar sem mover é exatamente o defeito
// que passou despercebido.

const TOKEN = 'token-do-agente-para-teste';

function orquestradorFalso() {
  return {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
}

async function subirAgente() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Edson', duracaoMin: 30 });
  // Todos os dias, para o teste não depender do dia em que roda — a carência
  // mínima da clínica é quem decide quais horários aparecem.
  await repositorio.definirDisponibilidades(profissional.id, [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
    dia_semana: dia, hora_inicio: '08:00', hora_fim: '18:00',
  })));

  const app = await subirServidor({
    repositorio,
    atendimento,
    orquestrador,
    autenticar: false,
    configuracao: configuracaoDeTeste({
      CRMCLINICA_AGENTE_TOKEN: TOKEN,
      CRMCLINICA_AGENTE_PODE_AGENDAR: 'true',
    }),
  });

  const agir = (corpo, token = TOKEN) => app.pedirSemAuth('/api/agente/acao', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agente-token': token },
    body: JSON.stringify(corpo),
  });

  return { app, repositorio, profissional, agir };
}

test('sem token válido, a porta não abre', async (t) => {
  const { app, agir } = await subirAgente();
  t.after(() => app.encerrar());

  const resposta = await agir({ acao: 'consultar_horarios' }, 'token-errado');
  assert.equal(resposta.status, 401);
});

test('consultar_horarios devolve horários com o texto pronto para o paciente', async (t) => {
  const { app, agir } = await subirAgente();
  t.after(() => app.encerrar());

  const resposta = await agir({ acao: 'consultar_horarios', dias: 14 });
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.ok(corpo.horarios.length > 0, 'a agenda aberta a semana toda precisa ter vaga');
  // O "quando" formatado é o que impede o modelo de converter ISO errado.
  assert.match(corpo.horarios[0].quando, /\d{2}\/\d{2}/);
});

test('agendar marca a consulta E move o lead para a coluna Agendados', async (t) => {
  const { app, repositorio, agir } = await subirAgente();
  t.after(() => app.encerrar());

  const oferta = await (await agir({ acao: 'consultar_horarios', dias: 14 })).json();
  const horario = oferta.horarios[0];

  const resposta = await agir({
    acao: 'agendar',
    telefone: '5516900001111',
    nome: 'Paciente de Ensaio',
    inicio: horario.inicio,
    fim: horario.fim,
  });
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.equal(corpo.confirmado, true);
  assert.ok(corpo.agendamento_id, 'a consulta precisa existir');

  // A metade que faltava: a consulta existia e o card não saía de "novo".
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900001111', canal: 'whatsapp' });
  const lead = await repositorio.obterLeadPorContato(contato.id);
  assert.equal(lead.estagio, 'agendado', 'quem marcou consulta não está mais pesquisando');
});

test('agendar de novo não derruba o lead que já está em Agendados', async (t) => {
  const { app, repositorio, agir } = await subirAgente();
  t.after(() => app.encerrar());

  const oferta = await (await agir({ acao: 'consultar_horarios', dias: 14 })).json();
  const [primeiro, segundo] = oferta.horarios;
  assert.ok(segundo, 'o teste precisa de dois horários livres');

  for (const horario of [primeiro, segundo]) {
    const resposta = await agir({
      acao: 'agendar',
      telefone: '5516900002222',
      inicio: horario.inicio,
      fim: horario.fim,
    });
    assert.equal(resposta.status, 200);
  }

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900002222', canal: 'whatsapp' });
  const lead = await repositorio.obterLeadPorContato(contato.id);
  // 'agendado' → 'agendado' é recusado pela jornada; a segunda consulta não
  // pode desfazer o que a primeira fez, nem falhar por causa do card.
  assert.equal(lead.estagio, 'agendado');
});
