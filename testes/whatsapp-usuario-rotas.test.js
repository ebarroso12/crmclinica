'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// WhatsApp da equipe na tela de Usuários (docs/RESUMOS.md): sem ele, ninguém
// recebe resumo. O número vai pela edição completa que já existia
// (PUT /api/usuarios/:id) e a autorização pela rota de P1-06
// (POST /api/usuarios/:id/whatsapp-particular) — nenhuma rota nova.

const NUMERO = '991000002';

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
    admin: await app.entrarComo('admin', { email: 'admin-whatsapp@teste.local', master: true }),
    gestor: await app.entrarComo('gestor', { email: 'gestor-whatsapp@teste.local' }),
    atendente: await app.entrarComo('atendente', { email: 'atendente-whatsapp@teste.local' }),
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

  // Onde o gestor está no painel: motivo de não receber, "recebe" ou "fora".
  async function situacaoNoPainel(usuarioId) {
    const { json } = await pedir('admin', '/api/usuarios/resumos');
    const fora = json.sem_entrega.find((item) => item.usuario_id === usuarioId);
    if (fora) return fora.motivo;
    return json.grupos.some((grupo) => grupo.destinatarios.some((item) => item.usuario_id === usuarioId)) ? 'recebe' : 'fora';
  }

  return { app, repositorio, auditoria, pedir, ids, sessoes, situacaoNoPainel };
}

test('admin cadastra e autoriza: a ficha mostra quem e quando, e o painel passa de "sem WhatsApp" a "não autorizado" a "recebe"', async (t) => {
  const { app, auditoria, pedir, ids, sessoes, situacaoNoPainel } = await montar();
  t.after(() => app.encerrar());

  assert.equal(await situacaoNoPainel(ids.gestor), 'sem_whatsapp');

  const salvo = await pedir('admin', `/api/usuarios/${ids.gestor}`, {
    metodo: 'PUT', corpo: { whatsapp: { ddi: '55', ddd: '16', numero: NUMERO } },
  });
  assert.equal(salvo.status, 200);
  assert.equal(await situacaoNoPainel(ids.gestor), 'whatsapp_nao_autorizado');

  const autorizado = await pedir('admin', `/api/usuarios/${ids.gestor}/whatsapp-particular`, {
    metodo: 'POST', corpo: { autorizado: true },
  });
  assert.equal(autorizado.status, 200);
  assert.equal(await situacaoNoPainel(ids.gestor), 'recebe');

  const { json: { usuario: ficha } } = await pedir('admin', `/api/usuarios/${ids.gestor}`);
  assert.deepEqual([ficha.whatsapp_ddi, ficha.whatsapp_ddd, ficha.whatsapp_numero], ['55', '16', NUMERO],
    'o formulário do admin recebe o número para editar');
  assert.equal(ficha.whatsapp_particular_autorizado, true);
  assert.equal(ficha.whatsapp_particular_autorizado_por, ids.admin);
  assert.equal(ficha.whatsapp_particular_autorizado_por_nome, sessoes.admin.usuario.nome, 'quem autorizou, pelo nome');
  assert.ok(Number.isFinite(Date.parse(ficha.whatsapp_particular_autorizado_em)), 'quando autorizou');

  const revogado = await pedir('admin', `/api/usuarios/${ids.gestor}/whatsapp-particular`, {
    metodo: 'POST', corpo: { autorizado: false },
  });
  assert.equal(revogado.status, 200);
  assert.equal(await situacaoNoPainel(ids.gestor), 'whatsapp_nao_autorizado');
  const { json: { usuario: depois } } = await pedir('admin', `/api/usuarios/${ids.gestor}`);
  assert.equal(depois.whatsapp_particular_autorizado_em, null);

  const acoes = auditoria.filter((item) => item.entidadeId === ids.gestor).map((item) => item.acao);
  for (const acao of ['usuario.editado', 'usuario.whatsapp_particular_autorizado', 'usuario.whatsapp_particular_revogado']) {
    assert.ok(acoes.includes(acao), `auditoria ${acao}`);
  }
});

test('WhatsApp inválido: 422 com a mensagem da validação e nada gravado', async (t) => {
  const { app, pedir, ids, repositorio } = await montar();
  t.after(() => app.encerrar());

  const recusado = await pedir('admin', `/api/usuarios/${ids.gestor}`, {
    metodo: 'PUT', corpo: { whatsapp: { ddi: '55', ddd: '1', numero: '1234' } },
  });

  assert.equal(recusado.status, 422);
  assert.equal(recusado.json.codigo, 'whatsapp_invalido');
  assert.match(recusado.json.erro, /DDD \(2 dígitos\) e número \(8 ou 9\)/);
  assert.equal((await repositorio.obterUsuarioPorId(ids.gestor)).whatsapp_numero, null);
});

test('gestor e atendente não cadastram nem autorizam WhatsApp de ninguém — nem o próprio; o perfil não mexe no WhatsApp', async (t) => {
  const { app, pedir, ids, repositorio } = await montar();
  t.after(() => app.encerrar());

  for (const quem of ['gestor', 'atendente']) {
    for (const alvo of [ids.admin, ids[quem]]) {
      const editar = await pedir(quem, `/api/usuarios/${alvo}`, {
        metodo: 'PUT', corpo: { whatsapp: { ddi: '55', ddd: '16', numero: NUMERO } },
      });
      assert.equal(editar.status, 403, `${quem} editando ${alvo}`);
      const autorizar = await pedir(quem, `/api/usuarios/${alvo}/whatsapp-particular`, {
        metodo: 'POST', corpo: { autorizado: true },
      });
      assert.equal(autorizar.status, 403, `${quem} autorizando ${alvo}`);
    }
  }

  // P1-06: consentimento é registrado pelo admin. O perfil só aceita nome e telefone livre.
  const soWhatsapp = await pedir('gestor', '/api/perfil', { metodo: 'PUT', corpo: { whatsapp: { ddd: '16', numero: NUMERO } } });
  assert.equal(soWhatsapp.status, 400);
  const comNome = await pedir('gestor', '/api/perfil', {
    metodo: 'PUT', corpo: { nome: 'Gestor', whatsapp: { ddd: '16', numero: NUMERO }, whatsapp_particular_autorizado: true },
  });
  assert.equal(comNome.status, 200);
  const gestor = await repositorio.obterUsuarioPorId(ids.gestor);
  assert.equal(gestor.whatsapp_numero, null);
  assert.equal(gestor.whatsapp_particular_autorizado, false);
});

test('trocar ou tirar o número zera a autorização e audita com o motivo; o mesmo número, formatado, não revoga (auditoria M3)', async (t) => {
  const { app, auditoria, pedir, ids, situacaoNoPainel } = await montar();
  t.after(() => app.encerrar());
  const salvar = (whatsapp) => pedir('admin', `/api/usuarios/${ids.gestor}`, { metodo: 'PUT', corpo: { whatsapp } });
  const autorizar = () => pedir('admin', `/api/usuarios/${ids.gestor}/whatsapp-particular`, { metodo: 'POST', corpo: { autorizado: true } });
  const ficha = async () => (await pedir('admin', `/api/usuarios/${ids.gestor}`)).json.usuario;
  const revogacoes = () => auditoria.filter((item) => item.entidadeId === ids.gestor
    && item.acao === 'usuario.whatsapp_particular_revogado' && item.detalhe?.motivo === 'numero_alterado');

  await salvar({ ddi: '55', ddd: '16', numero: NUMERO });
  await autorizar();
  assert.equal(await situacaoNoPainel(ids.gestor), 'recebe');

  assert.equal((await salvar({ ddi: '+55', ddd: '(16)', numero: '99100-0002' })).status, 200);
  assert.equal((await ficha()).whatsapp_particular_autorizado, true, 'o mesmo número, formatado, não revoga');
  assert.equal(revogacoes().length, 0);

  assert.equal((await salvar({ ddi: '55', ddd: '16', numero: '991000009' })).status, 200);
  const trocado = await ficha();
  assert.deepEqual(
    [trocado.whatsapp_particular_autorizado, trocado.whatsapp_particular_autorizado_em, trocado.whatsapp_particular_autorizado_por],
    [false, null, null],
    'trocar o número zera autorização, data e autor',
  );
  assert.equal(await situacaoNoPainel(ids.gestor), 'whatsapp_nao_autorizado');
  assert.equal(revogacoes().length, 1, 'auditado com motivo numero_alterado');
  assert.ok(!JSON.stringify(revogacoes()).includes('991000009'), 'sem telefone na auditoria');

  await autorizar();
  assert.equal((await salvar({ ddi: null, ddd: null, numero: null })).status, 200);
  assert.equal((await ficha()).whatsapp_particular_autorizado, false, 'tirar o número também revoga');
  assert.equal(revogacoes().length, 2);
});

test('o número nunca sai sem máscara fora da ficha de edição do admin: lista, painel e auditoria', async (t) => {
  const { app, auditoria, pedir, ids } = await montar();
  t.after(() => app.encerrar());
  await pedir('admin', `/api/usuarios/${ids.gestor}`, { metodo: 'PUT', corpo: { whatsapp: { ddi: '55', ddd: '16', numero: NUMERO } } });
  await pedir('admin', `/api/usuarios/${ids.gestor}/whatsapp-particular`, { metodo: 'POST', corpo: { autorizado: true } });

  const lista = await pedir('admin', '/api/usuarios');
  assert.equal(lista.status, 200);
  assert.ok(!lista.texto.includes(NUMERO), 'lista de usuários');
  const painel = await pedir('admin', '/api/usuarios/resumos');
  assert.ok(!painel.texto.includes(NUMERO), 'painel dos resumos');
  assert.ok(painel.texto.includes('+55 16 9****-0002'), 'no painel, só mascarado');
  assert.ok(!JSON.stringify(auditoria).includes(NUMERO), 'auditoria');
});
