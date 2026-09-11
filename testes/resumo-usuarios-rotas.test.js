'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { validarAgente } = require('../src/dominio/agentes/regras');

// Tela Usuários do resumo por equipe (docs/RESUMOS.md): a chave "Recebe resumos"
// (admin, auditada) e o painel de quem recebe, sempre mascarado.

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const auditoria = [];
  const registrarOriginal = repositorio.registrarAuditoria.bind(repositorio);
  repositorio.registrarAuditoria = async (entrada) => {
    auditoria.push(entrada);
    return registrarOriginal(entrada);
  };
  const orquestrador = {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
  const atendimento = criarAtendimento({ repositorio, orquestrador });
  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste() });

  const sessoes = {
    admin: await app.entrarComo('admin', { email: 'admin-resumos@teste.local', master: true }),
    gestor: await app.entrarComo('gestor', { email: 'gestor-resumos@teste.local' }),
    loja: await app.entrarComo('atendente', { email: 'loja-resumos@teste.local' }),
  };
  const ids = Object.fromEntries(Object.entries(sessoes).map(([nome, sessao]) => [nome, sessao.usuario.id]));

  async function pedir(quem, rota, { metodo = 'GET', corpo } = {}) {
    const resposta = await app.pedirSemAuth(rota, {
      method: metodo,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessoes[quem].access_token}` },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resposta.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: resposta.status, json, texto };
  }

  const whatsapp = (id, numero, autorizado = true) => repositorio.atualizarUsuario(id, {
    whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: numero, whatsappParticularAutorizado: autorizado,
  });

  return { app, repositorio, auditoria, pedir, ids, whatsapp };
}

test('admin pausa e retoma os resumos de alguém: auditado sem telefone; repetir não audita de novo', async (t) => {
  const { app, repositorio, auditoria, pedir, ids, whatsapp } = await montar();
  t.after(() => app.encerrar());
  await whatsapp(ids.gestor, '991000002');

  const pausa = await pedir('admin', `/api/usuarios/${ids.gestor}/recebe-resumo`, { metodo: 'POST', corpo: { recebe_resumo: false } });
  assert.equal(pausa.status, 200);
  assert.equal(pausa.json.mudou, true);
  assert.equal((await repositorio.obterUsuarioPorId(ids.gestor)).recebe_resumo, false);

  const deNovo = await pedir('admin', `/api/usuarios/${ids.gestor}/recebe-resumo`, { metodo: 'POST', corpo: { recebe_resumo: false } });
  assert.equal(deNovo.json.mudou, false);

  const retoma = await pedir('admin', `/api/usuarios/${ids.gestor}/recebe-resumo`, { metodo: 'POST', corpo: { recebe_resumo: true } });
  assert.equal(retoma.json.mudou, true);

  const registros = auditoria.filter((item) => ['resumo_pausado', 'resumo_retomado'].includes(item.acao));
  assert.deepEqual(registros.map((item) => item.acao), ['resumo_pausado', 'resumo_retomado']);
  for (const registro of registros) {
    assert.equal(registro.entidade, 'usuario');
    assert.equal(registro.entidadeId, ids.gestor);
    assert.deepEqual(registro.detalhe, { usuario_id: ids.gestor });
    assert.equal(registro.usuarioId, ids.admin);
    assert.ok(!JSON.stringify(registro).includes('991000002'), 'telefone não entra na auditoria');
  }
});

test('corpo inválido, usuário inexistente e quem não é admin são recusados', async (t) => {
  const { app, pedir, ids } = await montar();
  t.after(() => app.encerrar());

  assert.equal((await pedir('admin', `/api/usuarios/${ids.gestor}/recebe-resumo`, { metodo: 'POST', corpo: { recebe_resumo: 'nao' } })).status, 400);
  assert.equal((await pedir('admin', '/api/usuarios/999999/recebe-resumo', { metodo: 'POST', corpo: { recebe_resumo: false } })).status, 404);
  assert.equal((await pedir('gestor', `/api/usuarios/${ids.gestor}/recebe-resumo`, { metodo: 'POST', corpo: { recebe_resumo: false } })).status, 403);
  assert.equal((await pedir('gestor', '/api/usuarios/resumos')).status, 403);
});

test('lista de usuários diz se a pessoa recebe e por que não recebe — sem o número', async (t) => {
  const { app, pedir, ids, whatsapp } = await montar();
  t.after(() => app.encerrar());
  const doGestor = async () => (await pedir('admin', '/api/usuarios')).json.usuarios.find((item) => item.id === ids.gestor);

  assert.deepEqual([(await doGestor()).recebe_resumo, (await doGestor()).motivo_sem_resumo], [true, 'sem_whatsapp']);
  await whatsapp(ids.gestor, '991000002', false);
  assert.equal((await doGestor()).motivo_sem_resumo, 'whatsapp_nao_autorizado');
  await whatsapp(ids.gestor, '991000002', true);
  const pronto = await doGestor();
  assert.equal(pronto.motivo_sem_resumo, null);
  assert.ok(!JSON.stringify(pronto).includes('991000002'), 'a lista não carrega o WhatsApp');
});

test('painel: destinatários por equipe mascarados, agente sem canal e quem não recebe com o motivo', async (t) => {
  const { app, repositorio, pedir, ids, whatsapp } = await montar();
  t.after(() => app.encerrar());
  await whatsapp(ids.admin, '991000001');
  await whatsapp(ids.loja, '991000003');
  await repositorio.atualizarUsuario(ids.loja, { acessoClinica: false });
  const alpins = await repositorio.criarAgente(validarAgente({ slug: 'alpins-painel', nome: 'Agente Alpins' }), { usuarioId: null });
  await repositorio.definirCanaisDoAgente(alpins.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
  await repositorio.adicionarMembroDaEquipe(alpins.id, ids.loja);
  await repositorio.criarAgente(validarAgente({ slug: 'bravo-painel', nome: 'Agente Bravo' }), { usuarioId: null });

  const { status, json, texto } = await pedir('admin', '/api/usuarios/resumos');

  assert.equal(status, 200);
  const grupo = (nome) => json.grupos.find((item) => item.nome === nome);
  assert.deepEqual(grupo('Clínica').destinatarios.map((item) => [item.usuario_id, item.whatsapp]), [[ids.admin, '+55 16 9****-0001']]);
  assert.deepEqual(grupo('Agente Alpins').destinatarios.map((item) => item.usuario_id), [ids.loja]);
  assert.equal(grupo('Agente Alpins').sem_canal, false);
  assert.equal(grupo('Agente Bravo').sem_canal, true);
  // O servidor de teste semeia a própria conta; aqui só as pessoas deste teste.
  const deste = (lista) => lista.filter((item) => Object.values(ids).includes(item.usuario_id));
  assert.deepEqual(deste(json.sem_entrega).map((item) => [item.usuario_id, item.motivo]), [[ids.gestor, 'sem_whatsapp']]);
  assert.ok(!/991000001|991000003/.test(texto), 'número inteiro nunca sai no painel');
});
