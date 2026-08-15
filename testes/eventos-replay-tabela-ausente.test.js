'use strict';

// BLOQUEADOR 2 aplicado ao replay do chat ao vivo (http.js, GET
// /api/conversas/eventos): o mesmo cenário de `conversas_eventos` ausente
// (rollback da 037 sem rollback de código, ou deploy antes da migration)
// pode acontecer bem no replay que roda logo depois de abrir a conexão SSE.
// Hoje aquele trecho tem um try/catch LARGO que engolia qualquer erro e
// seguia para `inscrever` do mesmo jeito — o que também é o ponto de risco
// do BLOQUEADOR 1 (uma falha de autorização cairia no mesmo lugar). A
// correção precisa: (a) só degradar (replay vazio, mas segue ao vivo) para
// 42P01; (b) qualquer outro erro (permissão, conexão, autorização) encerra
// a conexão em vez de assinar sem confirmar o que ela pode ver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');
const { criarAtendimento } = require('../src/dominio/atendimento');

function erroPg(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { code: codigo });
}

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  return {
    disponivel: true,
    despacharEvento: async () => resposta,
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

async function montar({ falhaNoReplay = null } = {}) {
  const base = criarRepositorioEmMemoria();
  const repositorio = {
    ...base,
    async listarEventosDeConversasDesde(args) {
      if (falhaNoReplay) throw falhaNoReplay;
      return base.listarEventosDeConversasDesde(args);
    },
  };
  const orquestrador = orquestradorFalso();
  const emissorDeConversas = criarEmissorDeConversas({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, emissor: emissorDeConversas });
  const app = await subirServidor({
    repositorio, atendimento, orquestrador, emissorDeConversas, configuracao: configuracaoDeTeste(),
  });
  return { app, repositorio, atendimento, emissorDeConversas };
}

async function pedirTicket(app) {
  const resposta = await app.pedir('/api/conversas/eventos/ticket', { method: 'POST' });
  assert.equal(resposta.status, 200);
  return (await resposta.json()).ticket;
}

test('42P01 no replay: a conexão SSE abre e segue ao vivo, só sem o histórico', async (t) => {
  const { app, atendimento } = await montar({
    falhaNoReplay: erroPg('42P01', 'relation "conversas_eventos" does not exist'),
  });
  t.after(() => app.encerrar());

  const ticket = await pedirTicket(app);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(`/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`, { signal: controle.signal });
  assert.equal(resposta.status, 200, 'a conexão precisa abrir mesmo com o replay indisponível');

  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let buffer = '';
  const prazo = Date.now() + 2000;
  while (!buffer.includes('conectado')) {
    if (Date.now() > prazo) throw new Error('nunca recebeu "conectado"');
    const { value, done } = await leitor.read();
    if (done) throw new Error('conexão encerrada antes do esperado — deveria seguir aberta mesmo com 42P01 no replay');
    buffer += decodificador.decode(value, { stream: true });
  }

  // Ainda VIVA: um evento novo publicado depois precisa chegar normalmente.
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:replay-fallback:1',
    remetente: '5516900000301', nome: 'Paciente', texto: 'oi',
  });
  const prazo2 = Date.now() + 2000;
  while (!buffer.includes('"tipo":"mensagem_recebida"')) {
    if (Date.now() > prazo2) throw new Error('evento ao vivo não chegou depois da falha no replay');
    const { value, done } = await leitor.read();
    if (done) throw new Error('conexão caiu antes do evento ao vivo chegar');
    buffer += decodificador.decode(value, { stream: true });
  }

  controle.abort();
  await leitor.cancel().catch(() => {});
});

test('erro que NÃO é 42P01 no replay: a conexão é encerrada, nunca fica "assinada" sem confirmar escopo', async (t) => {
  const { app } = await montar({
    falhaNoReplay: erroPg('42501', 'permission denied for table conversas_eventos'),
  });
  t.after(() => app.encerrar());

  const ticket = await pedirTicket(app);
  const resposta = await app.pedirSemAuth(`/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`);
  // Os headers SSE (200) já saíram antes do replay rodar — não é possível
  // voltar um 403/500 depois disso. A garantia possível é: o corpo se
  // encerra (done:true) em vez de ficar aberto e "assinado" sem confirmação.
  assert.equal(resposta.status, 200);

  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let encerrou = false;
  const prazo = Date.now() + 2000;
  while (Date.now() < prazo) {
    // `leitor.read()` só resolve quando algo chega OU a conexão fecha — sem
    // corrida contra um relógio, um servidor que (por bug) mantém a conexão
    // aberta sem nunca mandar nada faria este teste travar em vez de falhar.
    const corrida = await Promise.race([
      leitor.read().then((r) => ({ tipo: 'leitura', r })),
      new Promise((resolve) => setTimeout(() => resolve({ tipo: 'tempo' }), 200)),
    ]);
    if (corrida.tipo === 'tempo') continue;
    if (corrida.r.done) { encerrou = true; break; }
    decodificador.decode(corrida.r.value, { stream: true });
  }
  if (!encerrou) await leitor.cancel().catch(() => {});
  assert.ok(encerrou, 'a conexão precisa se encerrar sozinha quando o replay falha por um motivo que não é "tabela ausente"');
});
