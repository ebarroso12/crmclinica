'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validarEvento, validarEventoMensagem, calcularChaveIdempotencia, LIMITES } = require('../src/contratos/evento');
const { ErroDeContrato } = require('../src/contratos/erros');

test('normaliza um evento de mensagem e calcula a chave de idempotência', () => {
  const evento = validarEvento({
    tipo: 'mensagem.recebida',
    canal: 'WhatsApp',
    id_externo: '  wa:9821  ',
    remetente: '5516993120938',
    texto: '  Olá, quero saber sobre a primeira consulta  ',
    nome: 'Marina Souza',
    ocorrido_em: '2026-08-01T12:00:00.000Z',
  });

  assert.equal(evento.canal, 'whatsapp');
  assert.equal(evento.id_externo, 'wa:9821');
  assert.equal(evento.texto, 'Olá, quero saber sobre a primeira consulta');
  assert.equal(evento.ocorrido_em, '2026-08-01T12:00:00.000Z');
  assert.equal(evento.origem, null);
  assert.match(evento.chave_idempotencia, /^[0-9a-f]{64}$/);
});

test('a chave de idempotência depende da identidade, não do conteúdo', () => {
  const base = { canal: 'whatsapp', id_externo: 'wa:1', remetente: '551199', tipo: 'mensagem.recebida' };

  const primeiro = validarEvento({ ...base, texto: 'texto original' });
  const reenvio = validarEvento({ ...base, texto: 'texto corrigido', nome: 'Outro nome' });
  assert.equal(primeiro.chave_idempotencia, reenvio.chave_idempotencia);

  // Trocar canal, tipo ou id externo produz outro evento.
  const outroCanal = validarEvento({ ...base, canal: 'site', texto: 'texto original' });
  const outroId = validarEvento({ ...base, id_externo: 'wa:2', texto: 'texto original' });
  assert.notEqual(primeiro.chave_idempotencia, outroCanal.chave_idempotencia);
  assert.notEqual(primeiro.chave_idempotencia, outroId.chave_idempotencia);
});

test('a chave é estável entre execuções', () => {
  const chave = calcularChaveIdempotencia({ canal: 'whatsapp', tipo: 'mensagem.recebida', idExterno: 'wa:1' });
  assert.equal(chave, calcularChaveIdempotencia({ canal: 'whatsapp', tipo: 'mensagem.recebida', idExterno: 'wa:1' }));
});

test('recusa entradas fora do contrato', () => {
  const casos = [
    [{}, /canal/],
    [{ canal: 'telepatia', id_externo: '1', remetente: 'a', texto: 'oi' }, /canal/],
    [{ canal: 'whatsapp', remetente: 'a', texto: 'oi' }, /id_externo/],
    [{ canal: 'whatsapp', id_externo: '1', texto: 'oi' }, /remetente/],
    [{ canal: 'whatsapp', id_externo: '1', remetente: 'a' }, /texto/],
    [{ canal: 'whatsapp', id_externo: '1', remetente: 'a', texto: 'oi', tipo: 'inventado' }, /tipo/],
    [{ canal: 'whatsapp', id_externo: '1', remetente: 'a', texto: 'oi', ocorrido_em: 'ontem' }, /ocorrido_em/],
    ['isto não é objeto', /objeto/],
    [[], /objeto/],
  ];

  for (const [entrada, padrao] of casos) {
    assert.throws(() => validarEvento(entrada), ErroDeContrato, `deveria recusar: ${JSON.stringify(entrada)}`);
    assert.throws(() => validarEvento(entrada), padrao);
  }
});

test('recusa texto acima do limite', () => {
  assert.throws(
    () => validarEvento({
      canal: 'whatsapp',
      id_externo: 'wa:1',
      remetente: '551199',
      texto: 'a'.repeat(LIMITES.texto + 1),
    }),
    /texto/,
  );
});

test('tipos sem corpo não exigem texto', () => {
  const lead = validarEvento({
    tipo: 'lead.criado',
    canal: 'site',
    id_externo: 'form:33',
    remetente: 'contato@exemplo.com',
    origem: 'landing-page',
  });
  assert.equal(lead.texto, null);
  assert.equal(lead.origem, 'landing-page');
});

test('o atalho de mensagem continua funcionando', () => {
  const evento = validarEventoMensagem({
    canal: 'whatsapp',
    id_externo: 'wa:1',
    remetente: '551199',
    texto: 'Olá',
  });
  assert.equal(evento.tipo, 'mensagem.recebida');
});
