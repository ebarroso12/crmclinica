'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// O recurso de orientação subiu para produção INERTE (achado em revisão
// independente, 13/09/2026).
//
// Todo o núcleo existia e era testado — `src/dominio/orientacao.js`, a tabela
// 052, a barreira anti-bastidor — mas nenhum dos TRÊS pontos de montagem
// passava `orientacoes` para `criarAtendimento`, e não havia rota para a
// equipe responder. O resultado era pior que não ter o recurso: o marcador
// `[[ORIENTAR: …]]` era removido do texto (essa parte funcionava), então a
// assistente dizia ao lead "vou confirmar com um profissional e retorno" e
// nada era gravado, ninguém era chamado, e a conversa seguia como se nada
// tivesse acontecido. Promessa vazia, em nome da clínica.
//
// Estes testes existem para que a próxima montagem não possa esquecer.

const RAIZ = path.join(__dirname, '..');
const leia = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');

test('os três pontos de montagem passam `orientacoes` ao atendimento', () => {
  // Um por processo, e cada um responde por um caminho diferente: o servidor
  // HTTP (webhook do Instagram e a porta síncrona), o worker da outbox (a
  // resposta da Serena no WhatsApp) e o de lembretes (a leitura do canal).
  for (const arquivo of ['src/servidor/http.js', 'bin/worker-outbox.js', 'bin/worker-lembretes.js']) {
    const fonte = leia(arquivo);
    assert.match(fonte, /criarOrientacoes/, `${arquivo} não monta o serviço de orientação`);
    const montagem = fonte.slice(fonte.indexOf('criarAtendimento({'));
    assert.match(
      montagem.slice(0, 900), /orientacoes/,
      `${arquivo} monta o atendimento SEM orientacoes: a dúvida não vira registro nenhum`,
    );
  }
});

test('existe caminho para a equipe responder, e um relógio para os 20 minutos', () => {
  // Sem rota, a dúvida ficaria pendente para sempre — e o índice único de uma
  // pendente por conversa impediria qualquer orientação futura ali.
  assert.match(leia('src/servidor/rotas-conversas.js'), /async responderOrientacao\(/);
  assert.match(leia('src/servidor/http.js'), /orientacao: \(corpo\) => conversas\.responderOrientacao/);
  assert.match(leia('public/index.html'), /id="form-orientacao"/);
  // E sem worker, o aviso dos vinte minutos nunca sairia: a Vercel dorme entre
  // requisições e não tem como acordar sozinha para conferir um prazo.
  assert.match(leia('bin/worker-lembretes.js'), /avisarQuemEsperaOrientacao/);
  assert.match(leia('bin/worker-lembretes.js'), /await avisarQuemEsperaOrientacao\(\);/);
});

// ------------------------------------------------------------ o fluxo inteiro

/** Conversa aberta com um contato, direto no armazém em memória. */
async function conversaDeTeste(repositorio) {
  const contato = await repositorio.encontrarOuCriarContato({
    telefone: '5511999990000', nome: 'Paciente Teste', canal: 'whatsapp', identificador: null,
  });
  return repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
}

test('a clínica responde pela conversa e a assistente fala com o lead', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio);
  await repositorio.criarOrientacao({
    conversaId: conversa.id, duvida: 'qual o valor da promoção do post',
  });

  const enviadas = [];
  const ambiente = await subirServidor({
    repositorio,
    // A compilação é o que transforma bastidor em resposta ao paciente.
    orientacoes: require('../src/dominio/orientacao').criarOrientacoes({
      repositorio,
      ia: { async gerar() { return 'A promoção do post está R$ 300 no primeiro pacote. Quer que eu já reserve?'; } },
    }),
    canalDeConversas: {
      async enviar({ texto }) { enviadas.push(texto); return { entregue: true, identificador: 'x1' }; },
    },
  });

  try {
    const detalhe = await (await ambiente.pedir(`/api/conversas/${conversa.id}`)).json();
    assert.equal(detalhe.orientacao_pendente.duvida, 'qual o valor da promoção do post',
      'a dúvida precisa chegar à tela junto da conversa que a gerou');

    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/orientacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Bastidor de verdade: o "se insistir" é para o colega, não para o lead.
      body: JSON.stringify({ orientacao: 'pode dar 300, e 10% se insistir' }),
    });

    assert.equal(resposta.status, 200);
    const corpo = await resposta.json();
    assert.equal(corpo.respondida, true);
    assert.equal(corpo.enviada, true);

    assert.equal(enviadas.length, 1, 'o lead precisa receber a resposta');
    assert.ok(!enviadas[0].includes('se insistir'), 'a margem de negociação não sai da clínica');

    // A pendência fecha: sem isto, o índice único trancaria a conversa para
    // qualquer orientação futura.
    const depois = await (await ambiente.pedir(`/api/conversas/${conversa.id}`)).json();
    assert.equal(depois.orientacao_pendente, null);
  } finally {
    await ambiente.encerrar();
  }
});

test('sem dúvida pendente a rota responde 404, não 500', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio);
  const ambiente = await subirServidor({ repositorio });

  try {
    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/orientacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orientacao: 'qualquer coisa' }),
    });
    assert.equal(resposta.status, 404);
  } finally {
    await ambiente.encerrar();
  }
});

test('orientação vazia é recusada antes de qualquer chamada de IA', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const conversa = await conversaDeTeste(repositorio);
  await repositorio.criarOrientacao({ conversaId: conversa.id, duvida: 'x' });

  let chamouIa = false;
  const ambiente = await subirServidor({
    repositorio,
    orientacoes: require('../src/dominio/orientacao').criarOrientacoes({
      repositorio,
      ia: { async gerar() { chamouIa = true; return 'algo'; } },
    }),
  });

  try {
    const resposta = await ambiente.pedir(`/api/conversas/${conversa.id}/orientacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orientacao: '   ' }),
    });
    assert.equal(resposta.status, 400);
    assert.equal(chamouIa, false, 'campo vazio não pode custar uma chamada de IA');
  } finally {
    await ambiente.encerrar();
  }
});

// -------------------------------------------- a assistente cala até orientarem

const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarOrientacoes } = require('../src/dominio/orientacao');

function orquestradorQuePedeOrientacao(texto) {
  return { disponivel: true, despacharEvento: async () => ({ resposta: texto }) };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:orientacao-1',
  remetente: '5516988887777',
  nome: 'Lead do Instagram',
  texto: 'vi o post de voces, quanto custa a promocao?',
});

test('pedida a orientação, a assistente para de responder até a clínica falar', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: orquestradorQuePedeOrientacao(
      'Sou a assistente de IA da clínica e não consigo confirmar o conteúdo da publicação. '
      + 'Vou verificar com um profissional e já te retorno. [[ORIENTAR: valor da promoção do post]]',
    ),
    orientacoes: criarOrientacoes({ repositorio }),
    canal: { async enviar() { return { identificador: 'wa-1' }; } },
  });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'respondida_e_pediu_orientacao');

  const [conversa] = await repositorio.listarConversas({});
  // `escalonar` sozinho NÃO desliga a automação — é deliberado, porque a
  // maioria dos escalonamentos é falha técnica e a próxima mensagem deve poder
  // ser respondida. Aqui é o contrário: ela mesma disse não saber do assunto.
  // Sem calar, a próxima mensagem do lead recebia OUTRA promessa de retorno, e
  // o índice único impedia até que a dúvida nova fosse registrada.
  assert.equal(conversa.assumida_por_humano, true,
    'a assistente não pode seguir respondendo sobre o que declarou não conhecer');
  assert.equal(conversa.atribuido_a, null, 'ninguém assumiu ainda: fica em "aguardando você"');

  const pendente = await repositorio.obterOrientacaoPendente(conversa.id);
  assert.equal(pendente.duvida, 'valor da promoção do post');
});

test('resposta que é SÓ o marcador ainda registra a dúvida', async () => {
  // Sem este caminho, o texto ficava vazio e tudo caía em
  // `automacao_sem_resposta`: a conversa ia para a equipe sem ninguém saber do
  // que se tratava.
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: orquestradorQuePedeOrientacao('[[ORIENTAR: qual o horário do sábado]]'),
    orientacoes: criarOrientacoes({ repositorio }),
    canal: { async enviar() { return { identificador: 'wa-2' }; } },
  });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'pediu_orientacao_sem_resposta');

  const [conversa] = await repositorio.listarConversas({});
  const pendente = await repositorio.obterOrientacaoPendente(conversa.id);
  assert.equal(pendente.duvida, 'qual o horário do sábado');
});
