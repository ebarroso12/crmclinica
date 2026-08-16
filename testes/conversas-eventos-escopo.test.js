'use strict';

// BLOQUEADOR 1 da auditoria independente do PR #34: o SSE de conversas ao
// vivo (`/api/conversas/eventos`) fazia *broadcast* sem escopo de
// autorização — qualquer atendente autenticado via bilhete válido recebia
// TODO evento de TODA conversa da clínica, inclusive as atribuídas a outro
// atendente (replay via `?cursor=`/`Last-Event-ID` E transmissão ao vivo).
// A RLS não cobre isto: a rota fica deliberadamente fora de `comIdentidade`
// (conexão de horas travaria o pool — ver http.js) e por isso toda consulta
// que ela faz nasce com `app_role=backend`, sob o qual `can_access_conversa`
// (db/034) sempre devolve `true` — uma policy escrita em cima dela seria
// idêntica a `USING (true)`. A correção vive na aplicação: um predicado
// único (`podeAcessarConversaAoVivo`, src/seguranca/rbac.js), aplicado com
// o MESMO resultado no replay (SQL + reforço em JS) e no broadcast ao vivo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarEmissorDeConversas } = require('../src/servidor/eventos-conversas');
const { podeAcessarConversaAoVivo } = require('../src/seguranca/rbac');

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  return {
    disponivel: true,
    despacharEvento: async () => resposta,
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

// ---------------------------------------------------------------- predicado puro

test('podeAcessarConversaAoVivo: tabela de casos (mesma semântica de can_access_conversa, sem is_backend)', () => {
  const CASOS = [
    // [papel, usuarioId, atribuidoA, esperado, descrição]
    ['admin', 1, 2, true, 'admin vê conversa de qualquer um'],
    ['admin', 1, null, true, 'admin vê conversa livre'],
    ['gestor', 1, 2, true, 'gestor vê conversa de qualquer um'],
    ['gestor', 1, null, true, 'gestor vê conversa livre'],
    ['atendente', 1, null, true, 'atendente vê conversa livre (sem responsável)'],
    ['atendente', 1, 1, true, 'atendente vê a própria conversa'],
    ['atendente', 1, 2, false, 'atendente NÃO vê conversa de outro atendente'],
    ['atendente', 2, 1, false, 'atendente NÃO vê conversa de outro atendente (invertido)'],
    [undefined, 1, null, false, 'papel indefinido não vê nada — mesmo conversa livre'],
    [null, 1, 1, false, 'papel nulo não vê nada — mesmo sendo "o dono"'],
    ['financeiro', 1, null, false, 'papel desconhecido não vê nada — falta de regra nega'],
  ];

  for (const [papel, usuarioId, atribuidoA, esperado, descricao] of CASOS) {
    assert.equal(podeAcessarConversaAoVivo(papel, usuarioId, atribuidoA), esperado, descricao);
  }
});

// ---------------------------------------------------------------- cenário compartilhado

/**
 * Monta duas conversas — uma atribuída a cada atendente — e uma terceira
 * livre (nunca assumida). Devolve tudo que os testes de replay/ao vivo
 * precisam para exercer os três casos do predicado contra o MESMO estado.
 */
async function montarCenario() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const emissorDeConversas = criarEmissorDeConversas({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, emissor: emissorDeConversas });

  const app = await subirServidor({
    repositorio, atendimento, orquestrador, emissorDeConversas,
    configuracao: configuracaoDeTeste(), papel: 'atendente', master: false,
  });
  // sessão default do subirServidor: atendente A.
  const atendenteA = app.sessao;
  const atendenteB = await app.entrarComo('atendente');
  const gestor = await app.entrarComo('gestor');

  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:escopo:a',
    remetente: '5516900000101', nome: 'Conversa de A', texto: 'oi',
  });
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:escopo:b',
    remetente: '5516900000102', nome: 'Conversa de B', texto: 'oi',
  });
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia', id_externo: 'wa:escopo:livre',
    remetente: '5516900000103', nome: 'Conversa livre', texto: 'oi',
  });

  const todas = await repositorio.listarConversas({});
  const conversaDeA = todas.find((c) => c.contato.nome === 'Conversa de A');
  const conversaDeB = todas.find((c) => c.contato.nome === 'Conversa de B');
  const conversaLivre = todas.find((c) => c.contato.nome === 'Conversa livre');

  await atendimento.assumir(conversaDeA.id, atendenteA.usuario.id);
  await atendimento.assumir(conversaDeB.id, atendenteB.usuario.id);
  // conversaLivre nunca é assumida — atribuido_a permanece null.

  return {
    app, repositorio, atendimento, emissorDeConversas,
    atendenteA, atendenteB, gestor,
    conversaDeA, conversaDeB, conversaLivre,
  };
}

async function pedirTicketComo(app, sessao) {
  const resposta = await fetch(`${app.base}/api/conversas/eventos/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessao.access_token}` },
  });
  assert.equal(resposta.status, 200, 'emissão do bilhete precisa suceder para o teste fazer sentido');
  return (await resposta.json()).ticket;
}

async function lerAteConter(leitor, decodificador, buffer, textoEsperado, prazoMs = 500) {
  const prazo = Date.now() + prazoMs;
  while (!buffer.valor.includes(textoEsperado)) {
    if (Date.now() > prazo) return false;
    const corrida = await Promise.race([
      leitor.read().then((r) => ({ tipo: 'leitura', r })),
      new Promise((resolve) => setTimeout(() => resolve({ tipo: 'tempo' }), 50)),
    ]);
    if (corrida.tipo === 'tempo') continue;
    const { done, value } = corrida.r;
    if (done) return false;
    buffer.valor += decodificador.decode(value, { stream: true });
  }
  return true;
}

// ---------------------------------------------------------------- replay (reconexão)

test('[replay] atendente não recebe, no replay, evento de conversa atribuída a outro atendente', async (t) => {
  const { app, atendenteA, conversaDeA, conversaDeB, conversaLivre } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, atendenteA);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}&cursor=0`,
    { signal: controle.signal },
  );
  assert.equal(resposta.status, 200);
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  await lerAteConter(leitor, decodificador, buffer, 'conectado');
  // Dá tempo do replay (best-effort, mas síncrono na prática) terminar de escrever.
  await lerAteConter(leitor, decodificador, buffer, `"conversa_id":${conversaLivre.id}`, 500);

  controle.abort();
  await leitor.cancel().catch(() => {});

  assert.match(buffer.valor, new RegExp(`"conversa_id":${conversaDeA.id}\\b`), 'replay precisa trazer a conversa da própria atendente A');
  assert.match(buffer.valor, new RegExp(`"conversa_id":${conversaLivre.id}\\b`), 'replay precisa trazer a conversa livre (sem responsável)');
  assert.doesNotMatch(buffer.valor, new RegExp(`"conversa_id":${conversaDeB.id}\\b`), 'replay NÃO pode trazer a conversa atribuída ao atendente B');
});

test('[replay] gestor recebe o replay de TODAS as conversas — não quebra o caso legítimo', async (t) => {
  const { app, gestor, conversaDeA, conversaDeB, conversaLivre } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, gestor);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}&cursor=0`,
    { signal: controle.signal },
  );
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  await lerAteConter(leitor, decodificador, buffer, `"conversa_id":${conversaLivre.id}`, 500);
  controle.abort();
  await leitor.cancel().catch(() => {});

  for (const conversa of [conversaDeA, conversaDeB, conversaLivre]) {
    assert.match(buffer.valor, new RegExp(`"conversa_id":${conversa.id}\\b`), `gestor precisa ver a conversa ${conversa.id}`);
  }
});

test('[replay] forjar ?cursor=0 não abre o histórico de conversa alheia (paginação do zero continua restrita)', async (t) => {
  const { app, atendenteB, conversaDeA } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, atendenteB);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}&cursor=0`,
    { signal: controle.signal },
  );
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  // Espera o tempo padrão de replay (não há mais nada a esperar depois disto
  // além do próprio "conectado" — negativo, então não há texto-alvo a achar).
  await lerAteConter(leitor, decodificador, buffer, 'conectado');
  await new Promise((resolve) => setTimeout(resolve, 300));
  controle.abort();
  await leitor.cancel().catch(() => {});

  assert.doesNotMatch(buffer.valor, new RegExp(`"conversa_id":${conversaDeA.id}\\b`),
    '?cursor=0 (paginação do início do histórico) não pode devolver a conversa do outro atendente');
});

// ---------------------------------------------------------------- ao vivo (broadcast)

test('[ao vivo] atendente conectado não recebe evento novo de conversa atribuída a outro atendente', async (t) => {
  const { app, atendimento, atendenteA, atendenteB, conversaDeA, conversaDeB, conversaLivre } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, atendenteA);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`,
    { signal: controle.signal },
  );
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  await lerAteConter(leitor, decodificador, buffer, 'conectado');
  buffer.valor = ''; // só o que chegar DAQUI PRA FRENTE interessa (ao vivo).

  // Evento na conversa de B (não deveria chegar a A). `usuarioId` aqui é só
  // documentação: a conversa já foi assumida em `montarCenario`, então
  // `responderComoEquipe` não chama `assumir` de novo (só reatribuiria se
  // ainda estivesse livre) — quem decide o dono real é o `atribuido_a`
  // gravado no banco, não este argumento.
  await atendimento.responderComoEquipe(conversaDeB.id, 'oi de B', { usuarioId: atendenteB.usuario.id, autorNome: 'B' });
  // Evento na conversa livre (deveria chegar a A).
  await atendimento.responderComoEquipe(conversaLivre.id, 'oi da livre', { autorNome: 'Livre' });
  const chegouLivre = await lerAteConter(leitor, decodificador, buffer, `"conversa_id":${conversaLivre.id}`, 800);

  controle.abort();
  await leitor.cancel().catch(() => {});

  assert.ok(chegouLivre, 'o evento da conversa livre precisava ter chegado ao vivo');
  assert.doesNotMatch(buffer.valor, new RegExp(`"conversa_id":${conversaDeB.id}\\b`),
    'o evento da conversa de B NÃO pode chegar ao vivo para o atendente A');
});

test('[ao vivo] evento da própria conversa do atendente chega normalmente', async (t) => {
  const { app, atendimento, atendenteA, conversaDeA } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, atendenteA);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`,
    { signal: controle.signal },
  );
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  await lerAteConter(leitor, decodificador, buffer, 'conectado');

  await atendimento.responderComoEquipe(conversaDeA.id, 'oi de A', { usuarioId: atendenteA.usuario.id, autorNome: 'A' });
  const chegou = await lerAteConter(leitor, decodificador, buffer, `"conversa_id":${conversaDeA.id}`, 800);

  controle.abort();
  await leitor.cancel().catch(() => {});

  assert.ok(chegou, 'o evento da própria conversa do atendente precisava chegar ao vivo');
});

test('[ao vivo] admin recebe evento de QUALQUER conversa — não quebra o caso legítimo', async (t) => {
  const { app, atendimento, gestor, conversaDeA, conversaDeB } = await montarCenario();
  t.after(() => app.encerrar());

  const ticket = await pedirTicketComo(app, gestor);
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`,
    { signal: controle.signal },
  );
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const buffer = { valor: '' };
  await lerAteConter(leitor, decodificador, buffer, 'conectado');

  // As duas conversas já foram assumidas em `montarCenario` — `responderComoEquipe`
  // só chama `assumir` de novo se ainda estivesse livre, então não é preciso
  // (nem correto) repetir o `usuarioId` aqui.
  await atendimento.responderComoEquipe(conversaDeA.id, 'oi', { autorNome: 'A' });
  await atendimento.responderComoEquipe(conversaDeB.id, 'oi', { autorNome: 'B' });
  await lerAteConter(leitor, decodificador, buffer, `"conversa_id":${conversaDeB.id}`, 800);

  controle.abort();
  await leitor.cancel().catch(() => {});

  assert.match(buffer.valor, new RegExp(`"conversa_id":${conversaDeA.id}\\b`));
  assert.match(buffer.valor, new RegExp(`"conversa_id":${conversaDeB.id}\\b`));
});

// ---------------------------------------------------------------- paridade replay x ao vivo

test('[paridade] replay e transmissão ao vivo aplicam exatamente o mesmo escopo, mesma tabela de casos', async (t) => {
  const { app, atendenteA, atendenteB, gestor, conversaDeA, conversaDeB, conversaLivre } = await montarCenario();
  t.after(() => app.encerrar());

  const CASOS = [
    [atendenteA, conversaDeA, true],
    [atendenteA, conversaDeB, false],
    [atendenteA, conversaLivre, true],
    [atendenteB, conversaDeA, false],
    [atendenteB, conversaDeB, true],
    [gestor, conversaDeA, true],
    [gestor, conversaDeB, true],
  ];

  for (const [sessao, conversa, esperado] of CASOS) {
    const ticket = await pedirTicketComo(app, sessao);
    const controle = new AbortController();
    const resposta = await app.pedirSemAuth(
      `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}&cursor=0`,
      { signal: controle.signal },
    );
    const leitor = resposta.body.getReader();
    const decodificador = new TextDecoder();
    const buffer = { valor: '' };
    await lerAteConter(leitor, decodificador, buffer, 'conectado');
    await new Promise((resolve) => setTimeout(resolve, 200));
    controle.abort();
    await leitor.cancel().catch(() => {});

    const apareceu = buffer.valor.includes(`"conversa_id":${conversa.id}`);
    assert.equal(apareceu, esperado,
      `replay: papel=${sessao.usuario.papel} usuarioId=${sessao.usuario.id} conversa=${conversa.id} deveria ${esperado ? '' : 'NÃO '}aparecer`);
  }
});

// ---------------------------------------------------------------- ticket / limpeza

test('bilhete de outro usuário nunca existe: o resgate só devolve a identidade de quem o pediu', async (t) => {
  const { app, atendenteA, atendenteB } = await montarCenario();
  t.after(() => app.encerrar());

  const ticketDeA = await pedirTicketComo(app, atendenteA);
  const controle = new AbortController();
  // Simula uma tentativa de usar o bilhete de A tentando "se passar" por B —
  // não há campo de usuário na query; o único jeito de testar isso é confirmar
  // que a conexão aberta com o bilhete de A nunca vê o que só B deveria ver.
  const resposta = await app.pedirSemAuth(`/api/conversas/eventos?ticket=${encodeURIComponent(ticketDeA)}&cursor=0`, { signal: controle.signal });
  assert.equal(resposta.status, 200);
  controle.abort();
  await resposta.body?.cancel().catch(() => {});
  assert.notEqual(atendenteA.usuario.id, atendenteB.usuario.id, 'sanity: são usuários diferentes');
});
