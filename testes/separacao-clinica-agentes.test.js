'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { validarAgente } = require('../src/dominio/agentes/regras');
const { criarEmissorDeConversas, criarReleituraDeEventos } = require('../src/servidor/eventos-conversas');

// Matriz de ESCOPO da migration 047 (docs/AGENTES.md, "Quem vê o quê"): não
// o que cada papel pode fazer (testes/perfis.test.js), mas SOBRE O QUÊ.
//
// Perfis:
//   admin            — vê tudo, sempre;
//   gestorClinica    — vê a clínica, fora da equipe de qualquer agente;
//   atendenteClinica — idem;
//   gestorAlpins     — vê a clínica e está na equipe do Alpins;
//   loja             — colaborador da loja: NÃO vê a clínica, equipe do Alpins.
//
// Contatos seguem a decisão de 11/09: base compartilhada com selos para quem vê
// a clínica; só clientes dos agentes da equipe para quem não vê.

function orquestradorFalso() {
  return {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
}

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });
  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste() });

  const alpins = await repositorio.criarAgente(validarAgente({ slug: 'alpins-separacao', nome: 'Agente Alpins' }), { usuarioId: null });
  const bravo = await repositorio.criarAgente(validarAgente({ slug: 'bravo-separacao', nome: 'Agente Bravo' }), { usuarioId: null });

  // Paciente: conversa na clínica E conversa com a loja (a mesma pessoa).
  const paciente = await repositorio.encontrarOuCriarContato({ telefone: '5516900005001', nome: 'Paciente Separação' });
  await repositorio.atualizarContato(paciente.id, { observacoes: 'anotação clínica sigilosa' });
  const conversaClinica = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp');
  await repositorio.registrarMensagem(conversaClinica.id, { direcao: 'entrada', conteudo: 'texto da clínica', autor_tipo: 'contato' });
  await repositorio.criarNota(paciente.id, 'nota interna da clínica', null);
  const conversaPacienteLoja = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp', { agenteId: alpins.id });
  await repositorio.registrarMensagem(conversaPacienteLoja.id, { direcao: 'entrada', conteudo: 'texto do paciente na loja', autor_tipo: 'contato' });

  // Cliente só da loja e cliente só do Bravo.
  const clienteAlpins = await repositorio.encontrarOuCriarContato({ telefone: '5516900005002', nome: 'Cliente Alpins' });
  const conversaAlpins = await repositorio.encontrarOuCriarConversaAberta(clienteAlpins.id, 'whatsapp', { agenteId: alpins.id });
  await repositorio.registrarMensagem(conversaAlpins.id, { direcao: 'entrada', conteudo: 'texto só da loja', autor_tipo: 'contato' });
  const clienteBravo = await repositorio.encontrarOuCriarContato({ telefone: '5516900005003', nome: 'Cliente Bravo' });
  const conversaBravo = await repositorio.encontrarOuCriarConversaAberta(clienteBravo.id, 'whatsapp', { agenteId: bravo.id });
  await repositorio.registrarMensagem(conversaBravo.id, { direcao: 'entrada', conteudo: 'texto do bravo', autor_tipo: 'contato' });

  const manual = await repositorio.criarContato({ nome: 'Contato Manual Separação', telefone: '5516900005004' });

  const sessoes = {
    admin: await app.entrarComo('admin', { email: 'admin-separacao@teste.local', master: true }),
    gestorClinica: await app.entrarComo('gestor', { email: 'gestor-clinica-separacao@teste.local' }),
    atendenteClinica: await app.entrarComo('atendente', { email: 'atendente-clinica-separacao@teste.local' }),
    gestorAlpins: await app.entrarComo('gestor', { email: 'gestor-alpins-separacao@teste.local' }),
    loja: await app.entrarComo('atendente', { email: 'loja-separacao@teste.local' }),
  };
  const ids = Object.fromEntries(Object.entries(sessoes).map(([nome, sessao]) => [nome, sessao.usuario.id]));
  await repositorio.adicionarMembroDaEquipe(alpins.id, ids.gestorAlpins);
  await repositorio.adicionarMembroDaEquipe(alpins.id, ids.loja);
  await repositorio.atualizarUsuario(ids.loja, { acessoClinica: false });

  async function pedir(quem, rota, { metodo = 'GET', corpo } = {}) {
    const resposta = await app.pedirSemAuth(rota, {
      method: metodo,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessoes[quem].access_token}` },
      body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    });
    const texto = await resposta.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: resposta.status, json };
  }

  return {
    app, repositorio, pedir, ids, alpins, bravo,
    paciente, clienteAlpins, clienteBravo, manual,
    conversaClinica, conversaPacienteLoja, conversaAlpins, conversaBravo,
  };
}

const ordenar = (lista) => [...lista].sort((a, b) => a - b);

test('lista de conversas: cada perfil vê só o seu recorte, e o filtro forjado não abre nada', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const idsDe = async (quem, extra = '') => ordenar((await c.pedir(quem, `/api/conversas?fila=todos${extra}`)).json.conversas.map((conversa) => conversa.id));

  const todas = ordenar([c.conversaClinica.id, c.conversaPacienteLoja.id, c.conversaAlpins.id, c.conversaBravo.id]);
  const doAlpins = ordenar([c.conversaPacienteLoja.id, c.conversaAlpins.id]);
  assert.deepEqual(await idsDe('admin'), todas);
  assert.deepEqual(await idsDe('gestorClinica'), [c.conversaClinica.id]);
  assert.deepEqual(await idsDe('atendenteClinica'), [c.conversaClinica.id]);
  assert.deepEqual(await idsDe('gestorAlpins'), ordenar([c.conversaClinica.id, ...doAlpins]));
  assert.deepEqual(await idsDe('loja'), doAlpins);

  assert.deepEqual(await idsDe('loja', '&agente=clinica'), [], 'loja pedindo "só clínica"');
  assert.deepEqual(await idsDe('loja', `&agente=${c.bravo.id}`), [], 'loja pedindo outro agente');
  assert.deepEqual(await idsDe('atendenteClinica', `&agente=${c.alpins.id}`), [], 'clínica fora da equipe pedindo o Alpins');
  assert.deepEqual(await idsDe('admin', `&agente=${c.alpins.id}`), doAlpins);
  assert.deepEqual(await idsDe('admin', '&agente=clinica'), [c.conversaClinica.id]);
});

test('conversa fora do escopo responde 404 em toda sub-rota — antes de ler o corpo', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  for (const [quem, conversa] of [['atendenteClinica', c.conversaAlpins], ['gestorClinica', c.conversaPacienteLoja], ['loja', c.conversaClinica], ['loja', c.conversaBravo]]) {
    assert.equal((await c.pedir(quem, `/api/conversas/${conversa.id}`)).status, 404, `${quem} GET conversa ${conversa.id}`);
    assert.equal((await c.pedir(quem, `/api/conversas/${conversa.id}/mensagens`)).status, 404, `${quem} GET mensagens`);
    // Corpo inválido de propósito: 404 (e não 400) prova que a trava vem antes da leitura.
    assert.equal((await c.pedir(quem, `/api/conversas/${conversa.id}/mensagens`, { metodo: 'POST', corpo: '{quebrado' })).status, 404, `${quem} POST mensagens`);
    for (const acao of ['assumir', 'etiquetas', 'estado', 'notas', 'anexos']) {
      assert.equal((await c.pedir(quem, `/api/conversas/${conversa.id}/${acao}`, { metodo: 'POST', corpo: {} })).status, 404, `${quem} POST ${acao}`);
    }
  }
});

test('ficha da conversa: conversas anteriores, notas e observações seguem o escopo', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  const daLoja = await c.pedir('loja', `/api/conversas/${c.conversaPacienteLoja.id}`);
  assert.equal(daLoja.status, 200);
  assert.deepEqual(daLoja.json.ficha.conversas_anteriores.map((conversa) => conversa.id), [],
    'a conversa da clínica do mesmo paciente não aparece para a loja');
  assert.deepEqual(daLoja.json.ficha.notas, [], 'nota interna da clínica não vai para a loja');
  // Auditoria de acesso A2: lista branca — o campo nem existe para a loja.
  assert.ok(!('observacoes' in daLoja.json.ficha), 'observação clínica não vai para a loja');

  const daClinica = await c.pedir('atendenteClinica', `/api/conversas/${c.conversaClinica.id}`);
  assert.equal(daClinica.status, 200);
  assert.deepEqual(daClinica.json.ficha.conversas_anteriores.map((conversa) => conversa.id), [],
    'a conversa do paciente com a loja não aparece para a clínica fora da equipe');
  assert.equal(daClinica.json.ficha.notas.length, 1);
  assert.equal(daClinica.json.ficha.observacoes, 'anotação clínica sigilosa');

  const doAdmin = await c.pedir('admin', `/api/conversas/${c.conversaClinica.id}`);
  assert.deepEqual(doAdmin.json.ficha.conversas_anteriores.map((conversa) => conversa.id), [c.conversaPacienteLoja.id]);
});

test('colaborador da loja: toda rota da clínica responde 403 sem_acesso_clinica; quem vê a clínica não esbarra nisso', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  const rotasDaClinica = [
    ['GET', '/api/resumo'], ['GET', '/api/conversas/aguardando'], ['POST', '/api/conversas/liberar-todas'],
    ['GET', '/api/tarefas'], ['POST', '/api/tarefas/varrer'], ['GET', '/api/notificacoes'],
    ['GET', '/api/leads'], ['GET', '/api/leads/vocabulario'], ['GET', '/api/agenda'], ['GET', '/api/metricas/resumo'],
    ['GET', '/api/serena/interruptor'], ['GET', '/api/instagram/regras'], ['GET', '/api/auditoria'], ['GET', '/api/bloqueios'],
    ['GET', '/api/sincronia/estado'], ['GET', '/api/lembretes'], ['GET', '/api/ia/modelos'], ['GET', '/api/usuarios'],
    ['GET', '/api/usuarios/gestao'], ['POST', '/api/contatos'], ['GET', '/api/contatos/duplicatas'], ['GET', '/api/contatos/qualidade'],
    ['DELETE', `/api/contatos/${c.clienteAlpins.id}`], ['GET', `/api/conversas/${c.conversaAlpins.id}/agenda`],
    ['POST', `/api/conversas/${c.conversaAlpins.id}/temperatura`], ['POST', `/api/conversas/${c.conversaAlpins.id}/encerrar`],
  ];
  for (const [metodo, rota] of rotasDaClinica) {
    const resposta = await c.pedir('loja', rota, { metodo, corpo: metodo === 'GET' || metodo === 'DELETE' ? undefined : {} });
    assert.equal(resposta.status, 403, `loja ${metodo} ${rota} deveria ser 403 — recebeu ${resposta.status}`);
    assert.equal(resposta.json?.codigo, 'sem_acesso_clinica', `loja ${metodo} ${rota}`);

    const daClinica = await c.pedir('gestorClinica', rota, { metodo, corpo: metodo === 'GET' || metodo === 'DELETE' ? undefined : {} });
    assert.notEqual(daClinica.json?.codigo, 'sem_acesso_clinica', `gestor da clínica ${metodo} ${rota} não pode esbarrar na separação`);
  }

  // O que continua liberado para a loja.
  assert.equal((await c.pedir('loja', '/api/conversas/filas')).status, 200);
  assert.equal((await c.pedir('loja', `/api/conversas/${c.conversaAlpins.id}`)).status, 200);
  assert.equal((await c.pedir('loja', `/api/conversas/${c.conversaAlpins.id}/mensagens`)).status, 200);
  assert.equal((await c.pedir('loja', '/api/auth/sessao')).status, 200);
});

test('escopo das abas: /api/conversas/escopo diz o que cada perfil vê', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const nomes = (dados) => dados.agentes.map((agente) => agente.nome).sort();

  const admin = (await c.pedir('admin', '/api/conversas/escopo')).json;
  assert.equal(admin.clinica, true);
  assert.deepEqual(nomes(admin), ['Agente Alpins', 'Agente Bravo']);
  const clinica = (await c.pedir('atendenteClinica', '/api/conversas/escopo')).json;
  assert.equal(clinica.clinica, true);
  assert.deepEqual(clinica.agentes, []);
  const loja = (await c.pedir('loja', '/api/conversas/escopo')).json;
  assert.equal(loja.clinica, false);
  assert.deepEqual(nomes(loja), ['Agente Alpins']);
});

test('contatos: base compartilhada com selos para a clínica; loja só vê cliente do Alpins, sem dado clínico', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const nossos = [c.paciente.id, c.clienteAlpins.id, c.clienteBravo.id, c.manual.id];
  const listar = async (quem, extra = '') => (await c.pedir(quem, `/api/contatos/gestao?limite=500${extra}`)).json;
  const porId = (dados) => new Map(dados.contatos.filter((contato) => nossos.includes(contato.id)).map((contato) => [contato.id, contato]));

  const daClinica = porId(await listar('atendenteClinica'));
  assert.deepEqual(ordenar([...daClinica.keys()]), ordenar(nossos), 'quem vê a clínica vê todo contato');
  assert.deepEqual(daClinica.get(c.clienteAlpins.id).selos, { clinica: false, agentes: [{ id: c.alpins.id, nome: 'Agente Alpins' }] },
    'selo do Alpins aparece mesmo fora da equipe');
  assert.deepEqual(daClinica.get(c.paciente.id).selos, { clinica: true, agentes: [{ id: c.alpins.id, nome: 'Agente Alpins' }] });
  assert.deepEqual(daClinica.get(c.manual.id).selos, { clinica: true, agentes: [] });
  assert.equal(daClinica.get(c.paciente.id).conversas, 1, 'contagem só das conversas que a clínica vê');

  const fichaClienteAlpins = await c.pedir('atendenteClinica', `/api/contatos/${c.clienteAlpins.id}`);
  assert.equal(fichaClienteAlpins.status, 200);
  assert.deepEqual(fichaClienteAlpins.json.historico.conversas, [], 'a conversa e a prévia do Alpins não saem para quem é de fora');
  const historicoPaciente = await c.pedir('atendenteClinica', `/api/contatos/${c.paciente.id}/conversas`);
  assert.deepEqual(historicoPaciente.json.conversas.map((conversa) => conversa.id), [c.conversaClinica.id]);
  assert.ok(!JSON.stringify(historicoPaciente.json).includes('texto do paciente na loja'), 'prévia da loja não vaza');

  const daLoja = await listar('loja');
  const lojaVe = porId(daLoja);
  assert.deepEqual(ordenar([...lojaVe.keys()]), ordenar([c.paciente.id, c.clienteAlpins.id]));
  assert.deepEqual(lojaVe.get(c.paciente.id).selos, { clinica: false, agentes: [{ id: c.alpins.id, nome: 'Agente Alpins' }] },
    'para a loja o paciente nunca aparece como "Clínica"');
  assert.ok(!('observacoes' in lojaVe.get(c.paciente.id)), 'lista branca: observação nem existe para a loja');
  assert.deepEqual(daLoja.agentes.map((agente) => agente.nome), ['Agente Alpins'], 'filtro só com os agentes da equipe');

  assert.equal((await c.pedir('loja', `/api/contatos/${c.manual.id}`)).status, 404);
  assert.equal((await c.pedir('loja', `/api/contatos/${c.clienteBravo.id}`)).status, 404);
  assert.equal((await c.pedir('loja', `/api/contatos/${c.clienteBravo.id}/conversas`)).status, 404);
  assert.equal((await c.pedir('loja', `/api/contatos/${c.manual.id}`, { metodo: 'PUT', corpo: { nome: 'x' } })).status, 403,
    'atendente não edita contato (RBAC) — e o escopo não abre exceção');
  const fichaPaciente = await c.pedir('loja', `/api/contatos/${c.paciente.id}`);
  assert.equal(fichaPaciente.status, 200);
  assert.deepEqual(fichaPaciente.json.historico.conversas.map((conversa) => conversa.id), [c.conversaPacienteLoja.id]);
  assert.deepEqual(fichaPaciente.json.historico.notas, []);
  assert.deepEqual(fichaPaciente.json.historico.agendamentos, []);
  assert.ok(!JSON.stringify(fichaPaciente.json).includes('texto da clínica'));
  assert.ok(!JSON.stringify(fichaPaciente.json).includes('sigilosa'));

  assert.equal((await listar('loja', '&origem=clinica')).contatos.length, 0, 'loja filtrando "Clínica" não abre nada');
  assert.deepEqual(ordenar([...porId(await listar('atendenteClinica', `&origem=${c.alpins.id}`)).keys()]), ordenar([c.paciente.id, c.clienteAlpins.id]));
  const busca = (await c.pedir('loja', '/api/contatos?busca=5516900005')).json.contatos.map((contato) => contato.id);
  assert.deepEqual(ordenar(busca.filter((id) => nossos.includes(id))), ordenar([c.paciente.id, c.clienteAlpins.id]));
});

test('agentes: gestor fora da equipe não vê o agente; na equipe vê só o dele; equipe e marca mudam o escopo na hora e são auditadas', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  assert.deepEqual((await c.pedir('gestorClinica', '/api/agentes')).json.agentes, []);
  for (const sub of ['', '/operacao', '/whatsapp', '/equipe']) {
    assert.equal((await c.pedir('gestorClinica', `/api/agentes/${c.alpins.id}${sub}`)).status, 404, `gestor da clínica ${sub || 'detalhe'}`);
  }
  assert.deepEqual((await c.pedir('gestorClinica', '/api/agentes/aguardando')).json, { total: 0, por_agente: [] });

  assert.deepEqual((await c.pedir('gestorAlpins', '/api/agentes')).json.agentes.map((agente) => agente.nome), ['Agente Alpins']);
  assert.equal((await c.pedir('gestorAlpins', `/api/agentes/${c.bravo.id}`)).status, 404);
  const equipe = await c.pedir('gestorAlpins', `/api/agentes/${c.alpins.id}/equipe`);
  assert.equal(equipe.status, 200);
  assert.deepEqual(ordenar(equipe.json.membros.map((membro) => membro.usuario_id)), ordenar([c.ids.gestorAlpins, c.ids.loja]));

  // Colocar o gestor da clínica na equipe abre o Alpins para ele na requisição seguinte.
  const entrou = await c.pedir('admin', `/api/agentes/${c.alpins.id}/equipe`, { metodo: 'POST', corpo: { usuario_id: c.ids.gestorClinica } });
  assert.equal(entrou.status, 200);
  assert.equal(entrou.json.adicionado, true);
  assert.equal((await c.pedir('gestorClinica', `/api/conversas/${c.conversaAlpins.id}`)).status, 200);
  const saiu = await c.pedir('admin', `/api/agentes/${c.alpins.id}/equipe/${c.ids.gestorClinica}`, { metodo: 'DELETE' });
  assert.equal(saiu.status, 200);
  assert.equal((await c.pedir('gestorClinica', `/api/conversas/${c.conversaAlpins.id}`)).status, 404, 'sair da equipe vale na hora');
  assert.equal((await c.pedir('admin', `/api/agentes/${c.alpins.id}/equipe/${c.ids.gestorClinica}`, { metodo: 'DELETE' })).status, 404);

  // "Vê a clínica": devolver à loja abre a clínica; tirar de novo fecha.
  const abriu = await c.pedir('admin', `/api/usuarios/${c.ids.loja}/acesso-clinica`, { metodo: 'POST', corpo: { acesso_clinica: true } });
  assert.equal(abriu.status, 200);
  assert.equal(abriu.json.usuario.acesso_clinica, true);
  assert.notEqual((await c.pedir('loja', '/api/conversas/aguardando')).status, 403);
  await c.pedir('admin', `/api/usuarios/${c.ids.loja}/acesso-clinica`, { metodo: 'POST', corpo: { acesso_clinica: false } });
  assert.equal((await c.pedir('loja', '/api/conversas/aguardando')).status, 403);
  assert.equal((await c.pedir('admin', `/api/usuarios/${c.ids.admin}/acesso-clinica`, { metodo: 'POST', corpo: { acesso_clinica: false } })).status, 409,
    'admin sempre vê a clínica');
  assert.equal((await c.pedir('admin', `/api/usuarios/${c.ids.loja}/acesso-clinica`, { metodo: 'POST', corpo: { acesso_clinica: 'não' } })).status, 400);

  const usuarios = (await c.pedir('admin', '/api/usuarios')).json.usuarios;
  const lojaNaLista = usuarios.find((usuario) => usuario.id === c.ids.loja);
  assert.equal(lojaNaLista.acesso_clinica, false);
  assert.deepEqual(lojaNaLista.equipes, [{ id: c.alpins.id, nome: 'Agente Alpins' }]);

  const { itens } = await c.repositorio.listarAuditoria({ limite: 200 });
  const acoes = itens.map((item) => item.acao);
  assert.ok(acoes.includes('agente_equipe_adicionado'));
  assert.ok(acoes.includes('agente_equipe_removido'));
  assert.equal(acoes.filter((acao) => acao === 'acesso_clinica_alterado').length, 2);
  for (const item of itens.filter((registro) => registro.acao.startsWith('agente_equipe') || registro.acao === 'acesso_clinica_alterado')) {
    assert.ok(!JSON.stringify(item.detalhe ?? {}).match(/\d{10,}/), 'auditoria sem telefone');
  }
});

// ---------------------------------------------------------------- chat ao vivo

function respostaFalsa() {
  const linhas = [];
  return {
    write(linha) { linhas.push(linha); return true; },
    on() {},
    end() {},
    recebeu(id) { return linhas.some((linha) => linha.startsWith(`id: ${id}\n`)); },
  };
}

test('chat ao vivo: evento do Alpins só chega à equipe dele; o da clínica não chega à loja', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const emissor = criarEmissorDeConversas({ repositorio: c.repositorio });

  const assinaturas = {
    admin: [respostaFalsa(), { papel: 'admin', usuarioId: c.ids.admin }],
    gestorClinica: [respostaFalsa(), { papel: 'gestor', usuarioId: c.ids.gestorClinica, escopo: { clinica: true, agentes: [] } }],
    atendenteClinica: [respostaFalsa(), { papel: 'atendente', usuarioId: c.ids.atendenteClinica, escopo: () => ({ clinica: true, agentes: [] }) }],
    loja: [respostaFalsa(), { papel: 'atendente', usuarioId: c.ids.loja, escopo: { clinica: false, agentes: [c.alpins.id] } }],
    semEscopo: [respostaFalsa(), { papel: 'gestor', usuarioId: 777 }],
  };
  for (const [res, dados] of Object.values(assinaturas)) emissor.inscrever(res, dados);

  const daClinica = await emissor.publicar({ conversaId: c.conversaClinica.id, tipo: 'mensagem_recebida' });
  const doAlpins = await emissor.publicar({ conversaId: c.conversaAlpins.id, tipo: 'mensagem_recebida' });

  const recebeu = (nome, evento) => assinaturas[nome][0].recebeu(evento.id);
  assert.deepEqual([recebeu('admin', daClinica), recebeu('admin', doAlpins)], [true, true]);
  assert.deepEqual([recebeu('gestorClinica', daClinica), recebeu('gestorClinica', doAlpins)], [true, false]);
  assert.deepEqual([recebeu('atendenteClinica', daClinica), recebeu('atendenteClinica', doAlpins)], [true, false]);
  assert.deepEqual([recebeu('loja', daClinica), recebeu('loja', doAlpins)], [false, true]);
  assert.deepEqual([recebeu('semEscopo', daClinica), recebeu('semEscopo', doAlpins)], [true, false],
    'sem escopo declarado, quem não é admin não recebe agente');

  // Replay e releitura cross-processo com o mesmo recorte.
  const replayLoja = await c.repositorio.listarEventosDeConversasDesde({
    cursor: 0, papel: 'atendente', usuarioId: c.ids.loja, escopo: { clinica: false, agentes: [c.alpins.id] },
  });
  assert.ok(replayLoja.every((evento) => evento.agente_id === c.alpins.id));
  assert.ok(replayLoja.some((evento) => evento.id === doAlpins.id));

  const res = respostaFalsa();
  let cursor = 0;
  const releitura = criarReleituraDeEventos({
    res, repositorio: c.repositorio, usuarioId: c.ids.loja, papel: 'atendente',
    escopo: () => ({ clinica: false, agentes: [c.alpins.id] }),
    cursorAtual: () => cursor, avancarCursor: (id) => { cursor = Math.max(cursor, id); },
  });
  await releitura.tick();
  assert.equal(res.recebeu(doAlpins.id), true);
  assert.equal(res.recebeu(daClinica.id), false);
});
