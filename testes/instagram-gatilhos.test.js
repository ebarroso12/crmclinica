'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeGatilhos, ErroDoInstagram } = require('../src/dominio/instagram-gatilhos');

function instagramEnvioFalso({ falhar = false } = {}) {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      envios.push(carga);
      if (falhar) throw new Error('Graph API do Instagram indisponível');
      return { identificador: 'ig-msg-1' };
    },
    async responderComentarioPrivadamente(carga) {
      envios.push(carga);
      if (falhar) throw new Error('Graph API do Instagram indisponível');
      return { identificador: 'ig-msg-1' };
    },
  };
}

function montar({ instagramEnvio = null } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio });
  return { repositorio, servico };
}

const CAMPOS_REGRA = Object.freeze({
  nome: 'Consulta - preço',
  palavraGatilho: 'preço',
  mensagemDm: 'Olá! Vou te passar os valores da consulta por aqui.',
  mensagemPublica: 'Te chamei no direct com os valores :)',
});

// -------------------------------------------------------------------- CRUD

test('cria, lista, obtém, edita, liga/desliga e remove uma regra', async () => {
  const { repositorio, servico } = montar();

  const criada = await servico.criarRegra({ ...CAMPOS_REGRA, usuarioId: 7 });
  assert.equal(criada.nome, 'Consulta - preço');
  assert.equal(criada.palavra_gatilho, 'preço');
  assert.equal(criada.ativa, true);
  assert.equal(criada.cta_whatsapp, true);
  assert.equal(criada.criado_por, 7);

  const listadas = await servico.listarRegras({});
  assert.equal(listadas.length, 1);

  const obtida = await servico.obterRegra(criada.id);
  assert.equal(obtida.id, criada.id);

  const editada = await servico.editarRegra(criada.id, { mensagemDm: 'Nova mensagem de DM, bem maior que a anterior.' });
  assert.equal(editada.mensagem_dm, 'Nova mensagem de DM, bem maior que a anterior.');
  // Campos não enviados na edição preservam o valor anterior.
  assert.equal(editada.palavra_gatilho, 'preço');

  const desativada = await servico.definirRegraAtiva(criada.id, false);
  assert.equal(desativada.ativa, false);

  const ativasApenasAgora = await servico.listarRegras({ apenasAtivas: true });
  assert.equal(ativasApenasAgora.length, 0, 'regra desativada não aparece no filtro apenasAtivas');

  const remocao = await servico.removerRegra(criada.id);
  assert.equal(remocao.removida, true);
  assert.equal(await repositorio.obterRegraDeGatilho(criada.id), null);
});

test('recusa criar regra com campos fora dos limites', async () => {
  const { servico } = montar();

  await assert.rejects(
    servico.criarRegra({ ...CAMPOS_REGRA, nome: '' }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'nome_obrigatorio',
  );
  await assert.rejects(
    servico.criarRegra({ ...CAMPOS_REGRA, palavraGatilho: 'a' }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'palavra_gatilho_invalida',
  );
  await assert.rejects(
    servico.criarRegra({ ...CAMPOS_REGRA, mensagemDm: 'oi' }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'mensagem_dm_invalida',
  );
  await assert.rejects(
    servico.criarRegra({ ...CAMPOS_REGRA, mensagemPublica: 'x' }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'mensagem_publica_invalida',
  );
});

test('recusa nome de regra duplicado', async () => {
  const { servico } = montar();
  await servico.criarRegra({ ...CAMPOS_REGRA });

  await assert.rejects(
    servico.criarRegra({ ...CAMPOS_REGRA }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'nome_duplicado' && erro.status === 409,
  );
});

test('editar/desligar/remover regra inexistente devolve erro regra_ausente', async () => {
  const { servico } = montar();

  await assert.rejects(
    servico.editarRegra(999, { nome: 'x' }),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'regra_ausente',
  );
  await assert.rejects(
    servico.definirRegraAtiva(999, false),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'regra_ausente',
  );
  await assert.rejects(
    servico.removerRegra(999),
    (erro) => erro instanceof ErroDoInstagram && erro.codigo === 'regra_ausente',
  );
});

// ------------------------------------------------------------ processarComentario

test('comentário sem gatilho não dispara ação nenhuma, mas fica registrado', async () => {
  const instagramEnvio = instagramEnvioFalso();
  const { repositorio, servico } = montar({ instagramEnvio });
  await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c1',
    postId: 'p1',
    autorIgId: 'ig1',
    autorUsername: 'fulano',
    texto: 'lindo esse consultório, parabéns!',
  });

  assert.equal(resultado.regra, null);
  assert.equal(instagramEnvio.envios.length, 0);
  assert.equal((await repositorio.listarContatos({})).length, 0, 'sem match, nenhum contato é criado');

  const registrado = await repositorio.obterComentarioProcessado('c1');
  assert.ok(registrado);
  assert.equal(registrado.regra_id, null);
  assert.equal(registrado.dm_enviada, false);
});

test('comentário com gatilho dispara DM, cria contato/conversa/lead e registra idempotência', async () => {
  const instagramEnvio = instagramEnvioFalso();
  const { repositorio, servico } = montar({ instagramEnvio });
  const regra = await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c2',
    postId: 'p1',
    autorIgId: 'ig2',
    autorUsername: 'maria_paciente',
    texto: 'Qual o PREÇO da consulta?',
  });

  assert.equal(resultado.regra.id, regra.id);
  assert.equal(resultado.dm_enviada, true);
  // Este fake (instagramEnvioFalso) não implementa responderComentarioPublicamente
  // de propósito — prova o caminho defensivo (sem o método, não quebra, só
  // fica false). O caminho COM o método está no teste seguinte.
  assert.equal(resultado.resposta_publica_enviada, false);

  assert.equal(instagramEnvio.envios.length, 1);
  assert.equal(instagramEnvio.envios[0].comentarioIdExterno, 'c2', 'DM do gatilho endereça por comment_id, não por PSID');
  assert.equal(instagramEnvio.envios[0].texto, CAMPOS_REGRA.mensagemDm);

  const contatos = await repositorio.listarContatos({});
  assert.equal(contatos.length, 1);
  assert.equal(contatos[0].identificador, 'ig2');
  assert.equal(contatos[0].nome, 'maria_paciente');
  assert.equal(contatos[0].origem, 'instagram');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  assert.equal(conversas[0].canal, 'instagram');

  const mensagens = await repositorio.listarMensagens(conversas[0].id);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0].direcao, 'saida');
  assert.equal(mensagens[0].autor_tipo, 'automacao');
  assert.equal(mensagens[0].conteudo, CAMPOS_REGRA.mensagemDm);

  const leads = await repositorio.listarLeads({});
  assert.equal(leads.length, 1);
  assert.equal(leads[0].origem, 'INSTAGRAM');
  assert.equal(leads[0].origem_detalhe, `Comentário-gatilho: ${CAMPOS_REGRA.nome}`, 'diferencia lead de gatilho de um DM comum na tela de Leads');

  const registrado = await repositorio.obterComentarioProcessado('c2');
  assert.equal(registrado.regra_id, regra.id);
  assert.equal(registrado.dm_enviada, true);
});

test('com responderComentarioPublicamente disponível, a resposta pública é chamada com o comentário e o texto certos', async () => {
  // Achado A1.9-B (23/08): a implementação anterior chamava o método com a
  // chave errada (`comentarioId` em vez de `comentarioIdExterno`) — como o
  // fake antigo não tinha o método, nada pegava isso. Este teste usa um fake
  // QUE TEM o método, exatamente para expor esse tipo de erro de novo se
  // reaparecer.
  const chamadas = [];
  const instagramEnvio = {
    ...instagramEnvioFalso(),
    async responderComentarioPublicamente(carga) {
      chamadas.push(carga);
      return { identificador: 'ig-reply-1' };
    },
  };
  const { servico } = montar({ instagramEnvio });
  await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c9', postId: 'p1', autorIgId: 'ig9', autorUsername: 'carla', texto: 'qual o preço?',
  });

  assert.equal(resultado.resposta_publica_enviada, true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].comentarioIdExterno, 'c9', 'o id do comentário precisa chegar com o nome de campo certo');
  assert.equal(chamadas[0].texto, CAMPOS_REGRA.mensagemPublica);
});

test('falha na resposta pública é best-effort — não impede a DM nem o registro', async () => {
  const instagramEnvio = {
    ...instagramEnvioFalso(),
    async responderComentarioPublicamente() {
      throw new Error('Graph API recusou a resposta pública');
    },
  };
  const { repositorio, servico } = montar({ instagramEnvio });
  await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c10', postId: 'p1', autorIgId: 'ig10', autorUsername: 'pedro', texto: 'preço?',
  });

  assert.equal(resultado.resposta_publica_enviada, false);
  assert.equal(resultado.dm_enviada, true, 'a DM não pode falhar só porque a resposta pública falhou');
  const registrado = await repositorio.obterComentarioProcessado('c10');
  assert.equal(registrado.resposta_publica_enviada, false);
  assert.equal(registrado.dm_enviada, true);
});

test('mesmo comentário reentregue (mesmo comentarioIdExterno) não reprocessa nem duplica', async () => {
  const instagramEnvio = instagramEnvioFalso();
  const { repositorio, servico } = montar({ instagramEnvio });
  await servico.criarRegra({ ...CAMPOS_REGRA });

  const carga = {
    comentarioIdExterno: 'c3', postId: 'p1', autorIgId: 'ig3', autorUsername: 'joao', texto: 'preço, por favor',
  };

  const primeira = await servico.processarComentario(carga);
  assert.equal(primeira.ja_processado, undefined);

  const segunda = await servico.processarComentario(carga);
  assert.equal(segunda.ja_processado, true);

  assert.equal(instagramEnvio.envios.length, 1, 'a DM não sai duas vezes para o mesmo comentário');
  assert.equal((await repositorio.listarContatos({})).length, 1, 'nenhum contato duplicado na reentrega');
});

test('falha no envio da DM não quebra o processamento do comentário (best-effort)', async () => {
  const instagramEnvio = instagramEnvioFalso({ falhar: true });
  const { repositorio, servico } = montar({ instagramEnvio });
  const regra = await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c4', postId: 'p1', autorIgId: 'ig4', autorUsername: 'ana', texto: 'quero saber o preço',
  });

  assert.equal(resultado.regra.id, regra.id);
  assert.equal(resultado.dm_enviada, false, 'a falha de envio fica registrada, mas não lança');

  // Mesmo com a DM falhando, contato/conversa/lead e a idempotência seguem
  // gravados — best-effort é só no transporte externo, não no CRM interno.
  assert.equal((await repositorio.listarContatos({})).length, 1);
  const registrado = await repositorio.obterComentarioProcessado('c4');
  assert.equal(registrado.dm_enviada, false);
  assert.equal(registrado.regra_id, regra.id);
});

test('sem instagramEnvio configurado, processarComentario não lança e marca dm_enviada:false', async () => {
  const { repositorio, servico } = montar({ instagramEnvio: null });
  const regra = await servico.criarRegra({ ...CAMPOS_REGRA });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c5', postId: 'p1', autorIgId: 'ig5', autorUsername: 'carla', texto: 'o preço é bom?',
  });

  assert.equal(resultado.regra.id, regra.id);
  assert.equal(resultado.dm_enviada, false);
  assert.equal((await repositorio.listarContatos({})).length, 1, 'contato/conversa/lead seguem gravados mesmo sem transporte de DM');
});
