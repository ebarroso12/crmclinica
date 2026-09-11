'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { validarAgente } = require('../src/dominio/agentes/regras');

// Auditoria independente de ACESSO sobre 42939cf (docs/AGENTES.md, "Quem vê o quê").
// Regra que resolve a família: o colaborador (não vê a clínica) recebe dado de
// contato por LISTA BRANCA; nenhuma escrita dele toca tabela da clínica; e
// conversa de agente nunca carrega nem altera lead da clínica, para ninguém.
//
// Perfis: admin; gestorClinica (vê a clínica, fora da equipe); gestorAlpins (vê
// a clínica e está na equipe); loja (atendente, NÃO vê a clínica, equipe do
// Alpins); gestorLoja (GESTOR, NÃO vê a clínica, equipe do Alpins) — o perfil
// que a auditoria usou para ler e apagar dado clínico.

const SIGILOS = Object.freeze([
  'sigilo@clinica.test', 'OBS-CLINICA-SIGILOSA', 'ATRIBUTO-SIGILOSO', 'NOME-COMPLETO-SIGILOSO', '1980-01-02',
  'CPF-CIFRADO-SIGILOSO', '981110000', 'RESPONSAVEL-SIGILOSO', 'PARENTESCO-SIGILOSO', 'CONSENTIMENTO-SIGILOSO',
  'IDENT-SIGILOSO', 'MOTIVO-OPTOUT-SIGILOSO', 'INTERESSE-SIGILOSO',
]);

const CAMPOS_DE_LEAD = Object.freeze([
  'lead_id', 'temperatura', 'estagio', 'score', 'interesse', 'primeira_consulta',
  'pagamento', 'urgencia', 'disponibilidade', 'perdido_motivo',
]);

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
  const atendimento = criarAtendimento({ repositorio, orquestrador });
  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste() });

  const alpins = await repositorio.criarAgente(validarAgente({ slug: 'alpins-auditoria', nome: 'Agente Alpins' }), { usuarioId: null });

  // A mesma pessoa é paciente da clínica (ficha inteira preenchida, lead
  // qualificado, opt-out com motivo) e cliente do Alpins.
  const paciente = await repositorio.encontrarOuCriarContato({ telefone: '5516900006001', nome: 'Paciente Auditoria' });
  await repositorio.atualizarContato(paciente.id, {
    email: 'sigilo@clinica.test', observacoes: 'OBS-CLINICA-SIGILOSA', atributos: { plano: 'ATRIBUTO-SIGILOSO' },
    nomeCompleto: 'NOME-COMPLETO-SIGILOSO', nascimento: '1980-01-02', cpfCifrado: 'CPF-CIFRADO-SIGILOSO',
    whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: '981110000',
    responsavelNome: 'RESPONSAVEL-SIGILOSO', responsavelParentesco: 'PARENTESCO-SIGILOSO',
    consentimentoResponsavelEm: '2026-01-01T00:00:00.000Z', consentimentoCanal: 'CONSENTIMENTO-SIGILOSO',
    identificador: 'IDENT-SIGILOSO',
  });
  await repositorio.definirOptOutDeLembretes(paciente.id, { optout: true, motivo: 'MOTIVO-OPTOUT-SIGILOSO' });
  const conversaClinica = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp');
  await repositorio.registrarMensagem(conversaClinica.id, { direcao: 'entrada', conteudo: 'texto da clínica', autor_tipo: 'contato' });
  const lead = await repositorio.salvarLead(paciente.id, { conversaId: conversaClinica.id, temperatura: 'frio' });
  await repositorio.atualizarLead(lead.id, { interesse: 'INTERESSE-SIGILOSO', pagamento: 'convenio' });
  const conversaPacienteLoja = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp', { agenteId: alpins.id });
  await repositorio.registrarMensagem(conversaPacienteLoja.id, { direcao: 'entrada', conteudo: 'texto do paciente na loja', autor_tipo: 'contato' });

  const sessoes = {
    admin: await app.entrarComo('admin', { master: true }),
    gestorClinica: await app.entrarComo('gestor'),
    gestorAlpins: await app.entrarComo('gestor'),
    loja: await app.entrarComo('atendente'),
    gestorLoja: await app.entrarComo('gestor'),
  };
  const ids = Object.fromEntries(Object.entries(sessoes).map(([nome, sessao]) => [nome, sessao.usuario.id]));
  for (const membro of ['gestorAlpins', 'loja', 'gestorLoja']) await repositorio.adicionarMembroDaEquipe(alpins.id, ids[membro]);
  await repositorio.atualizarUsuario(ids.loja, { acessoClinica: false });
  await repositorio.atualizarUsuario(ids.gestorLoja, { acessoClinica: false });

  async function pedir(quem, rota, { metodo = 'GET', corpo } = {}) {
    const resposta = await app.pedirSemAuth(rota, {
      method: metodo,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessoes[quem].access_token}` },
      body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    });
    const texto = await resposta.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: resposta.status, json, texto };
  }

  return { app, repositorio, pedir, ids, alpins, paciente, lead, conversaClinica, conversaPacienteLoja };
}

// ------------------------------------------------------------------ A1

test('A1: conversa de agente não traz lead nem próxima ação da clínica — para ninguém; a da clínica segue igual', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  for (const quem of ['admin', 'gestorAlpins', 'loja', 'gestorLoja']) {
    const aberta = await c.pedir(quem, `/api/conversas/${c.conversaPacienteLoja.id}`);
    assert.equal(aberta.status, 200, quem);
    for (const campo of CAMPOS_DE_LEAD) assert.equal(aberta.json.conversa[campo], null, `${quem}: conversa aberta com ${campo}`);
    assert.equal(aberta.json.conversa.proxima_acao, null, `${quem}: próxima ação`);

    const lista = (await c.pedir(quem, `/api/conversas?fila=todos&agente=${c.alpins.id}`)).json.conversas;
    const item = lista.find((conversa) => conversa.id === c.conversaPacienteLoja.id);
    assert.ok(item, `${quem} vê a conversa do Alpins na lista`);
    for (const campo of CAMPOS_DE_LEAD) assert.equal(item[campo], null, `${quem}: lista com ${campo}`);
    assert.equal(item.proxima_acao, null);
    assert.ok(!aberta.texto.includes('INTERESSE-SIGILOSO') && !JSON.stringify(lista).includes('INTERESSE-SIGILOSO'));
  }

  const daClinica = (await c.pedir('gestorClinica', `/api/conversas/${c.conversaClinica.id}`)).json.conversa;
  assert.equal(daClinica.lead_id, c.lead.id, 'a conversa da clínica continua com o lead');
  assert.equal(daClinica.pagamento, 'convenio');
  assert.equal(daClinica.interesse, 'INTERESSE-SIGILOSO');
});

// ------------------------------------------------------------- A2 + M1

test('A2 + M1: quem não vê a clínica recebe contato por LISTA BRANCA em toda rota — id, nome, telefone e selos dos agentes dele', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const LISTA_BRANCA = new Set(['id', 'nome', 'telefone', 'selos']);
  const foraDaLista = (objeto, extras = []) => Object.keys(objeto ?? {})
    .filter((campo) => !LISTA_BRANCA.has(campo) && !extras.includes(campo));

  for (const quem of ['loja', 'gestorLoja']) {
    const conversa = await c.pedir(quem, `/api/conversas/${c.conversaPacienteLoja.id}`);
    assert.equal(conversa.status, 200, quem);
    assert.deepEqual(foraDaLista(conversa.json.ficha, ['notas', 'conversas_anteriores']), [], `${quem}: ficha da conversa`);
    assert.deepEqual(foraDaLista(conversa.json.conversa.contato), [], `${quem}: contato da conversa aberta`);

    const listaDeConversas = await c.pedir(quem, '/api/conversas?fila=todos');
    assert.ok(listaDeConversas.json.conversas.length > 0);
    for (const item of listaDeConversas.json.conversas) {
      assert.deepEqual(foraDaLista(item.contato), [], `${quem}: contato na lista de conversas`);
    }

    const ficha = await c.pedir(quem, `/api/contatos/${c.paciente.id}`);
    assert.equal(ficha.status, 200);
    assert.deepEqual(foraDaLista(ficha.json.contato), [], `${quem}: /api/contatos/:id`);
    assert.deepEqual(ficha.json.contato.selos, { clinica: false, agentes: [{ id: c.alpins.id, nome: 'Agente Alpins' }] });

    const historico = await c.pedir(quem, `/api/contatos/${c.paciente.id}/conversas`);
    assert.equal(historico.status, 200);
    assert.deepEqual(foraDaLista(historico.json.contato), [], `${quem}: /api/contatos/:id/conversas`);
    for (const item of historico.json.conversas) assert.deepEqual(foraDaLista(item.contato), []);

    const gestao = await c.pedir(quem, '/api/contatos/gestao?limite=500');
    const doPaciente = gestao.json.contatos.find((contato) => contato.id === c.paciente.id);
    assert.deepEqual(foraDaLista(doPaciente, ['conversas']), [], `${quem}: /api/contatos/gestao`);
    assert.ok(!('agendamentos' in doPaciente), 'M1: a contagem de agendamentos não vai para o colaborador');

    const busca = await c.pedir(quem, '/api/contatos?busca=5516900006');
    assert.ok(busca.json.contatos.some((contato) => contato.id === c.paciente.id));
    for (const item of busca.json.contatos) assert.deepEqual(foraDaLista(item), [], `${quem}: busca`);

    for (const resposta of [conversa, listaDeConversas, ficha, historico, gestao, busca]) {
      for (const sigilo of SIGILOS) assert.ok(!resposta.texto.includes(sigilo), `${quem}: "${sigilo}" vazou`);
    }
  }

  // Quem vê a clínica continua com a ficha inteira.
  const fichaDaClinica = await c.pedir('gestorClinica', `/api/contatos/${c.paciente.id}`);
  assert.equal(fichaDaClinica.json.contato.observacoes, 'OBS-CLINICA-SIGILOSA');
  assert.ok('agendamentos' in (await c.pedir('gestorClinica', '/api/contatos/gestao?limite=500')).json.contatos
    .find((contato) => contato.id === c.paciente.id));
  const conversaDaClinica = await c.pedir('gestorClinica', `/api/conversas/${c.conversaClinica.id}`);
  assert.equal(conversaDaClinica.json.ficha.nome_completo, 'NOME-COMPLETO-SIGILOSO');
  assert.equal(conversaDaClinica.json.conversa.contato.email, 'sigilo@clinica.test');
});

// ------------------------------------------------------------------ A3

test('A3: quem não vê a clínica não edita contato nem ficha — 403 sem tocar no cadastro; a clínica na equipe ainda edita', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  for (const quem of ['loja', 'gestorLoja']) {
    const contato = await c.pedir(quem, `/api/contatos/${c.paciente.id}`, {
      metodo: 'PUT', corpo: { observacoes: null, telefone: '5516900006999' },
    });
    assert.equal(contato.status, 403, `${quem} PUT /api/contatos/:id`);
    assert.equal(contato.json?.codigo, 'sem_acesso_clinica', `${quem} PUT /api/contatos/:id`);

    const ficha = await c.pedir(quem, `/api/conversas/${c.conversaPacienteLoja.id}/ficha`, {
      metodo: 'PUT', corpo: { observacoes: null, telefone: '5516900006998' },
    });
    assert.equal(ficha.status, 403, `${quem} PUT /api/conversas/:id/ficha`);
    assert.equal(ficha.json?.codigo, 'sem_acesso_clinica', `${quem} PUT ficha`);

    for (const resposta of [contato, ficha]) {
      for (const sigilo of SIGILOS) assert.ok(!resposta.texto.includes(sigilo), `${quem}: "${sigilo}" na resposta da recusa`);
    }
  }

  const intacto = await c.repositorio.obterContato(c.paciente.id);
  assert.equal(intacto.observacoes, 'OBS-CLINICA-SIGILOSA', 'observação não foi apagada');
  assert.equal(intacto.telefone, '5516900006001', 'telefone do paciente não foi trocado');

  const daEquipeComClinica = await c.pedir('gestorAlpins', `/api/contatos/${c.paciente.id}`, {
    metodo: 'PUT', corpo: { nome: 'Paciente Auditoria' },
  });
  assert.equal(daEquipeComClinica.status, 200, 'quem vê a clínica continua editando');
});

// ------------------------------------------------------------------ M2

test('M2: etiqueta, temperatura e encerramento em conversa de agente não alteram nem copiam o lead da clínica — nem pelo admin', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());
  const antes = await c.repositorio.obterLeadPorContato(c.paciente.id);
  assert.equal(antes.temperatura, 'frio');

  const etiqueta = await c.pedir('admin', `/api/conversas/${c.conversaPacienteLoja.id}/etiquetas`, {
    metodo: 'POST', corpo: { etiquetas: ['lead_quente'] },
  });
  assert.equal(etiqueta.status, 200);
  assert.deepEqual(etiqueta.json.etiquetas, ['lead_quente'], 'a etiqueta fica na conversa do agente');
  const temperatura = await c.pedir('admin', `/api/conversas/${c.conversaPacienteLoja.id}/temperatura`, {
    metodo: 'POST', corpo: { temperatura: 'quente' },
  });
  assert.equal(temperatura.status, 200);

  const depois = await c.repositorio.obterLeadPorContato(c.paciente.id);
  assert.equal(depois.temperatura, 'frio', 'temperatura do lead da clínica intacta');
  assert.equal(depois.conversa_id, c.conversaClinica.id, 'o card do kanban continua abrindo a conversa da clínica');

  const encerrada = await c.pedir('admin', `/api/conversas/${c.conversaPacienteLoja.id}/encerrar`, { metodo: 'POST', corpo: {} });
  assert.equal(encerrada.status, 200);
  // O resumo interno fica numa mensagem privada da thread do agente: sem a
  // pendência calculada do lead e sem a agenda da clínica.
  assert.match(encerrada.json.resumo, /Pendência: nenhuma registrada/, 'pendência derivada do lead da clínica não entra');
  assert.match(encerrada.json.resumo, /Agendou: NÃO/, 'agenda da clínica não entra');
  const thread = await c.pedir('admin', `/api/conversas/${c.conversaPacienteLoja.id}/mensagens`);
  assert.ok(!thread.texto.includes('INTERESSE-SIGILOSO'));
  assert.equal((await c.repositorio.obterLeadPorContato(c.paciente.id)).conversa_id, c.conversaClinica.id);

  // Na conversa da clínica, a etiqueta continua levando o lead junto.
  await c.pedir('admin', `/api/conversas/${c.conversaClinica.id}/etiquetas`, { metodo: 'POST', corpo: { etiquetas: ['lead_quente'] } });
  assert.equal((await c.repositorio.obterLeadPorContato(c.paciente.id)).temperatura, 'quente');
});

// ------------------------------------------------------------------ B1

test('B1: PUT /api/contatos/:id confere o contato antes de ler o corpo — inexistente com corpo quebrado é 404, não 400', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  for (const quem of ['admin', 'gestorClinica']) {
    const inexistente = await c.pedir(quem, '/api/contatos/999999', { metodo: 'PUT', corpo: '{quebrado' });
    assert.equal(inexistente.status, 404, `${quem}: contato inexistente com corpo quebrado`);
  }

  const doColaborador = await c.pedir('gestorLoja', '/api/contatos/999999', { metodo: 'PUT', corpo: '{quebrado' });
  assert.equal(doColaborador.status, 403);
  assert.equal(doColaborador.json?.codigo, 'sem_acesso_clinica');

  const existente = await c.pedir('admin', `/api/contatos/${c.paciente.id}`, { metodo: 'PUT', corpo: '{quebrado' });
  assert.equal(existente.status, 400, 'com o contato conferido, o corpo quebrado continua 400');
});
