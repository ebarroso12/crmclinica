'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// Prova das regras do achado de 2026-08-17 (pedido do Dr. Edson: a tela
// precisa mostrar toda mensagem de saída — da Serena, da equipe pelo
// painel, e da equipe respondendo direto pelo WhatsApp, não só o que passou
// pelo CRM):
//
//   1. um envio bem-sucedido pelo CRM (equipe ou automação) marca o ID
//      nativo do provedor na mensagem já gravada;
//   2. uma mensagem enviada por FORA do CRM (WhatsApp Web/app direto) é
//      registrada como enviada pela equipe quando o ID nativo chega;
//   3. o eco de um envio que o PRÓPRIO CRM fez não vira uma segunda linha —
//      é este o bug original: `fromMe:true` era descartado sem distinguir
//      "eco do meu envio" de "mensagem enviada por fora".

/** Canal simulado que devolve um identificador nativo, como a Evolution faz. */
function canalFalso() {
  const envios = [];
  return {
    envios,
    enviar: async ({ telefone, texto, chave }) => {
      envios.push({ telefone, texto, chave });
      return { identificador: `NATIVO-${envios.length}` };
    },
  };
}

function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, canal });
  return { repositorio, canal, atendimento };
}

test('responderComoEquipe: envio bem-sucedido marca o id_provedor na mensagem gravada', async () => {
  const { repositorio, atendimento } = montar();

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990000', nome: 'Fran' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

  const resultado = await atendimento.responderComoEquipe(conversa.id, 'Pode vir amanhã às 14h', {
    autorNome: 'Tatiana',
  });

  assert.equal(resultado.enviada, true);

  const mensagens = await repositorio.listarMensagens(conversa.id);
  const gravada = mensagens.find((m) => m.id === resultado.id);
  assert.equal(gravada.id_provedor, 'whatsapp:5516999990000:NATIVO-1');
});

test('registrarEnvioExternoDoWhatsapp: mensagem enviada por fora (WhatsApp Web/app) vira mensagem de SAÍDA visível', async () => {
  const { repositorio, atendimento } = montar();

  const resultado = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516988880000',
    texto: 'Já te respondo',
    idProvedor: 'whatsapp:5516988880000:EXTERNO-1',
  });

  assert.equal(resultado.acao, 'mensagem_externa_registrada');

  const mensagens = await repositorio.listarMensagens(resultado.conversa_id);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0].direcao, 'saida');
  assert.equal(mensagens[0].autor_tipo, 'equipe');
  assert.equal(mensagens[0].conteudo, 'Já te respondo');
  assert.equal(mensagens[0].id_provedor, 'whatsapp:5516988880000:EXTERNO-1');
});

test('cria contato e conversa quando a mensagem externa é a primeira coisa que se sabe sobre esse número', async () => {
  const { repositorio, atendimento } = montar();

  const resultado = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516977770000',
    texto: 'Oi, tudo certo pra amanhã',
    idProvedor: 'whatsapp:5516977770000:PRIMEIRO-1',
  });

  assert.ok(resultado.conversa_id, 'uma conversa foi criada do zero, a partir só do envio externo');
  const conversa = await repositorio.obterConversa(resultado.conversa_id);
  const contato = await repositorio.obterContato(conversa.contato_id);
  assert.equal(contato.telefone, '5516977770000');
});

test('O ECO de uma mensagem que o PRÓPRIO CRM enviou não vira uma segunda linha (o bug original)', async () => {
  const { repositorio, atendimento } = montar();

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516966660000', nome: 'Paciente' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

  // 1) A equipe responde PELO CRM — o canal falso devolve NATIVO-1, e
  //    entregarAoPaciente marca isso na mensagem.
  const enviada = await atendimento.responderComoEquipe(conversa.id, 'Confirmado para as 14h', {
    autorNome: 'Tatiana',
  });
  assert.equal(enviada.enviada, true);

  const antesDoEco = await repositorio.listarMensagens(conversa.id);
  // responderComoEquipe grava DUAS linhas: o aviso de sistema de "conversa
  // assumida" (assumir()) e a resposta em si — a que carrega id_provedor.
  assert.equal(antesDoEco.length, 2);
  const respostaGravada = antesDoEco.find((m) => m.autor_tipo === 'equipe');
  assert.equal(respostaGravada.id_provedor, 'whatsapp:5516966660000:NATIVO-1');

  // 2) A Evolution manda de volta o eco `fromMe:true` dessa MESMA mensagem —
  //    normalizarEcoDeEnvioEvolution já produziria
  //    id_provedor = 'whatsapp:5516966660000:NATIVO-1', EXATAMENTE o que foi
  //    marcado no passo 1.
  const eco = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516966660000',
    texto: 'Confirmado para as 14h',
    idProvedor: 'whatsapp:5516966660000:NATIVO-1',
  });

  assert.equal(eco.acao, 'eco_ja_registrado', 'reconhecido como eco do próprio envio, não como mensagem nova');
  assert.equal(eco.mensagem_id, respostaGravada.id, 'o eco resolve para a MESMA mensagem já gravada');

  const depoisDoEco = await repositorio.listarMensagens(conversa.id);
  assert.equal(depoisDoEco.length, 2, 'nenhuma linha nova — sem isto, toda resposta da equipe apareceria em dobro');
});

test('duas mensagens externas diferentes, mesmo telefone, não colidem entre si', async () => {
  const { repositorio, atendimento } = montar();

  const primeira = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516955550000',
    texto: 'Mensagem um',
    idProvedor: 'whatsapp:5516955550000:A',
  });
  const segunda = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516955550000',
    texto: 'Mensagem dois',
    idProvedor: 'whatsapp:5516955550000:B',
  });

  assert.equal(primeira.acao, 'mensagem_externa_registrada');
  assert.equal(segunda.acao, 'mensagem_externa_registrada');
  assert.equal(primeira.conversa_id, segunda.conversa_id, 'mesma conversa, mesmo contato');

  const mensagens = await repositorio.listarMensagens(primeira.conversa_id);
  assert.equal(mensagens.length, 2);
});
