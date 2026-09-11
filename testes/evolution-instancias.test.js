'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarEventoEvolution, normalizarEcoDeEnvioEvolution } = require('../src/integracoes/evolution-webhook');
const { criarClienteEvolucaoEnvio } = require('../src/integracoes/evolution-envio');
const { criarCanalDeConversas } = require('../src/integracoes/canal-conversas');
const { validarEvento } = require('../src/contratos/evento');
const { ErroDeContrato } = require('../src/contratos/erros');

// Evolution com várias instâncias (docs/AGENTES.md): cada agente tem o número
// dele numa instância própria. Isto prova tradução, contrato e roteamento de
// envio com clientes FALSOS — nenhuma chamada real à Evolution, nenhum número
// real. Não prova que a Evolution de produção manda `instance` no webhook
// (confirmar ao configurar a instância do agente).

function payload({ instancia = 'clinica', fromMe = false, id = '3EB0BBBB' } = {}) {
  return {
    event: 'messages.upsert',
    instance: instancia,
    data: {
      key: { remoteJid: '5516991234567@s.whatsapp.net', fromMe, id },
      pushName: 'Cliente Teste',
      message: { conversation: 'quero saber do tênis' },
      messageTimestamp: 1757500000,
    },
  };
}

test('sem instanciaPadrao o id_externo é o de sempre, mesmo com instance de agente no payload', () => {
  const normalizado = normalizarEventoEvolution(payload({ instancia: 'alpins' }));
  assert.equal(normalizado.id_externo, 'whatsapp:5516991234567:3EB0BBBB',
    'mudar o formato aqui quebraria a deduplicação com a ponte do OpenClaw');
  assert.equal(normalizado.instancia, 'alpins');
});

test('na instância padrão o id_externo não muda', () => {
  const normalizado = normalizarEventoEvolution(payload({ instancia: 'clinica' }), { instanciaPadrao: 'clinica' });
  assert.equal(normalizado.id_externo, 'whatsapp:5516991234567:3EB0BBBB');
  assert.equal(normalizado.instancia, 'clinica');
});

test('numa instância de agente o id_externo é escopado pela instância', () => {
  const normalizado = normalizarEventoEvolution(payload({ instancia: 'alpins' }), { instanciaPadrao: 'clinica' });
  assert.equal(normalizado.id_externo, 'whatsapp:alpins:5516991234567:3EB0BBBB');
});

test('sem id nativo, o fallback também carrega a instância do agente', () => {
  const semId = payload({ instancia: 'alpins', id: '' });
  const normalizado = normalizarEventoEvolution(semId, { instanciaPadrao: 'clinica' });
  assert.match(normalizado.id_externo, /^evolution:alpins:5516991234567\|/);

  const daClinica = normalizarEventoEvolution(payload({ instancia: 'clinica', id: '' }), { instanciaPadrao: 'clinica' });
  assert.match(daClinica.id_externo, /^evolution:5516991234567\|/);
});

test('payload sem instance devolve instancia null', () => {
  const semInstancia = payload();
  delete semInstancia.instance;
  assert.equal(normalizarEventoEvolution(semInstancia).instancia, null);
});

test('o eco fromMe carrega a instância e mantém o id_provedor de sempre', () => {
  const eco = normalizarEcoDeEnvioEvolution(payload({ instancia: 'alpins', fromMe: true }));
  assert.equal(eco.instancia, 'alpins');
  assert.equal(eco.id_provedor, 'whatsapp:5516991234567:3EB0BBBB');
});

test('o contrato aceita instancia sem mudar a chave de idempotência', () => {
  const base = { canal: 'whatsapp', id_externo: 'whatsapp:1:X', remetente: '5516991234567', texto: 'oi' };
  const sem = validarEvento(base);
  const com = validarEvento({ ...base, instancia: 'alpins' });

  assert.equal(sem.instancia, null);
  assert.equal(com.instancia, 'alpins');
  assert.equal(com.chave_idempotencia, sem.chave_idempotencia);

  assert.throws(() => validarEvento({ ...base, instancia: 'x'.repeat(101) }), (erro) => erro instanceof ErroDeContrato && erro.campo === 'instancia');
  assert.throws(() => validarEvento({ ...base, instancia: 42 }), (erro) => erro.campo === 'instancia');
});

test('a instância normalizada pelo webhook atravessa o contrato', () => {
  const evento = validarEvento(normalizarEventoEvolution(payload({ instancia: 'alpins' }), { instanciaPadrao: 'clinica' }));
  assert.equal(evento.instancia, 'alpins');
});

function fetchFalso() {
  const chamadas = [];
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return new Response(JSON.stringify({ key: { id: 'MSG-1' } }), { status: 201 });
  };
  fetchImpl.chamadas = chamadas;
  return fetchImpl;
}

const CONFIG = Object.freeze({ apiUrl: 'https://evo.exemplo.com', apiKey: 'chave-sintetica', instancia: 'clinica' });

test('envio de texto usa a instância do agente na URL; sem ela, a da clínica', async () => {
  const fetchImpl = fetchFalso();
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await cliente.enviar({ telefone: '5516991234567', texto: 'oi', instancia: 'alpins' });
  await cliente.enviar({ telefone: '5516991234567', texto: 'oi' });
  await cliente.enviar({ telefone: '5516991234567', texto: 'oi', instancia: 'loja alpins' });

  assert.equal(fetchImpl.chamadas[0].url, 'https://evo.exemplo.com/message/sendText/alpins');
  assert.equal(fetchImpl.chamadas[1].url, 'https://evo.exemplo.com/message/sendText/clinica');
  assert.equal(fetchImpl.chamadas[2].url, 'https://evo.exemplo.com/message/sendText/loja%20alpins');
});

test('envio de mídia usa a instância do agente na URL', async () => {
  const fetchImpl = fetchFalso();
  const cliente = criarClienteEvolucaoEnvio(CONFIG, { fetchImpl });

  await cliente.enviarMidia({
    telefone: '5516991234567', mediaUrl: 'https://arquivo.exemplo/x.jpg', tipo: 'imagem', instancia: 'alpins',
  });
  assert.equal(fetchImpl.chamadas[0].url, 'https://evo.exemplo.com/message/sendMedia/alpins');
});

function gatewayQueRegistra() {
  const chamadas = [];
  return {
    chamadas,
    async chamar(metodo, parametros) {
      chamadas.push({ metodo, parametros });
      return { messageId: 'gw-da-clinica' };
    },
    async encerrar() {},
  };
}

test('com instância informada, a Evolution recebe a instância', async () => {
  const recebidos = [];
  const evolucao = {
    disponivel: true,
    async enviar(argumentos) { recebidos.push(argumentos); return { identificador: 'evo-agente' }; },
  };
  const cliente = gatewayQueRegistra();
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });

  const resultado = await canal.enviar({ telefone: '(16) 99123-4567', texto: 'oi', chave: 'k', instancia: 'alpins' });
  assert.equal(resultado.identificador, 'evo-agente');
  assert.equal(recebidos[0].instancia, 'alpins');
  assert.equal(recebidos[0].telefone, '5516991234567', 'normalizado com DDI, igual ao caminho da clínica');
  assert.equal(cliente.chamadas.length, 0);
});

test('INVARIANTE: falha da Evolution com instância de agente NUNCA cai no gateway da clínica', async () => {
  const evolucao = { disponivel: true, async enviar() { throw new Error('instância alpins desconectada'); } };
  const cliente = gatewayQueRegistra();
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });

  await assert.rejects(
    () => canal.enviar({ telefone: '5516991234567', texto: 'oi', chave: 'k', instancia: 'alpins' }),
    /instância alpins desconectada/,
  );
  assert.equal(cliente.chamadas.length, 0, 'o gateway do OpenClaw é o WhatsApp da clínica');
});

test('INVARIANTE: timeout (indeterminado) com instância sobe como indeterminado, sem reserva', async () => {
  const falha = new Error('timeout');
  falha.indeterminado = true;
  const evolucao = { disponivel: true, async enviar() { throw falha; } };
  const cliente = gatewayQueRegistra();
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });

  await assert.rejects(
    () => canal.enviar({ telefone: '5516991234567', texto: 'oi', chave: 'k', instancia: 'alpins' }),
    (erro) => erro.indeterminado === true,
  );
  assert.equal(cliente.chamadas.length, 0);
});

test('INVARIANTE: sem Evolution disponível, instância de agente é recusada sem tocar no gateway', async () => {
  const cliente = gatewayQueRegistra();
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao: { disponivel: false } });

  await assert.rejects(
    () => canal.enviar({ telefone: '5516991234567', texto: 'oi', chave: 'k', instancia: 'alpins' }),
    /instância dele/,
  );
  assert.equal(cliente.chamadas.length, 0);
});

test('INVARIANTE: Instagram com instância de agente é recusado (a conta daqui é da clínica)', async () => {
  const instagram = { disponivel: true, async enviar() { throw new Error('não deveria chamar'); } };
  const canal = criarCanalDeConversas({}, { instagram });

  await assert.rejects(
    () => canal.enviar({ canal: 'instagram', telefone: 'psid-1', texto: 'oi', chave: 'k', instancia: 'alpins' }),
    /Instagram de agente/,
  );
  await assert.rejects(
    () => canal.enviarMidia({ canal: 'instagram', telefone: 'psid-1', mediaUrl: 'https://x/y.jpg', tipo: 'imagem', instancia: 'alpins' }),
    /Instagram de agente|não é suportado/,
  );
});

test('sem instância, a Evolution falhando continua caindo no gateway (clínica inalterada)', async () => {
  const evolucao = { disponivel: true, async enviar() { throw new Error('instância clinica desconectada'); } };
  const cliente = gatewayQueRegistra();
  const canal = criarCanalDeConversas({ url: 'wss://gateway.exemplo/ws' }, { cliente, evolucao });

  const resultado = await canal.enviar({ telefone: '5516991234567', texto: 'oi', chave: 'k' });
  assert.equal(resultado.identificador, 'gw-da-clinica');
  assert.equal(cliente.chamadas.length, 1);
});

test('mídia com instância de agente vai pela Evolution com a instância', async () => {
  const recebidos = [];
  const evolucao = {
    disponivel: true,
    async enviarMidia(argumentos) { recebidos.push(argumentos); return { identificador: 'evo-midia' }; },
  };
  const canal = criarCanalDeConversas({}, { evolucao });

  await canal.enviarMidia({
    telefone: '5516991234567', mediaUrl: 'https://x/y.jpg', tipo: 'imagem', instancia: 'alpins',
  });
  assert.equal(recebidos[0].instancia, 'alpins');
});
