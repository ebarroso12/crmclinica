'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');

// Provas das regras absolutas da Serena no ciclo de atendimento:
//
//   1. inbound é persistido ANTES de qualquer resposta;
//   2. um inbound gera no máximo UMA resposta automática;
//   3. a retentativa reutiliza a MESMA chave de idempotência;
//   4. handoff humano cala a IA; liberar devolve a palavra;
//   5. Serena desligada continua registrando mensagens;
//   6. a resposta da IA é ENTREGUE ao paciente pelo canal, com chave
//      determinística — gravar no banco sem entregar não é atender.
//
// Tudo com dublês: nenhuma rede, nenhum dado real de paciente.

function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => {
      despachos.push(carga);
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  };
}

/** Canal simulado que deduplica pela chave, como o gateway real faz. */
function canalFalso() {
  const envios = [];
  return {
    envios,
    enviar: async ({ telefone, texto, chave }) => {
      const repetido = envios.find((envio) => envio.chave === chave);
      envios.push({ telefone, texto, chave, deduplicado: Boolean(repetido) });
      return { identificador: `env-${chave}` };
    },
  };
}

function montar({ resposta, comSerena = false, comCanal = true } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso(resposta);
  const canal = comCanal ? canalFalso() : null;
  const serena = comSerena ? criarServicoDaSerena({ repositorio }) : null;
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, serena });
  return { repositorio, orquestrador, canal, serena, atendimento };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:sintetico:1',
  remetente: '5516900000001',
  nome: 'Paciente Sintético',
  texto: 'Quero saber sobre a primeira consulta',
});

// ---------------------------------------------------------------- entrega

test('a resposta da Serena é entregue ao paciente pelo canal, com chave determinística', async () => {
  const { canal, atendimento } = montar();

  const resultado = await atendimento.receberMensagem(EVENTO);

  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.entregue, true, 'gravar sem entregar não é atender');
  assert.equal(canal.envios.length, 1);
  assert.equal(canal.envios[0].telefone, '5516900000001');
  assert.match(canal.envios[0].chave, /^serena:\d+:\d+$/);
});

test('sem canal configurado, a resposta é gravada e o resultado diz que não saiu', async () => {
  const { repositorio, atendimento } = montar({ comCanal: false });

  const resultado = await atendimento.receberMensagem(EVENTO);

  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.entregue, false);

  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.length, 2, 'a resposta fica gravada esperando o canal');
});

test('falha na entrega fica auditada como resposta_nao_entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const canal = { enviar: async () => { throw new Error('gateway fora do ar'); } };
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal });

  const resultado = await atendimento.receberMensagem(EVENTO);

  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.entregue, false);
  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'resposta_nao_entregue'
    && registro.detalhe?.autor === 'automacao'));
});

// ------------------------------------------------- um inbound, uma resposta

test('a resposta automática nasce com id_externo determinístico — é o índice único que garante a regra', async () => {
  const { repositorio, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);

  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);
  const resposta = mensagens.find((mensagem) => mensagem.autor_tipo === 'automacao');

  const entrada = mensagens.find((mensagem) => mensagem.direcao === 'entrada');
  assert.equal(resposta.id_externo, `serena:resposta:${conversa.id}:${entrada.id}`);
});

test('reentrega do mesmo inbound não gera segunda resposta nem segundo envio', async () => {
  const { repositorio, orquestrador, canal, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const repetida = await atendimento.receberMensagem(EVENTO);

  assert.equal(repetida.acao, 'mensagem_duplicada');
  assert.equal(orquestrador.despachos.length, 1);
  assert.equal(canal.envios.length, 1);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 2);
});

test('duas execuções do mesmo inbound gravam UMA resposta e o envio extra é deduplicado pela chave', async () => {
  const { repositorio, canal, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
  const entrada = (await repositorio.listarMensagens(conversa.id))
    .find((mensagem) => mensagem.direcao === 'entrada');

  // Reexecução direta do ciclo de resposta para o MESMO inbound — o que uma
  // corrida de dois workers ou um retry agressivo produziria.
  const segunda = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: entrada.id });

  assert.equal(segunda.acao, 'respondida_pela_automacao');
  assert.equal(segunda.duplicada, true, 'a segunda execução reconhece a resposta existente');

  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.equal(mensagens.filter((mensagem) => mensagem.autor_tipo === 'automacao').length, 1,
    'o paciente recebe UMA resposta, não duas');

  const chaves = canal.envios.map((envio) => envio.chave);
  assert.equal(new Set(chaves).size, 1, 'toda tentativa de envio usa a mesma chave');
});

test('queda entre gravar e entregar: a retentativa entrega sem despachar a IA de novo', async () => {
  const { repositorio, orquestrador, canal, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
  const entrada = (await repositorio.listarMensagens(conversa.id))
    .find((mensagem) => mensagem.direcao === 'entrada');

  const despachosAntes = orquestrador.despachos.length;
  const retentativa = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: entrada.id });

  assert.equal(orquestrador.despachos.length, despachosAntes, 'a IA não é consultada de novo');
  assert.equal(retentativa.duplicada, true);
  assert.equal(canal.envios.at(-1).deduplicado, true, 'o gateway deduplica pela chave repetida');
});

// ---------------------------------------------------------------- retry

test('a chave de idempotência do despacho deriva do inbound, não da última mensagem', async () => {
  const { repositorio, orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
  const entrada = (await repositorio.listarMensagens(conversa.id))
    .find((mensagem) => mensagem.direcao === 'entrada');

  assert.equal(orquestrador.despachos[0].chave_idempotencia, `conversa:${conversa.id}:${entrada.id}`);
});

test('retry depois de falha reutiliza a MESMA chave, mesmo com mensagem nova no meio', async () => {
  const falha = Object.assign(new Error('fora do ar'), { codigo: 'gateway_timeout' });
  const { repositorio, orquestrador, atendimento } = montar({ resposta: falha });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'escalonada_por_falha');

  const [conversa] = await repositorio.listarConversas({});
  const entrada = (await repositorio.listarMensagens(conversa.id))
    .find((mensagem) => mensagem.direcao === 'entrada');

  // Uma nota da equipe entra na conversa entre a falha e o retry.
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida', conteudo: 'nota', autor_tipo: 'sistema', privada: true,
  });

  await atendimento.liberar(conversa.id); // a escalonação assumiu; o retry precisa da conversa livre
  await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: entrada.id });

  const chaves = orquestrador.despachos.map((despacho) => despacho.chave_idempotencia);
  assert.equal(chaves.length, 2);
  assert.equal(chaves[0], chaves[1], 'retry é o mesmo evento, não um evento novo');
});

// ---------------------------------------------------------------- handoff

test('handoff: assumir cala a IA; liberar devolve a palavra', async () => {
  const { repositorio, orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, 7);
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:sintetico:2', texto: 'Alô?' });
  assert.equal(orquestrador.despachos.length, 1, 'conversa assumida: a IA cala');

  await atendimento.liberar(conversa.id);
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:sintetico:3', texto: 'E agora?' });
  assert.equal(orquestrador.despachos.length, 2, 'conversa liberada: a IA volta');
});

test('handoff pausa a IA só NAQUELA conversa — as demais seguem atendidas', async () => {
  const { repositorio, orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversaA] = await repositorio.listarConversas({});
  await atendimento.assumir(conversaA.id, 7);

  await atendimento.receberMensagem({
    ...EVENTO, id_externo: 'wa:sintetico:4', remetente: '5516900000002', nome: 'Outro Paciente',
  });

  assert.equal(orquestrador.despachos.length, 2, 'o outro paciente não pode pagar pelo handoff do primeiro');
});

// ------------------------------------------------- desligada, mas registrando

test('Serena desligada: a mensagem é registrada, nada é despachado, e o silêncio fica auditado', async () => {
  const { repositorio, orquestrador, serena, atendimento } = montar({ comSerena: true });

  await serena.definirAtiva(false, { motivo: 'ensaio de segurança' });
  const resultado = await atendimento.receberMensagem(EVENTO);

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'serena_desligada');
  assert.equal(orquestrador.despachos.length, 0);

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1,
    'desligar cala a resposta, não o inbox');
  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'automacao_silenciada'
    && registro.detalhe?.motivo === 'serena_desligada'));
});

test('religada, a Serena responde ao PRÓXIMO inbound — nunca reprocessa o que chegou desligada', async () => {
  const { repositorio, orquestrador, serena, atendimento } = montar({ comSerena: true });

  await serena.definirAtiva(false, { motivo: 'ensaio' });
  await atendimento.receberMensagem(EVENTO);
  await serena.definirAtiva(true);

  assert.equal(orquestrador.despachos.length, 0, 'religar não dispara resposta retroativa');

  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:sintetico:5', texto: 'Ainda aí?' });
  assert.equal(orquestrador.despachos.length, 1, 'o novo inbound é atendido normalmente');
});
