'use strict';

// A garantia de ponta a ponta do Comando 3, na porta HTTP: o 202 só sai
// depois de tudo persistido, uma falha no meio da gravação não pode virar um
// 202 mentiroso, e "a função da Vercel morreu logo depois do 202" não perde
// o trabalho — porque não existe mais nada rodando depois do 202 que possa
// morrer. Quem processa é um worker separado, testado aqui como se fosse
// literalmente outro processo: mesma instância de repositório, chamada
// independente, sem nenhum estado emprestado da requisição HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDeOutbox } = require('../src/dominio/automacao-outbox-servico');
const { assinar } = require('../src/integracoes/openclaw');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

const SEGREDO = 'segredo-sintetico-da-ponte-whatsapp-com-mais-de-32-caracteres';
const EVENTO = Object.freeze({
  tipo: 'mensagem.recebida',
  canal: 'whatsapp',
  id_externo: 'openclaw:outbox-http-1',
  remetente: '5511999990000',
  nome: 'Paciente de Teste',
  texto: 'Olá, gostaria de agendar uma consulta',
  origem: 'openclaw_plugin',
  ocorrido_em: '2026-08-13T12:00:00.000Z',
});

function enviar(app, corpo, segredo = SEGREDO) {
  const bruto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return app.pedirSemAuth('/api/canais/whatsapp/eventos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(segredo ? { 'x-whatsapp-assinatura': assinar(bruto, segredo) } : {}),
    },
    body: bruto,
  });
}

test('a mensagem gravada "sobrevive" ao fim da requisição sem nenhum processo em segundo plano, e um worker independente a entrega depois', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'Claro! Temos horários amanhã.' }) } });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.equal(resposta.status, 202);

  // "A função da Vercel foi encerrada logo depois do 202" — não há nada para
  // simular aqui além de NÃO CHAMAR nada mais nesta app. O teste literalmente
  // para de usar `app` neste ponto e constrói um worker à parte, como se
  // fosse outro deploy, outro processo, minutos depois.
  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1, 'só a mensagem de entrada existe agora');

  const outbox = criarServicoDeOutbox({ repositorio, atendimento });
  const resultado = await outbox.processarLote({ limite: 10, worker: 'worker-independente' });

  assert.equal(resultado.reivindicados, 1);
  assert.equal(resultado.concluidos, 1);
  const mensagensDepois = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagensDepois.length, 2);
  assert.equal(mensagensDepois[1].direcao, 'saida');
});

test('banco indisponível no meio da gravação não produz um 202 falso', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });

  // Simula a queda do banco exatamente no ponto que `comUsuario` abriria a
  // transação — é o pior instante possível: depois de autenticar o payload,
  // antes de gravar qualquer coisa.
  const repositorioInstavel = {
    ...repositorio,
    async comUsuario() {
      throw new Error('connection terminated due to connection timeout');
    },
  };

  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio: repositorioInstavel, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.notEqual(resposta.status, 202, 'banco fora do ar não pode virar "aceito"');
  assert.equal(resposta.status, 500);

  // Nada foi persistido no repositório real por trás (aqui, o original —
  // sem passar pelo double que sempre falha): nenhum evento registrado, para
  // que uma reentrega legítima do webhook seja tratada como NOVA, não como
  // "já processei isso e vou fingir sucesso de novo".
  assert.equal(await repositorio.consultarEvento(EVENTO.id_externo), null);
});

test('uma falha ao enfileirar o trabalho da outbox aborta a transação inteira — nenhum recibo "aceito" sai', async (t) => {
  // Este teste prova o contrato do lado da aplicação: se qualquer escrita
  // dentro de `repositorio.comUsuario` lançar, a exceção sobe inteira e a
  // rota nunca chega a responder 202 nem a gravar o recibo do evento. A
  // garantia de que o banco real desfaz TAMBÉM a mensagem já gravada (o
  // "rollback total" propriamente dito) é do PostgreSQL, dentro do
  // BEGIN/COMMIT/ROLLBACK de `repositorio.comUsuario` — o próprio comentário
  // de `repositorio-memoria.js` explica por que o duplo em memória usado
  // aqui não finge isso: "o que garante isso é o PostgreSQL". Testar código
  // de aplicação com um duplo que reproduzisse rollback de verdade daria uma
  // falsa sensação de cobertura sobre uma garantia que não é do JavaScript.
  const repositorio = criarRepositorioEmMemoria();
  const repositorioComFalhaNaOutbox = {
    ...repositorio,
    async enfileirarTrabalhoDeOutbox() {
      throw new Error('duplicate key value violates unique constraint "automacao_outbox_chave_idempotencia_key"');
    },
  };
  // O atendimento precisa ser construído com o MESMO repositório instável —
  // em produção é uma única conexão de pool para tudo; usar um repositório
  // "bom" aqui só para o atendimento provaria o caminho errado.
  const atendimento = criarAtendimento({
    repositorio: repositorioComFalhaNaOutbox,
    orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) },
  });

  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio: repositorioComFalhaNaOutbox, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const resposta = await enviar(app, EVENTO);
  assert.notEqual(resposta.status, 202, 'a falha no enfileiramento não pode ser mascarada como aceite');

  assert.equal(await repositorio.consultarEvento(EVENTO.id_externo), null,
    'sem confirmação de que o trabalho foi persistido, o evento não pode ser marcado como processado');
});

test('reentrega do mesmo evento depois de aceito não cria segundo trabalho nem segunda mensagem', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio, orquestrador: { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } });
  const configuracao = configuracaoDeTeste({ WHATSAPP_WEBHOOK_SECRET: SEGREDO });
  const app = await subirServidor({ repositorio, atendimento, configuracao, autenticar: false });
  t.after(() => app.encerrar());

  const primeira = await enviar(app, EVENTO);
  assert.equal(primeira.status, 202);
  const segunda = await enviar(app, EVENTO);
  assert.equal(segunda.status, 200);
  assert.equal((await segunda.json()).duplicado, true);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1);
  const fila = await repositorio.contarTrabalhosDeOutboxPorEstado();
  assert.equal(fila.pendente, 1, 'só um trabalho, não dois');
});
