'use strict';

// Item pedido pelo Edson (2026-08-16): telefone na lista de bloqueio
// (db/040_contatos_bloqueados.sql) nunca recebe resposta da automação —
// cada mensagem que chega dele é respondida com uma mensagem fixa,
// direcionando para a secretária humana, sem revelar que está bloqueado.
//
// O ponto crítico a provar: a automação (orquestrador/Serena) NUNCA é
// acionada para esse contato — não é "responde rápido com IA também",
// é "nunca deixa a IA nem tentar".

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

const TELEFONE_BLOQUEADO = '5511996026888';
const TELEFONE_NORMAL = '5516999999999';

function canalFalso() {
  const envios = [];
  return { envios, async enviar(carga) { envios.push(carga); return { identificador: 'wa-1' }; } };
}

function orquestradorFalso() {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    async despacharEvento(carga) {
      despachos.push(carga);
      return { resposta: 'resposta gerada pela automação' };
    },
  };
}

test('mensagem de telefone bloqueado: automação nunca é acionada, resposta fixa sai direto', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.criarContatoBloqueado({
    telefone: TELEFONE_BLOQUEADO,
    nome: 'Marciandrea',
    motivo: 'Solicitou retorno após 3 meses; disse que vai fazer denúncia em USI.',
  });

  const orquestrador = orquestradorFalso();
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal });

  const resultado = await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:bloqueio:1',
    remetente: TELEFONE_BLOQUEADO,
    nome: 'Marciandrea',
    texto: 'Oi, quero marcar retorno',
  });

  assert.equal(orquestrador.despachos.length, 0, 'a automação nunca pode ser chamada para contato bloqueado');
  assert.equal(canal.envios.length, 1, 'a mensagem fixa precisa sair de verdade');
  assert.match(canal.envios[0].texto, /secretária/i, 'a mensagem precisa direcionar para a secretária');
  assert.doesNotMatch(canal.envios[0].texto, /bloque/i, 'a mensagem não pode revelar que o contato está bloqueado');
  assert.equal(resultado.acao, 'contato_bloqueado_direcionado');
});

test('segunda mensagem do mesmo telefone bloqueado também recebe a resposta fixa — não só a primeira', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.criarContatoBloqueado({
    telefone: TELEFONE_BLOQUEADO, nome: 'Marciandrea', motivo: 'teste',
  });

  const orquestrador = orquestradorFalso();
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal });

  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:bloqueio:2a',
    remetente: TELEFONE_BLOQUEADO, nome: 'Marciandrea', texto: 'primeira mensagem',
  });
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:bloqueio:2b',
    remetente: TELEFONE_BLOQUEADO, nome: 'Marciandrea', texto: 'segunda mensagem, dias depois',
  });

  assert.equal(orquestrador.despachos.length, 0, 'nenhuma das duas mensagens pode acionar a automação');
  assert.equal(canal.envios.length, 2, 'cada mensagem recebida precisa gerar sua própria resposta fixa');
});

test('telefone NÃO bloqueado continua acionando a automação normalmente', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.criarContatoBloqueado({
    telefone: TELEFONE_BLOQUEADO, nome: 'Marciandrea', motivo: 'teste',
  });

  const orquestrador = orquestradorFalso();
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal });

  const resultado = await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:normal:1',
    remetente: TELEFONE_NORMAL, nome: 'Paciente Normal', texto: 'Quero agendar consulta',
  });

  assert.equal(orquestrador.despachos.length, 1, 'contato não bloqueado precisa acionar a automação normalmente');
  assert.notEqual(resultado.acao, 'contato_bloqueado_direcionado');
});
