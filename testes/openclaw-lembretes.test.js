'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  criarAdaptadorDeLembretes, ErroDeEntrega, chaveDeIdempotencia, extrairIdentificador,
} = require('../src/integracoes/openclaw-lembretes');
const { ErroDeGateway } = require('../src/integracoes/openclaw-gateway');

// O adaptador é a única peça que sabe como um lembrete sai daqui.
//
// O método é `send`, RPC do gateway OpenClaw — o mesmo que o comando oficial
// `openclaw message send` usa. Aqui o cliente é injetado, então o caminho real
// inteiro é exercitado sem abrir socket nenhum e sem mandar mensagem a ninguém.
//
// O teste mais importante deste arquivo é o que garante que "enviado" nunca é
// dito sem confirmação: timeout, queda de conexão e resposta sem identificador
// viram falha, não sucesso.

const ENVELOPE = Object.freeze({
  referencia: 'lembrete:1',
  tipo: 'confirmacao_24h',
  canal: 'whatsapp',
  destinatario: '5516993120938',
  texto: 'Olá, Marina! Você tem horário amanhã, às 14:00.',
});

const GATEWAY = Object.freeze({
  url: 'wss://openclaw.exemplo/ws',
  token: 'token-sintetico-de-teste',
  canal: 'whatsapp',
  timeoutMs: 5000,
});

/** Cliente de gateway simulado: registra as chamadas e devolve o que mandarem. */
function clienteFalso({ resposta = { messageId: 'msg-1' }, erro = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async chamar(metodo, params) {
      chamadas.push({ metodo, params });
      if (erro) throw typeof erro === 'function' ? erro(chamadas.length) : erro;
      return typeof resposta === 'function' ? resposta(chamadas.length, params) : resposta;
    },
    async encerrar() {},
  };
}

function adaptadorReal(opcoes = {}, dependencias = {}) {
  return criarAdaptadorDeLembretes(
    { gateway: GATEWAY, modoEntrega: 'real', ...opcoes },
    { registrar: () => {}, cliente: clienteFalso(), ...dependencias },
  );
}

// ---------------------------------------------------------------- dry-run

test('sem gateway configurado, o padrão é dry-run', () => {
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: () => {} });
  assert.equal(adaptador.modo, 'dry_run');
  assert.match(adaptador.descrever().motivo, /OPENCLAW_GATEWAY_URL/);
});

test('em dry-run o envio não afirma que entregou', async () => {
  const registros = [];
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: (m, d) => registros.push([m, d]) });

  const resultado = await adaptador.enviar(ENVELOPE);

  assert.equal(resultado.entregue, false, 'dry-run nunca pode dizer que entregou');
  assert.equal(resultado.modo, 'dry_run');
  assert.match(resultado.referencia, /^dry-run:/);
  assert.equal(registros.length, 1);
});

test('nem o log despeja telefone ou texto do paciente', async () => {
  const registros = [];
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: (m, d) => registros.push(d) });
  await adaptador.enviar(ENVELOPE);

  const [dados] = registros;
  assert.equal(dados.destinatario, '***0938');
  assert.equal(dados.caracteres, ENVELOPE.texto.length);
  assert.equal(dados.texto, undefined, 'o texto não vai para o log');
});

test('pedir envio real sem gateway falha em vez de simular em silêncio', async () => {
  const adaptador = criarAdaptadorDeLembretes({ modoEntrega: 'real' }, { registrar: () => {} });
  assert.equal(adaptador.modo, 'dry_run');

  await assert.rejects(() => adaptador.enviar(ENVELOPE), (erro) => {
    assert.equal(erro.codigo, 'openclaw_indisponivel');
    assert.equal(erro.permanente, true);
    return true;
  });
});

test('canal não suportado não vira envio às cegas', () => {
  const adaptador = criarAdaptadorDeLembretes(
    { gateway: { ...GATEWAY, canal: 'telegram' }, modoEntrega: 'real' },
    { registrar: () => {}, cliente: clienteFalso() },
  );
  assert.equal(adaptador.modo, 'dry_run');
  assert.match(adaptador.descrever().motivo, /telegram/);
});

// ---------------------------------------------------------------- envio real

test('em modo real o envio usa o método oficial "send" do gateway', async () => {
  const cliente = clienteFalso({ resposta: { messageId: '3EB0ABC' } });
  const adaptador = adaptadorReal({}, { cliente });

  const resultado = await adaptador.enviar(ENVELOPE);

  assert.equal(resultado.entregue, true);
  assert.equal(resultado.modo, 'real');
  // A referência guardada é o identificador que o canal devolveu, não um id nosso.
  assert.equal(resultado.referencia, '3EB0ABC');

  assert.equal(cliente.chamadas.length, 1);
  const [{ metodo, params }] = cliente.chamadas;
  assert.equal(metodo, 'send');
  // Exatamente os campos do SendParamsSchema — o gateway recusa qualquer outro.
  assert.deepEqual(Object.keys(params).sort(), ['channel', 'idempotencyKey', 'message', 'to']);
  assert.equal(params.to, ENVELOPE.destinatario);
  assert.equal(params.message, ENVELOPE.texto);
  assert.equal(params.channel, 'whatsapp');
});

test('a chave de idempotência é determinística — é o que impede duplicata no gateway', () => {
  // O gateway deduplica por esta chave. Se ela fosse aleatória, o retry de um
  // lembrete que já saiu mandaria a mensagem de novo.
  const primeira = chaveDeIdempotencia(ENVELOPE);
  const segunda = chaveDeIdempotencia({ ...ENVELOPE });

  assert.equal(primeira, segunda);
  assert.match(primeira, /^crmclinica:[0-9a-f]{32}$/);

  // Lembrete diferente, chave diferente.
  assert.notEqual(primeira, chaveDeIdempotencia({ ...ENVELOPE, referencia: 'lembrete:2' }));
  // Mesmo lembrete, outro destinatário: também é outra entrega.
  assert.notEqual(primeira, chaveDeIdempotencia({ ...ENVELOPE, destinatario: '5511999990000' }));
});

test('a conta é declarada quando configurada, e omitida quando não', async () => {
  const comConta = clienteFalso();
  await criarAdaptadorDeLembretes(
    { gateway: { ...GATEWAY, contaId: 'principal' }, modoEntrega: 'real' },
    { registrar: () => {}, cliente: comConta },
  ).enviar(ENVELOPE);
  assert.equal(comConta.chamadas[0].params.accountId, 'principal');

  const semConta = clienteFalso();
  await adaptadorReal({}, { cliente: semConta }).enviar(ENVELOPE);
  assert.ok(!('accountId' in semConta.chamadas[0].params));
});

// ---------------------------------------------------------------- confirmação

test('resposta sem identificador de mensagem NÃO conta como entregue', async () => {
  // O caso que este teste existe para impedir: o gateway responde `ok` mas sem
  // prova de entrega, e a fila marca "enviado" para uma mensagem que ninguém
  // recebeu. Vira falha com retry — e a idempotência impede duplicar.
  const cliente = clienteFalso({ resposta: { aceito: true } });
  const adaptador = adaptadorReal({}, { cliente });

  await assert.rejects(() => adaptador.enviar(ENVELOPE), (erro) => {
    assert.equal(erro.codigo, 'entrega_nao_confirmada');
    assert.equal(erro.permanente, false, 'sem confirmação, vale tentar de novo');
    return true;
  });
});

test('timeout do gateway nunca vira "enviado"', async () => {
  const cliente = clienteFalso({
    erro: new ErroDeGateway('sem resposta do gateway para "send"', 'gateway_timeout'),
  });
  const adaptador = adaptadorReal({}, { cliente });

  await assert.rejects(() => adaptador.enviar(ENVELOPE), (erro) => {
    assert.equal(erro.codigo, 'gateway_timeout');
    // Incerteza é para tentar de novo, não para desistir: a mensagem pode não
    // ter saído, e a chave de idempotência protege o reenvio.
    assert.equal(erro.permanente, false);
    return true;
  });
});

test('dispositivo não pareado é falha permanente — retry não resolve', async () => {
  const cliente = clienteFalso({
    erro: new ErroDeGateway('pairing required', 'openclaw_nao_pareado', { permanente: true }),
  });
  const adaptador = adaptadorReal({}, { cliente });

  await assert.rejects(() => adaptador.enviar(ENVELOPE), (erro) => {
    assert.equal(erro.permanente, true, 'alguém precisa aprovar o dispositivo; insistir só gasta tentativa');
    return true;
  });
});

test('extrairIdentificador aceita as formas que os canais devolvem', () => {
  assert.equal(extrairIdentificador({ messageId: 'a' }), 'a');
  assert.equal(extrairIdentificador({ id: 'b' }), 'b');
  assert.equal(extrairIdentificador({ guid: 'c' }), 'c');
  assert.equal(extrairIdentificador({ toJid: '5516@s.whatsapp.net' }), '5516@s.whatsapp.net');
  assert.equal(extrairIdentificador({ id: 42 }), '42');
  // Nada que sirva de prova → null, e o adaptador trata como não confirmado.
  assert.equal(extrairIdentificador({ ok: true }), null);
  assert.equal(extrairIdentificador(null), null);
  assert.equal(extrairIdentificador({ messageId: '   ' }), null);
});

// ---------------------------------------------------------------- envelope

test('envelope sem destinatário ou sem texto é erro permanente', async () => {
  const adaptador = adaptadorReal();

  for (const envelope of [{ ...ENVELOPE, destinatario: null }, { ...ENVELOPE, texto: '' }]) {
    await assert.rejects(() => adaptador.enviar(envelope), (erro) => {
      assert.equal(erro.permanente, true);
      return true;
    });
  }
});

test('campo a mais no envelope é barrado antes de sair', async () => {
  const cliente = clienteFalso();
  const adaptador = adaptadorReal({}, { cliente });

  // A barreira que impede um dado clínico de atravessar por descuido no futuro.
  await assert.rejects(
    () => adaptador.enviar({ ...ENVELOPE, observacoes: 'suspeita de X' }),
    (erro) => {
      assert.equal(erro.codigo, 'envelope_invalido');
      assert.match(erro.message, /observacoes/);
      return true;
    },
  );
  assert.equal(cliente.chamadas.length, 0, 'nada pode chegar ao gateway');
});

// ---------------------------------------------------------------- estado do canal

test('o estado do canal vem do gateway, sem enviar nada', async () => {
  const cliente = clienteFalso({
    resposta: { channels: { whatsapp: { connected: true, linked: true, self: { e164: '+5516997433914' } } } },
  });
  const adaptador = adaptadorReal({}, { cliente });

  const estado = await adaptador.verificarCanal();

  assert.equal(estado.disponivel, true);
  assert.equal(estado.conectado, true);
  assert.equal(estado.numero, '+5516997433914');
  assert.equal(cliente.chamadas[0].metodo, 'channels.status');
});

test('canal desconectado é reportado, não escondido', async () => {
  const cliente = clienteFalso({ resposta: { channels: { whatsapp: { connected: false, linked: true } } } });
  const estado = await adaptadorReal({}, { cliente }).verificarCanal();

  assert.equal(estado.disponivel, false);
  assert.equal(estado.conectado, false);
});

test('a descrição diz modo, método e dispositivo — sem nenhum segredo', () => {
  const adaptador = adaptadorReal();
  const descricao = adaptador.descrever();

  assert.equal(descricao.orquestrador, 'OpenClaw');
  assert.equal(descricao.modo, 'real');
  assert.equal(descricao.metodo, 'gateway.send');
  assert.match(descricao.significado, /saem de verdade/);
  assert.doesNotMatch(JSON.stringify(descricao), /token-sintetico-de-teste/);
});
