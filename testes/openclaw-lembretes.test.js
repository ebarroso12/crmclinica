'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  criarAdaptadorDeLembretes, PROTOCOLO_CONFIRMADO, O_QUE_FALTA,
} = require('../src/integracoes/openclaw-lembretes');

// O adaptador é a única peça que sabe como um lembrete sai daqui.
//
// O teste mais importante deste arquivo é o que garante que ele **não inventa**:
// enquanto o envelope do protocolo do OpenClaw não estiver confirmado, pedir
// envio real falha com um erro nomeado, em vez de improvisar um formato e
// marcar como entregue algo que nunca chegou a ninguém.

const ENVELOPE = Object.freeze({
  referencia: 'lembrete:1',
  tipo: 'confirmacao_24h',
  canal: 'whatsapp',
  destinatario: '5516993120938',
  texto: 'Olá, Marina! Você tem horário amanhã, às 14:00.',
});

test('sem protocolo confirmado, o padrão é dry-run', () => {
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: () => {} });
  assert.equal(adaptador.modo, 'dry_run');
  assert.equal(adaptador.protocoloConfirmado, PROTOCOLO_CONFIRMADO);
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

test('pedir envio real sem protocolo confirmado falha em vez de improvisar', async () => {
  const adaptador = criarAdaptadorDeLembretes(
    { baseUrl: 'https://openclaw.exemplo', token: 'token-sintetico', modoEntrega: 'real' },
    { registrar: () => {} },
  );

  // Sem protocolo, o modo efetivo continua dry-run…
  assert.equal(adaptador.modo, 'dry_run');

  // …mas quem pediu 'real' recebe um erro nomeado, não uma simulação silenciosa.
  await assert.rejects(
    () => adaptador.enviar(ENVELOPE),
    (erro) => {
      assert.equal(erro.codigo, 'openclaw_protocolo_desconhecido');
      assert.equal(erro.permanente, true);
      assert.match(erro.message, /protocolo/);
      return true;
    },
  );
});

test('com protocolo e cliente injetados, o envio real acontece pelo cliente', async () => {
  const enviados = [];
  // Injeta o cliente que só existirá quando o protocolo for conhecido. Isto
  // prova que o caminho real está montado — falta só o cliente de verdade.
  const adaptador = criarAdaptadorDeLembretes(
    { baseUrl: 'https://openclaw.exemplo', token: 'token-sintetico', modoEntrega: 'real' },
    {
      registrar: () => {},
      enviarReal: async (envelope) => { enviados.push(envelope); return { referencia: 'msg-77' }; },
    },
  );

  if (!PROTOCOLO_CONFIRMADO) {
    // Enquanto a constante for falsa, o adaptador recusa mesmo com cliente.
    // É deliberado: o cliente sozinho não prova que o envelope está certo.
    await assert.rejects(() => adaptador.enviar(ENVELOPE), /protocolo/);
    assert.equal(enviados.length, 0);
    return;
  }

  const resultado = await adaptador.enviar(ENVELOPE);
  assert.equal(resultado.entregue, true);
  assert.equal(resultado.modo, 'real');
  assert.equal(resultado.referencia, 'msg-77');
  assert.equal(enviados.length, 1);
});

test('envelope sem destinatário ou sem texto é erro permanente', async () => {
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: () => {} });

  for (const [campo, envelope] of [
    ['destinatario', { ...ENVELOPE, destinatario: null }],
    ['texto', { ...ENVELOPE, texto: '' }],
  ]) {
    await assert.rejects(() => adaptador.enviar(envelope), (erro) => {
      assert.equal(erro.permanente, true, `${campo} ausente deveria ser permanente`);
      return true;
    });
  }
});

test('campo a mais no envelope é barrado antes de sair', async () => {
  const adaptador = criarAdaptadorDeLembretes({}, { registrar: () => {} });

  // A barreira que impede um dado clínico de atravessar por descuido no futuro.
  await assert.rejects(
    () => adaptador.enviar({ ...ENVELOPE, observacoes: 'suspeita de X' }),
    (erro) => {
      assert.equal(erro.codigo, 'envelope_invalido');
      assert.match(erro.message, /observacoes/);
      return true;
    },
  );
});

test('a descrição diz o modo, o motivo e o que falta — sem nenhum segredo', () => {
  const adaptador = criarAdaptadorDeLembretes(
    { baseUrl: 'https://openclaw.exemplo', token: 'token-super-secreto' },
    { registrar: () => {} },
  );

  const descricao = adaptador.descrever();
  assert.equal(descricao.orquestrador, 'OpenClaw');
  assert.equal(descricao.modo, 'dry_run');
  assert.equal(descricao.credenciado, true);
  assert.deepEqual(descricao.falta, O_QUE_FALTA);
  assert.doesNotMatch(JSON.stringify(descricao), /token-super-secreto/);
});
