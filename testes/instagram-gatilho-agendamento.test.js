'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  comentarioContemGatilho, termosDoGatilho, ehGatilhoDeTodos, GATILHO_TODOS,
} = require('../src/dominio/texto-normalizado');
const { criarServicoDeGatilhos, validarRegraDeGatilho } = require('../src/dominio/instagram-gatilhos');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { REGRAS } = require('../bin/semear-instagram');

// ------------------------------------------------------------ o casamento

test('uma regra cobre a intenção inteira: agendar, agendamento, marcar', () => {
  // O pedido do Dr. Edson: "sempre que o paciente escrever no post agendar,
  // agendamento ou algo assim". Uma palavra literal por regra obrigaria a
  // manter três cópias da mesma DM em três lugares.
  const gatilho = 'agend, marcar, marque, consulta, horario';

  for (const comentario of [
    'quero agendar',
    'como faço o agendamento?',
    'tem AGENDA pra semana que vem?',
    'gostaria de marcar uma consulta',
    'marque pra mim por favor',
    'qual o horário de vocês?',
    'quero saber do horario',
  ]) {
    assert.equal(comentarioContemGatilho(comentario, gatilho), true, comentario);
  }

  for (const comentario of ['que post lindo', 'parabéns doutor', '']) {
    assert.equal(comentarioContemGatilho(comentario, gatilho), false, comentario);
  }
});

test('acento e caixa não decidem se o paciente é atendido', () => {
  assert.equal(comentarioContemGatilho('QUERO MARCAR HORÁRIO', 'horario'), true);
  assert.equal(comentarioContemGatilho('preciso de consultá', 'consulta'), true);
});

test('termo de uma letra é descartado — vírgula sobrando não vira resposta em massa', () => {
  assert.deepEqual(termosDoGatilho('agendar, , a, marcar'), ['agendar', 'marcar']);
  assert.equal(comentarioContemGatilho('que foto boa', 'a, e, o'), false);
});

test('ponto-e-vírgula e barra também separam', () => {
  assert.deepEqual(termosDoGatilho('agendar; marcar | consulta'), ['agendar', 'marcar', 'consulta']);
});

test('a regra "todo comentário" casa com qualquer texto, e só ela', () => {
  assert.equal(ehGatilhoDeTodos(GATILHO_TODOS), true);
  assert.equal(ehGatilhoDeTodos('agendar'), false);
  assert.equal(comentarioContemGatilho('que post lindo', GATILHO_TODOS), true);
  assert.equal(comentarioContemGatilho('', GATILHO_TODOS), false, 'comentário vazio continua sem resposta');
});

test('regra sem nenhum termo aproveitável é recusada no cadastro', () => {
  assert.throws(
    () => validarRegraDeGatilho({
      nome: 'ruim', palavraGatilho: 'a, b', mensagemDm: 'oi tudo bem', mensagemPublica: 'oi',
    }),
    (erro) => erro.codigo === 'palavra_gatilho_sem_termos',
  );
});

// ------------------------------------------------- comentário → resposta + DM

function envioFalso() {
  const publicas = [];
  const dms = [];
  return {
    publicas,
    dms,
    async responderComentarioPublicamente(carga) { publicas.push(carga); return { identificador: 'r1' }; },
    async responderComentarioPrivadamente(carga) { dms.push(carga); return { identificador: 'd1' }; },
  };
}

async function comRegras(repositorio, regras) {
  for (const regra of regras) await repositorio.criarRegraDeGatilho(regra);
}

const AGENDAMENTO = {
  nome: 'Agendamento',
  palavraGatilho: 'agend, marcar',
  mensagemDm: 'Oi! Vamos separar um horário para você?',
  mensagemPublica: 'Te chamei no direct!',
  ctaWhatsapp: true,
};

const TODOS = {
  nome: 'Todo comentário',
  palavraGatilho: GATILHO_TODOS,
  mensagemDm: 'Oi! Estou à disposição por aqui.',
  mensagemPublica: 'Obrigada por comentar!',
  ctaWhatsapp: false,
};

test('comentário com a palavra do agendamento recebe resposta pública, DM e vira lead', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [AGENDAMENTO]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({
    repositorio, instagramEnvio, numeroWhatsapp: '+55 16 99743-3914',
  });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c1', postId: 'p1', autorIgId: 'ig-1', autorUsername: 'ana',
    texto: 'quero agendar uma consulta',
  });

  assert.equal(resultado.regra.nome, 'Agendamento');
  assert.equal(resultado.resposta_publica_enviada, true);
  assert.equal(resultado.dm_enviada, true);
  assert.equal(instagramEnvio.publicas[0].texto, 'Te chamei no direct!');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  assert.equal(conversas[0].canal, 'instagram');
});

test('o CTA do WhatsApp deixa de ser decorativo: o link entra na DM', async () => {
  // `cta_whatsapp` era gravado, editável na tela e nunca lido por ninguém —
  // o admin ligava o botão e a mensagem saía exatamente igual.
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [AGENDAMENTO]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({
    repositorio, instagramEnvio, numeroWhatsapp: '+55 (16) 99743-3914',
  });

  await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: 'ig-1', texto: 'quero marcar',
  });

  const enviada = instagramEnvio.dms[0].texto;
  assert.match(enviada, /^Oi! Vamos separar um horário para você\?/);
  assert.match(enviada, /https:\/\/wa\.me\/5516997433914$/, 'o número vai só com dígitos');

  // O histórico do CRM precisa mostrar o que a pessoa recebeu, não o texto
  // do cadastro: quem abre a conversa depois lê a mesma mensagem.
  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens[0].conteudo, enviada);
});

test('sem número configurado a DM sai sem link — link quebrado é pior que link nenhum', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [AGENDAMENTO]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio, numeroWhatsapp: null });

  await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: 'ig-1', texto: 'quero marcar',
  });

  assert.equal(instagramEnvio.dms[0].texto, 'Oi! Vamos separar um horário para você?');
});

test('com o CTA desligado, a regra manda só o texto dela', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [TODOS]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({
    repositorio, instagramEnvio, numeroWhatsapp: '5516997433914',
  });

  await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: 'ig-1', texto: 'que post lindo',
  });

  assert.equal(instagramEnvio.dms[0].texto, 'Oi! Estou à disposição por aqui.');
});

test('a regra "todo comentário" nunca rouba um comentário que tem gatilho próprio', async () => {
  // `find()` devolve a primeira que casar, e as regras vêm ordenadas por nome:
  // "Agendamento" antes de "Todo comentário" seria sorte, não desenho. Aqui a
  // ordem de cadastro é invertida de propósito.
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [TODOS, AGENDAMENTO]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio });

  const comGatilho = await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: 'ig-1', texto: 'quero agendar',
  });
  assert.equal(comGatilho.regra.nome, 'Agendamento');

  const semGatilho = await servico.processarComentario({
    comentarioIdExterno: 'c2', autorIgId: 'ig-2', texto: 'que post lindo',
  });
  assert.equal(semGatilho.regra.nome, 'Todo comentário');
});

test('nenhum comentário fica sem resposta quando a regra "todo comentário" está ativa', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comRegras(repositorio, [TODOS]);
  const instagramEnvio = envioFalso();
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio });

  for (const [i, texto] of ['parabéns doutor', '❤️', 'top demais'].entries()) {
    const r = await servico.processarComentario({
      comentarioIdExterno: `c${i}`, autorIgId: `ig-${i}`, texto,
    });
    assert.ok(r.regra, `"${texto}" precisa cair na regra geral`);
  }
  assert.equal(instagramEnvio.publicas.length, 3);
});

// ------------------------------------------------------------------ semente

test('as regras semeadas são válidas e cobrem o pedido', () => {
  for (const regra of REGRAS) assert.doesNotThrow(() => validarRegraDeGatilho(regra));

  const agendamento = REGRAS.find((r) => r.nome === 'Agendamento');
  for (const comentario of ['quero agendar', 'agendamento', 'gostaria de marcar', 'qual o horario']) {
    assert.equal(comentarioContemGatilho(comentario, agendamento.palavraGatilho), true, comentario);
  }

  assert.ok(REGRAS.some((r) => ehGatilhoDeTodos(r.palavraGatilho)), 'a semente cobre o que sobrou');
});
