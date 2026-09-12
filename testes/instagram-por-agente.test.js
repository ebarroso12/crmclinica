'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizarComentariosInstagram } = require('../src/integracoes/instagram-webhook');
const { criarRoteadorDeInstagram } = require('../src/integracoes/instagram-envio');
const { criarServicoDeGatilhos } = require('../src/dominio/instagram-gatilhos');

// Instagram por agente (migration 049): a loja Alpins tem perfil próprio.
//
// A clínica e a loja chegam na MESMA URL de webhook — a Meta não separa por
// URL, só diz em `entry[].id` qual conta recebeu. O que estes testes protegem,
// em ordem de gravidade:
//
//   1. responder pela conta CERTA. Publicar a resposta da clínica no post da
//      loja (ou o contrário) é erro visível para o público;
//   2. a regra de um perfil não dispara no outro;
//   3. perfil desconhecido não é atendido pela conta da clínica "por
//      aproximação" — fica sem resposta, com rastro.

const CLINICA = '17841400000000001';
const ALPINS = '17841400000000002';

function eventoDeComentario(contaComercialId, texto, id = 'c1') {
  return {
    object: 'instagram',
    entry: [{
      id: contaComercialId,
      time: 1757000000,
      changes: [{
        field: 'comments',
        value: { id, text: texto, from: { id: '99887766', username: 'cliente.teste' }, media: { id: 'post1' } },
      }],
    }],
  };
}

const CONFIG = {
  accessToken: 'token-da-clinica',
  contaComercialId: CLINICA,
  apiVersion: 'v23.0',
  contas: [{ apelido: 'alpins', accessToken: 'token-da-loja', contaComercialId: ALPINS }],
};

// ---------------------------------------------------------------- webhook

test('o comentário carrega a conta que o recebeu', () => {
  const daClinica = normalizarComentariosInstagram(eventoDeComentario(CLINICA, 'quero agendar'), {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(daClinica.length, 1);
  assert.equal(daClinica[0].conta_comercial_id, CLINICA);

  const daLoja = normalizarComentariosInstagram(eventoDeComentario(ALPINS, 'qual o preço?'), {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(daLoja[0].conta_comercial_id, ALPINS,
    'sem isto, o comentário da loja seria tratado como se fosse da clínica');
});

test('cada perfil ignora o próprio comentário, não o do outro', () => {
  // A resposta pública que a automação da LOJA publica chega de volta como
  // comentário da loja. Antes, o corte comparava sempre com a conta da
  // clínica: a loja reagiria ao próprio comentário, em cadeia.
  const proprioDaLoja = {
    object: 'instagram',
    entry: [{
      id: ALPINS,
      time: 1757000000,
      changes: [{
        field: 'comments',
        value: { id: 'c9', text: 'oi, te chamei no direct!', from: { id: ALPINS }, media: { id: 'post1' } },
      }],
    }],
  };
  const saida = normalizarComentariosInstagram(proprioDaLoja, {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(saida.length, 0, 'o comentário da própria loja não pode reacionar a automação dela');
});

// ---------------------------------------------------------------- roteador

test('cada conta responde pelo próprio cliente', () => {
  const roteador = criarRoteadorDeInstagram(CONFIG, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });

  assert.equal(roteador.total, 2, 'clínica e loja');
  assert.ok(roteador.paraConta(CLINICA));
  assert.ok(roteador.paraConta(ALPINS));
  assert.notEqual(roteador.paraConta(CLINICA), roteador.paraConta(ALPINS), 'são clientes distintos');
  assert.equal(roteador.apelidoDaConta(ALPINS), 'alpins');
  assert.equal(roteador.apelidoDaConta(CLINICA), null, 'a clínica não tem apelido: é o perfil padrão');
});

test('conta desconhecida não cai na da clínica', () => {
  const roteador = criarRoteadorDeInstagram(CONFIG, {});
  assert.equal(roteador.paraConta('17841400000000999'), null,
    'responder pela conta errada publicaria a resposta da clínica no post de outro perfil');
  assert.equal(roteador.paraConta(null), null);
});

test('sem perfis extras, o comportamento é o de antes', () => {
  const roteador = criarRoteadorDeInstagram({ accessToken: 't', contaComercialId: CLINICA }, {});
  assert.equal(roteador.total, 1);
  assert.ok(roteador.paraConta(CLINICA));
});

// ---------------------------------------------------------------- gatilho

function repositorioFalso({ regras }) {
  const registros = [];
  const mensagens = [];
  return {
    registros,
    mensagens,
    async obterComentarioProcessado() { return null; },
    async listarRegrasDeGatilho({ agenteId }) {
      // Espelha a 049: `undefined` = todas; senão, só as do dono pedido.
      if (agenteId === undefined) return regras;
      return regras.filter((regra) => (regra.agente_id ?? null) === (agenteId ?? null));
    },
    async registrarComentarioProcessado(dados) { registros.push(dados); return { id: 1 }; },
    async encontrarOuCriarContato() { return { id: 10 }; },
    async encontrarOuCriarConversaAberta(contatoId, canal, opcoes) {
      mensagens.push({ tipo: 'conversa', agenteId: opcoes?.agenteId ?? null });
      return { id: 20 };
    },
    async registrarMensagem(conversaId, mensagem) { mensagens.push({ tipo: 'mensagem', ...mensagem }); },
    async salvarLead() { return { id: 30 }; },
    async obterAgente(id) { return { id, nome: 'Agente Alpins' }; },
    async registrarAuditoria() {},
  };
}

function envioFalso(nome) {
  const enviados = [];
  return {
    enviados,
    nome,
    async responderComentarioPublicamente(dados) { enviados.push({ tipo: 'publica', ...dados }); },
    async responderComentarioPrivadamente(dados) { enviados.push({ tipo: 'dm', ...dados }); },
  };
}

const REGRA_CLINICA = {
  id: 1, nome: 'Agendamento', palavra_gatilho: 'agendar', ativa: true, agente_id: null,
  mensagem_publica: 'Te chamamos no direct!', mensagem_dm: 'Olá! Vamos agendar sua consulta?', cta_whatsapp: false,
};
const REGRA_LOJA = {
  id: 2, nome: 'Preço', palavra_gatilho: 'preço, preco, valor', ativa: true, agente_id: 7,
  mensagem_publica: 'Respondemos no direct!', mensagem_dm: 'Oi! Sobre os valores da loja...', cta_whatsapp: false,
};

test('a regra da loja não dispara no post da clínica', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daClinica = envioFalso('clinica');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: daClinica });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: '99887766', texto: 'qual o preço?',
    agenteId: null, contaComercialId: CLINICA, envio: daClinica,
  });

  assert.equal(resultado.regra, null, 'a regra "Preço" é da loja: no perfil da clínica ela não existe');
  assert.equal(daClinica.enviados.length, 0, 'e nada foi publicado');
});

test('o comentário na loja é respondido pela loja, e a conversa nasce do agente', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daLoja = envioFalso('loja');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: envioFalso('clinica') });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c2', autorIgId: '99887766', texto: 'qual o preço?',
    agenteId: 7, contaComercialId: ALPINS, envio: daLoja,
  });

  assert.equal(resultado.regra.id, REGRA_LOJA.id);
  assert.equal(resultado.resposta_publica_enviada, true);
  assert.equal(resultado.dm_enviada, true);
  assert.equal(daLoja.enviados.length, 2, 'as duas ações saíram pela conta da loja');

  const conversa = repositorio.mensagens.find((m) => m.tipo === 'conversa');
  assert.equal(conversa.agenteId, 7, 'a conversa pertence ao agente da loja, não à clínica');

  const dm = repositorio.mensagens.find((m) => m.tipo === 'mensagem');
  assert.equal(dm.autor_nome, 'Agente Alpins', '"Serena" numa DM da loja confundiria cliente e equipe');

  const registro = repositorio.registros[0];
  assert.equal(registro.agenteId, 7);
  assert.equal(registro.contaComercialId, ALPINS);
});

test('o perfil da clínica segue assinando como Serena', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daClinica = envioFalso('clinica');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: daClinica });

  await servico.processarComentario({
    comentarioIdExterno: 'c3', autorIgId: '99887766', texto: 'quero agendar',
    agenteId: null, contaComercialId: CLINICA, envio: daClinica,
  });

  const dm = repositorio.mensagens.find((m) => m.tipo === 'mensagem');
  assert.equal(dm.autor_nome, 'Serena');
  const conversa = repositorio.mensagens.find((m) => m.tipo === 'conversa');
  assert.equal(conversa.agenteId, null, 'a conversa da clínica não ganha dono de agente');
});
