'use strict';

// A barreira de conteúdo (respostaPodeSair, src/seguranca/barreira-ia.js) cobre
// toda resposta gerada por src/ia/gateway.js — orientação, resumo,
// qualificação. Até 14/09/2026, o caminho que RESPONDE DE VERDADE ao paciente
// (Arquitetura B: `orquestrador` aqui é sempre `criarClienteOpenClaw`, que
// despacha via `chat.send` ao OpenClaw — src/integracoes/openclaw.js) nunca
// passava por ela, porque o texto nasce dentro do próprio OpenClaw, fora
// daquele gateway. Estes testes provam que agora passa, e que o
// comportamento normal (resposta limpa) não muda em nada.
//
// As frases usadas abaixo (barradas e legítimas) são as MESMAS já provadas em
// testes/seguranca-ia.test.js contra o prompt real da Serena — reaproveitadas
// aqui, não reinventadas, para não arriscar um texto de teste que por acaso
// não bate com a regex de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

function orquestradorFalso(resposta) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => {
      despachos.push(carga);
      return resposta;
    },
  };
}

function canalFalso() {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      envios.push(carga);
      return { identificador: 'wa-saida-1' };
    },
  };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:barreira:1',
  remetente: '5516999999999',
  nome: 'Marina Souza',
  texto: 'Quero saber sobre a primeira consulta',
});

async function rodar(textoDaResposta, { numerosInternos = [] } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso({ resposta: textoDaResposta });
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, orquestrador, canal, numerosInternos,
  });
  const resultado = await atendimento.receberMensagem(EVENTO);
  return { repositorio, canal, resultado };
}

test('resposta que revela prontuário/diagnóstico é barrada — escalona, não entrega, paciente não recebe nada', async () => {
  const { repositorio, canal, resultado } = await rodar('O prontuário dela indica retorno em 30 dias.');

  assert.equal(resultado.acao, 'escalonada_por_barreira');
  assert.equal(resultado.entregue, false);
  assert.equal(canal.envios.length, 0, 'o texto barrado nunca pode sair pelo canal');

  const [conversa] = await repositorio.listarConversas({});
  const { itens } = await repositorio.listarAuditoria({ limite: 50 });
  assert.ok(
    itens.some((item) => item.acao === 'resposta_barrada_pela_barreira'),
    'a barreira precisa deixar rastro de auditoria próprio, distinto de um escalonamento comum',
  );
  assert.ok(itens.some((item) => item.acao === 'escalonada'), 'a conversa precisa ir para a equipe');

  const mensagens = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: true });
  assert.ok(
    !mensagens.some((m) => /prontu[áa]rio/i.test(m.conteudo)),
    'o texto barrado não pode aparecer em NENHUMA mensagem gravada — nem a que avisa a equipe',
  );
  const aviso = mensagens.find((m) => m.autor_tipo === 'sistema');
  assert.ok(aviso, 'a equipe vê o aviso interno na própria conversa');
  assert.match(aviso.conteudo, /resposta_barrada_pela_barreira/);
});

test('resposta que entrega CPF é barrada', async () => {
  const { canal, resultado } = await rodar('O CPF dela é 123.456.789-00.');
  assert.equal(resultado.acao, 'escalonada_por_barreira');
  assert.equal(canal.envios.length, 0);
});

test('resposta com instrução de ocultar algo do paciente (marca de bastidor) é barrada', async () => {
  const { canal, resultado } = await rodar('Não fala do valor promocional para ela.');
  assert.equal(resultado.acao, 'escalonada_por_barreira');
  assert.equal(canal.envios.length, 0);
});

test('resposta que entrega contato de terceiro é barrada', async () => {
  const { canal, resultado } = await rodar('Fale com a Ana no (11) 98888-7777.');
  assert.equal(resultado.acao, 'escalonada_por_barreira');
  assert.equal(canal.envios.length, 0);
});

test('resposta limpa continua entregue normalmente — a barreira não é falso positivo em conversa comum', async () => {
  const { canal, resultado } = await rodar('Claro! Temos horário amanhã às 14h, funciona para você?');
  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.entregue, true);
  assert.equal(canal.envios.length, 1);
});

test('as frases que o próprio prompt manda dizer continuam saindo (mesmo corpus de testes/seguranca-ia.test.js)', async () => {
  const frases = [
    'Agende sua avaliação diagnóstica presencial.',
    'Como isso envolve uma decisão clínica, preciso encaminhar sua dúvida para a equipe.',
    'Vou confirmar com a equipe para não te passar uma informação incorreta.',
  ];
  for (const frase of frases) {
    const { canal, resultado } = await rodar(frase);
    assert.equal(resultado.acao, 'respondida_pela_automacao', `a barreira emudeceu uma frase legítima: "${frase}"`);
    assert.equal(canal.envios.length, 1);
  }
});

test('o telefone da própria clínica na resposta não é barrado (é atendimento, não vazamento)', async () => {
  // Achado do code-review de 14/09/2026: a frase antiga aqui ("Telefone/
  // WhatsApp: (16) 99312-0938") passa igual SEM a allowlist — ela nunca bate
  // em nenhuma marca de contato de terceiro para começo de conversa, então
  // o teste não provava nada sobre `numerosInternos` (um bug na fiação dessa
  // lista passaria em branco). "Fale com a recepção no ..." bate na marca
  // (verbo + telefone perto) e só passa por causa da allowlist — verificado
  // nos dois sentidos abaixo antes de confiar na frase.
  const frase = 'Fale com a recepção no (16) 99312-0938.';

  const semAllowlist = await rodar(frase, { numerosInternos: [] });
  assert.equal(semAllowlist.resultado.acao, 'escalonada_por_barreira', 'sem a allowlist, a frase precisa ser barrada — senão não prova nada');

  const comAllowlist = await rodar(frase, { numerosInternos: ['5516993120938'] });
  assert.equal(comAllowlist.resultado.acao, 'respondida_pela_automacao');
  assert.equal(comAllowlist.canal.envios.length, 1);
});

test('retentativa de entrega também passa pela barreira — não só a "primeira vez"', async () => {
  // Achado do code-review de 14/09/2026: o texto gravado ANTES deste commit
  // (por código sem a barreira) e ainda pendente de entrega no momento do
  // deploy reentregaria pelo caminho de retentativa (respostaAnterior, mais
  // acima em responderSePossivel) sem NUNCA passar pela checagem nova — essa
  // checagem só corria no caminho "de primeira". Simula exatamente isso:
  // insere direto no repositório uma resposta já gravada, sem `entregue_em`
  // (pendente), como o código de antes teria deixado — sem passar por
  // `despacharEvento` nem pela barreira.
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso({ resposta: 'não deveria ser chamado nesta retentativa' });
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, numerosInternos: [] });

  // Uma conversa/contato precisa existir antes de chamar responderSePossivel
  // direto — usa uma mensagem limpa só para estabelecer a conversa, depois
  // insere a entrada real do teste.
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  const { mensagem: entrada } = await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada',
    conteudo: 'segunda pergunta',
    autor_tipo: 'contato',
    id_externo: 'wa:barreira:retentativa',
  });
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida',
    conteudo: 'O prontuário dela indica retorno em 30 dias.',
    autor_tipo: 'automacao',
    autor_nome: 'Serena',
    id_externo: `serena:resposta:${conversa.id}:${entrada.id}`,
    // Sem entregue_em: pendente — é o estado que dispara o caminho de
    // retentativa em vez do "já entregue, nem tenta de novo".
  });

  // `receberMensagem(EVENTO)` acima já entregou sua própria resposta limpa —
  // o que importa daqui em diante é que a retentativa NÃO acrescente um novo
  // envio, não que `canal.envios` esteja vazio.
  const enviosAntes = canal.envios.length;
  const despachosAntes = orquestrador.despachos.length;
  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: entrada.id });

  assert.equal(resultado.acao, 'escalonada_por_barreira');
  assert.equal(resultado.entregue, false);
  assert.equal(canal.envios.length, enviosAntes, 'o texto barrado gravado antes não pode ser entregue na retentativa');
  assert.equal(
    orquestrador.despachos.length, despachosAntes,
    'a retentativa reaproveita o texto já gravado — não chama a IA de novo',
  );
});
