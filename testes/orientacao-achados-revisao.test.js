'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarOrientacoes } = require('../src/dominio/orientacao');

// Achados da revisão independente do PR #76 (13/09/2026), contra o meu próprio
// trabalho. Dois deles eram bloqueadores: o recurso que eu tinha acabado de
// "ligar" não funcionaria em produção, e o aviso dos 20 minutos poderia gravar
// 1440 linhas por dia numa conversa parada.

async function conversaDeTeste(repositorio, telefone = '5511999990000') {
  const contato = await repositorio.encontrarOuCriarContato({
    telefone, nome: 'Paciente Teste', canal: 'whatsapp', identificador: null,
  });
  return repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
}

// ------------------------------------------------ B1 e b3: quem pode escrever

test('atendente não escreve nota interna na conversa de um colega', async () => {
  // A elevação a papel de sistema tira `can_access_conversa` da jogada. Antes
  // desta guarda, `POST /api/conversas/:id/mensagens {"privada": true}` gravava
  // na conversa de qualquer um — a policy era quem barrava, e ela deixou de ser
  // consultada no instante em que passamos a elevar.
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio);

  const ambiente = await subirServidor({ repositorio, papel: 'atendente', master: false });
  try {
    // A conversa é de OUTRA pessoa.
    await repositorio.atualizarConversa(conversa.id, {
      assumida_por_humano: true, atribuido_a: 99999,
    });

    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/mensagens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto: 'anotação que não é minha', privada: true }),
    });

    // 404, não 403: confirmar a conversa já contaria algo sobre o atendimento
    // de outra pessoa.
    assert.equal(resposta.status, 404);

    const mensagens = await repositorio.listarMensagens(conversa.id);
    assert.equal(mensagens.length, 0, 'nada pode ter sido gravado');
  } finally {
    await ambiente.encerrar();
  }
});

test('o mesmo atendente escreve normalmente na conversa que é dele', async () => {
  // A guarda não pode virar uma porta trancada: sem este par, "não escreve na
  // do colega" passaria mesmo com tudo quebrado.
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio, '5511988887777');
  const ambiente = await subirServidor({ repositorio, papel: 'atendente', master: false });

  try {
    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/mensagens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto: 'combinei retorno para quinta', privada: true }),
    });

    assert.equal(resposta.status, 200);
    const mensagens = await repositorio.listarMensagens(conversa.id);
    assert.equal(mensagens.length, 1);
    assert.equal(mensagens[0].privada, true);
  } finally {
    await ambiente.encerrar();
  }
});

test('admin responde orientação em qualquer conversa, inclusive atribuída a outro', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio, '5511977776666');
  await repositorio.atualizarConversa(conversa.id, { atribuido_a: 42 });
  await repositorio.criarOrientacao({ conversaId: conversa.id, duvida: 'valor do post' });

  const enviadas = [];
  const ambiente = await subirServidor({
    repositorio,
    orientacoes: criarOrientacoes({
      repositorio, ia: { async gerar() { return 'O valor é R$ 300.'; } },
    }),
    canalDeConversas: {
      async enviar({ texto }) { enviadas.push(texto); return { entregue: true, identificador: 'x' }; },
    },
  });

  try {
    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/orientacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orientacao: 'pode dar 300' }),
    });
    assert.equal(resposta.status, 200);
    assert.equal(enviadas.length, 1);
  } finally {
    await ambiente.encerrar();
  }
});

// ------------------------------------- B2: o aviso dos 20 minutos não duplica

test('entrega falhando não grava uma linha nova a cada ciclo do worker', async () => {
  // O worker roda de minuto em minuto. Sem chave determinística, cada ciclo
  // gravava OUTRA mensagem na thread: 1440 por dia numa conversa parada, todas
  // marcadas "não entregue", na conversa que a equipe lê.
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio, '5511966665555');

  const atendimento = criarAtendimento({
    repositorio,
    canal: { async enviar() { throw new Error('WhatsApp fora do ar'); } },
  });

  const enviar = (conversaId, texto, { chave = null } = {}) => (
    atendimento.responderComoAssistente(conversaId, texto, { devolverAAutomacao: false, chave })
  );

  // Três ciclos seguidos com o canal fora do ar.
  for (let ciclo = 0; ciclo < 3; ciclo += 1) {
    await enviar(conversa.id, 'A equipe vai entrar em contato.', { chave: 'orientacao-aviso-7' });
  }

  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.length, 1, 'a chave determinística é quem absorve a retentativa');
});

// ----------------------------- b5: a assistente não fala fora do horário dela

test('o aviso não sai quando a assistente está calada, e a pendência continua', async () => {
  // Este aviso sai assinado pela Serena. PARAR SERENA, o interruptor e a grade
  // de horário precisam valer aqui — a entrega deste aviso não passa pela
  // barreira final, e não pode passar: a conversa está assumida de propósito.
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio, '5511955554444');
  const criada = await repositorio.criarOrientacao({ conversaId: conversa.id, duvida: 'x' });

  const enviadas = [];
  const orientacoes = criarOrientacoes({
    repositorio,
    // Vinte minutos à frente, para a pendência já estar vencida.
    agora: () => new Date(Date.now() + 25 * 60 * 1000),
  });

  const resultado = await orientacoes.avisarQuemEspera({
    assistentePodeFalar: async () => false, // fora do horário / PARAR SERENA
    enviarNaConversa: async (id, texto) => { enviadas.push(texto); },
  });

  assert.equal(resultado.avisados, 0);
  assert.deepEqual(enviadas, [], 'nada sai em nome da assistente enquanto ela está calada');

  // E a dúvida continua pendente: o próximo ciclo, dentro do horário, avisa.
  const aindaPendente = await repositorio.obterOrientacaoPendente(conversa.id);
  assert.equal(aindaPendente.id, criada.id);
});

test('não saber se a assistente pode falar é não falar', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio, '5511944443333');
  await repositorio.criarOrientacao({ conversaId: conversa.id, duvida: 'x' });

  const enviadas = [];
  const orientacoes = criarOrientacoes({
    repositorio, agora: () => new Date(Date.now() + 25 * 60 * 1000),
  });

  const resultado = await orientacoes.avisarQuemEspera({
    assistentePodeFalar: async () => { throw new Error('banco piscou'); },
    enviarNaConversa: async (id, texto) => { enviadas.push(texto); },
  });

  assert.equal(resultado.avisados, 0);
  assert.deepEqual(enviadas, []);
});

// -------------------- b4: "Liberar travadas" não solta quem espera orientação

test('"Liberar travadas por falha" não devolve conversa com dúvida pendente', async () => {
  // "Assumida sem dono" deixou de significar só "travada por falha": a
  // orientação usa o mesmo estado para calar a assistente. Soltar essas aqui
  // devolvia à automação uma conversa com a pergunta em aberto — e o índice
  // único faria a Serena repetir a promessa sem chamar ninguém.
  const repositorio = criarRepositorioEmMemoria();
  const comDuvida = await conversaDeTeste(repositorio, '5511933332222');
  const travada = await conversaDeTeste(repositorio, '5511922221111');

  for (const conversa of [comDuvida, travada]) {
    await repositorio.atualizarConversa(conversa.id, {
      assumida_por_humano: true, atribuido_a: null, status: 'aberta',
    });
  }
  await repositorio.criarOrientacao({ conversaId: comDuvida.id, duvida: 'valor do post' });

  const atendimento = criarAtendimento({ repositorio });
  const resultado = await atendimento.liberarEmMassa();

  assert.equal(resultado.liberadas, 1, 'só a travada por falha volta para a automação');
  assert.equal(resultado.aguardando_orientacao, 1);

  const aindaCalada = await repositorio.obterConversa(comDuvida.id);
  assert.equal(aindaCalada.assumida_por_humano, true, 'quem solta esta é o prazo de 20 minutos');
  const devolvida = await repositorio.obterConversa(travada.id);
  assert.equal(devolvida.assumida_por_humano, false);
});

// ------------------ menor: calar sem registrar deixaria a conversa sem saída

test('dúvida que não foi registrada não cala a conversa', async () => {
  // Sem registro, os 20 minutos não enxergam nada para soltar: a conversa
  // ficaria parada até alguém notar à mão.
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: '[[ORIENTAR: x]]' }) },
    orientacoes: { async pedir() { return { pedida: false, motivo: 'banco fora do ar' }; } },
    canal: { async enviar() { return { identificador: 'wa-1' }; } },
  });

  await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:sem-registro',
    remetente: '5511911110000',
    nome: 'Lead',
    texto: 'vi o post',
  });

  const [conversa] = await repositorio.listarConversas({});
  assert.equal(conversa.assumida_por_humano, false,
    'sem pendência registrada, o escalonamento comum já entrega para a equipe');
});
