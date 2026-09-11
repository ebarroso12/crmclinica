'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  criarServicoDeAgentes, criarBuscadorDePagina, validarUrlPublica, ehEnderecoPrivado, htmlParaTexto,
} = require('../src/dominio/agentes/servico');
const { normalizarConfiguracoes } = require('../src/dominio/agentes/regras');
const { ErroDeContrato } = require('../src/contratos/erros');

// Serviço dos agentes, com repositório e motor FALSOS que seguem as
// assinaturas de docs/AGENTES.md. Isto prova validação, orquestração,
// auditoria sem conteúdo e a guarda do treinamento por website — NÃO prova o
// SQL do repositório real nem a qualidade da resposta do motor; nenhuma
// chamada de rede acontece aqui (fetch e DNS são falsos).

function repositorioFalso() {
  const agentes = new Map();
  const historico = [];
  const treinamentos = [];
  const auditoria = [];
  const ids = { agente: 1, historico: 1, treinamento: 1 };

  const montar = (agente) => ({
    ...agente,
    configuracoes: normalizarConfiguracoes(agente.configuracoes),
    canais: [...agente.canais],
    acoes_inatividade: [...agente.acoes_inatividade],
  });
  const registrarHistorico = (agenteId, comportamento, usuarioId) => {
    historico.unshift({ id: ids.historico++, agente_id: agenteId, comportamento, criado_por: usuarioId ?? null });
  };

  return {
    agentes, historico, treinamentos, auditoria,
    async listarAgentes() { return [...agentes.values()].map(montar); },
    async obterAgente(id) { const agente = agentes.get(Number(id)); return agente ? montar(agente) : null; },
    async obterAgentePorSlug(slug) {
      const agente = [...agentes.values()].find((item) => item.slug === slug);
      return agente ? montar(agente) : null;
    },
    async criarAgente(dados, { usuarioId = null } = {}) {
      if ([...agentes.values()].some((item) => item.slug === dados.slug)) {
        const erro = new Error('slug em uso'); erro.status = 409; throw erro;
      }
      const agente = {
        id: ids.agente++, descricao: null, empresa_nome: null, empresa_site: null, empresa_descricao: null,
        provedor: null, modelo: null, comportamento: '', ...dados, canais: [], acoes_inatividade: [],
      };
      agentes.set(agente.id, agente);
      if (agente.comportamento) registrarHistorico(agente.id, agente.comportamento, usuarioId);
      return montar(agente);
    },
    async atualizarAgente(id, campos, { usuarioId = null } = {}) {
      const agente = agentes.get(Number(id));
      if (campos.comportamento !== undefined && campos.comportamento !== agente.comportamento) {
        registrarHistorico(agente.id, campos.comportamento, usuarioId);
      }
      Object.assign(agente, campos);
      return montar(agente);
    },
    async listarHistoricoDeComportamento(agenteId, { limite = 20 } = {}) {
      return historico.filter((item) => item.agente_id === Number(agenteId)).slice(0, limite);
    },
    async listarTreinamentos(agenteId) { return treinamentos.filter((item) => item.agente_id === Number(agenteId)); },
    async criarTreinamento(agenteId, dados) {
      const treinamento = { id: ids.treinamento++, agente_id: Number(agenteId), status: 'treinado', ...dados };
      treinamentos.push(treinamento);
      return treinamento;
    },
    async removerTreinamento(agenteId, treinamentoId) {
      const indice = treinamentos.findIndex((item) => item.agente_id === Number(agenteId) && item.id === Number(treinamentoId));
      if (indice < 0) return false;
      treinamentos.splice(indice, 1);
      return true;
    },
    async definirAcoesDeInatividade(agenteId, acoes) {
      const agente = agentes.get(Number(agenteId));
      agente.acoes_inatividade = acoes.map((acao, indice) => ({ id: indice + 1, ...acao }));
      return agente.acoes_inatividade;
    },
    async definirCanaisDoAgente(agenteId, canais) {
      for (const outro of agentes.values()) {
        if (outro.id === Number(agenteId)) continue;
        if (outro.canais.some((c) => canais.some((n) => n.canal === c.canal && n.instancia === c.instancia))) {
          const erro = new Error('canal de outro agente'); erro.status = 409; throw erro;
        }
      }
      const agente = agentes.get(Number(agenteId));
      agente.canais = canais.map((canal, indice) => ({ id: indice + 1, ...canal }));
      return agente.canais;
    },
    async registrarAuditoria(registro) { auditoria.push(registro); },
    async comUsuario(_usuario, funcao) { return funcao(); },
  };
}

const COMPORTAMENTO = 'Você é o agente de teste. Responda com calma e diga só o que sabe.';

async function servicoComAgente(extras = {}) {
  const repositorio = repositorioFalso();
  const servico = criarServicoDeAgentes({ repositorio, ...extras });
  const agente = await servico.criar({ slug: 'teste', nome: 'Agente Teste', comportamento: COMPORTAMENTO }, { usuarioId: 3 });
  return { repositorio, servico, agente };
}

async function rejeitaComStatus(promessa, status) {
  await assert.rejects(promessa, (erro) => {
    assert.equal(erro.status, status, `esperava status ${status}, veio ${erro.status}: ${erro.message}`);
    return true;
  });
}

// ------------------------------------------------------------ CRUD e auditoria

test('criar valida, nasce desativado e audita sem o texto do comportamento', async () => {
  const { repositorio, agente } = await servicoComAgente();
  assert.equal(agente.status, 'desativado');
  assert.equal(agente.slug, 'teste');

  const registro = repositorio.auditoria.find((item) => item.acao === 'agente_criado');
  assert.ok(registro, 'a criação precisa ficar na auditoria');
  assert.equal(registro.entidade, 'agente');
  assert.equal(registro.usuarioId, 3);
  assert.ok(!JSON.stringify(repositorio.auditoria).includes('agente de teste'), 'auditoria não carrega conteúdo');
});

test('criar com slug que já existe responde 409 antes de gravar', async () => {
  const { servico, repositorio } = await servicoComAgente();
  await rejeitaComStatus(servico.criar({ slug: 'teste', nome: 'Outro' }), 409);
  assert.equal(repositorio.agentes.size, 1);
});

test('criar recusa entrada inválida com ErroDeContrato', async () => {
  const servico = criarServicoDeAgentes({ repositorio: repositorioFalso() });
  await assert.rejects(servico.criar({ nome: 'sem slug' }), ErroDeContrato);
  await assert.rejects(servico.criar({ slug: 'ok', nome: 'x', campo_novo: 1 }), ErroDeContrato);
});

test('obter devolve agente, treinamentos e histórico; inexistente é 404', async () => {
  const { servico, agente } = await servicoComAgente();
  const detalhe = await servico.obter(agente.id);
  assert.equal(detalhe.agente.id, agente.id);
  assert.deepEqual(detalhe.treinamentos, []);
  assert.equal(detalhe.historico.length, 1);

  await rejeitaComStatus(servico.obter(999), 404);
});

test('atualizar mescla configurações: mudar um interruptor não zera os outros', async () => {
  const { servico, agente, repositorio } = await servicoComAgente();
  await servico.atualizar(agente.id, { configuracoes: { usar_emojis: true, limite_interacoes: 5 } });
  const depois = await servico.atualizar(agente.id, { configuracoes: { assinar_nome: true } }, { usuarioId: 3 });

  assert.equal(depois.configuracoes.usar_emojis, true, 'o valor anterior continua');
  assert.equal(depois.configuracoes.limite_interacoes, 5);
  assert.equal(depois.configuracoes.assinar_nome, true);

  const ultima = repositorio.auditoria.at(-1);
  assert.deepEqual(ultima.detalhe, { campos: ['configuracoes'] });
});

test('atualizar status registra de/para na auditoria; vazio e campo desconhecido são recusados', async () => {
  const { servico, agente, repositorio } = await servicoComAgente();
  await servico.atualizar(agente.id, { status: 'ativo' }, { usuarioId: 3 });
  assert.deepEqual(repositorio.auditoria.at(-1).detalhe, { campos: ['status'], status_de: 'desativado', status_para: 'ativo' });

  await assert.rejects(servico.atualizar(agente.id, {}), ErroDeContrato);
  await assert.rejects(servico.atualizar(agente.id, { stats: 'ativo' }), ErroDeContrato);
  await rejeitaComStatus(servico.atualizar(999, { status: 'ativo' }), 404);
});

test('atualizar para um slug de outro agente é 409', async () => {
  const { servico, agente } = await servicoComAgente();
  await servico.criar({ slug: 'outro', nome: 'Outro' });
  await rejeitaComStatus(servico.atualizar(agente.id, { slug: 'outro' }), 409);
});

test('restaurar comportamento volta a versão escolhida do histórico', async () => {
  const { servico, agente } = await servicoComAgente();
  await servico.atualizar(agente.id, { comportamento: 'Versão nova, bem diferente da primeira.' });
  const { historico } = await servico.obter(agente.id);
  const original = historico.find((item) => item.comportamento === COMPORTAMENTO);

  const restaurado = await servico.restaurarComportamento(agente.id, original.id, { usuarioId: 3 });
  assert.equal(restaurado.comportamento, COMPORTAMENTO);
  await rejeitaComStatus(servico.restaurarComportamento(agente.id, 12345), 404);
});

// ---------------------------------------------------------------- treinamentos

test('treinamento de texto é validado e gravado; remoção inexistente é 404', async () => {
  const { servico, agente, repositorio } = await servicoComAgente();
  const treinamento = await servico.adicionarTreinamento(agente.id, { tipo: 'texto', conteudo: 'O tênis custa R$ 249,67.' });
  assert.equal(treinamento.tipo, 'texto');
  assert.equal(repositorio.auditoria.at(-1).detalhe.tipo, 'texto');
  assert.ok(!JSON.stringify(repositorio.auditoria.at(-1)).includes('249'), 'auditoria sem conteúdo do treinamento');

  await assert.rejects(servico.adicionarTreinamento(agente.id, { tipo: 'texto', conteudo: '   ' }), ErroDeContrato);
  assert.equal(await servico.removerTreinamento(agente.id, treinamento.id), true);
  await rejeitaComStatus(servico.removerTreinamento(agente.id, treinamento.id), 404);
});

test('treinamento por vídeo é recusado com 422 (fase 2), sem gravar', async () => {
  const { servico, agente, repositorio } = await servicoComAgente();
  await rejeitaComStatus(servico.adicionarTreinamento(agente.id, { tipo: 'video', conteudo: 'https://youtu.be/x' }), 422);
  assert.equal(repositorio.treinamentos.length, 0);
});

test('treinamento por website usa o buscador e grava texto, título e URL final', async () => {
  const pedidos = [];
  const buscarPagina = async (url) => {
    pedidos.push(url);
    return { titulo: 'Loja', texto: 'Tênis para trilha.\nFrete grátis.', urlFinal: 'https://loja.exemplo.com.br/final' };
  };
  const { servico, agente } = await servicoComAgente({ buscarPagina });
  const treinamento = await servico.adicionarTreinamento(agente.id, { tipo: 'website', url: 'https://loja.exemplo.com.br' });

  assert.deepEqual(pedidos, ['https://loja.exemplo.com.br']);
  assert.equal(treinamento.tipo, 'website');
  assert.equal(treinamento.titulo, 'Loja');
  assert.equal(treinamento.origem, 'https://loja.exemplo.com.br/final');
  assert.match(treinamento.conteudo, /Frete grátis/);
});

test('website sem texto aproveitável é 422 e não grava treinamento oco', async () => {
  const buscarPagina = async () => ({ titulo: null, texto: '', urlFinal: 'https://vazio.exemplo.com.br/' });
  const { servico, agente, repositorio } = await servicoComAgente({ buscarPagina });
  await rejeitaComStatus(servico.adicionarTreinamento(agente.id, { tipo: 'website', url: 'https://vazio.exemplo.com.br' }), 422);
  assert.equal(repositorio.treinamentos.length, 0);
});

// ------------------------------------------------------------ inatividade e canais

test('inatividade e canais passam pelas regras antes de gravar', async () => {
  const { servico, agente } = await servicoComAgente();
  const acoes = await servico.definirInatividade(agente.id, [{ apos_minutos: 10, acao: 'finalizar' }]);
  assert.equal(acoes[0].apos_minutos, 10);
  await assert.rejects(servico.definirInatividade(agente.id, [{ apos_minutos: 5, acao: 'interagir' }]), ErroDeContrato);

  const canais = await servico.definirCanais(agente.id, [{ canal: 'whatsapp', instancia: 'alpins' }]);
  assert.deepEqual(canais.map((c) => [c.canal, c.instancia, c.ativo]), [['whatsapp', 'alpins', true]]);
  await assert.rejects(servico.definirCanais(agente.id, [{ canal: 'whatsapp', instancia: '../x' }]), ErroDeContrato);
});

test('instância que já é de outro agente sobe como 409', async () => {
  const { servico, agente } = await servicoComAgente();
  const outro = await servico.criar({ slug: 'outro', nome: 'Outro' });
  await servico.definirCanais(agente.id, [{ canal: 'whatsapp', instancia: 'alpins' }]);
  await rejeitaComStatus(servico.definirCanais(outro.id, [{ canal: 'whatsapp', instancia: 'alpins' }]), 409);
});

// ------------------------------------------------------------------- teste

test('testar sem motor responde 503', async () => {
  const { servico, agente } = await servicoComAgente();
  await rejeitaComStatus(servico.testar(agente.id, { mensagens: [{ autor: 'cliente', texto: 'oi' }] }), 503);
});

test('testar mapeia a conversa para a forma do motor, com chave única por pedido', async () => {
  const chamadas = [];
  const motor = {
    async gerarResposta(entrada) {
      chamadas.push(entrada);
      return { partes: ['Olá!'], transferir: false, motivo: null, provedor: 'anthropic', modelo: 'x' };
    },
  };
  const { servico, agente } = await servicoComAgente({ motor });
  await servico.adicionarTreinamento(agente.id, { tipo: 'texto', conteudo: 'Frete grátis.' });

  const conversa = [
    { autor: 'cliente', texto: 'Oi' }, { autor: 'agente', texto: 'Olá, como posso ajudar?' }, { autor: 'cliente', texto: 'Tem frete?' },
  ];
  const primeira = await servico.testar(agente.id, { mensagens: conversa });
  await servico.testar(agente.id, { mensagens: conversa });

  assert.deepEqual(primeira, { partes: ['Olá!'], transferir: false, motivo: null, provedor: 'anthropic', modelo: 'x' });
  const [entrada, repetida] = chamadas;
  assert.equal(entrada.agente.id, agente.id);
  assert.equal(entrada.treinamentos.length, 1);
  assert.deepEqual(entrada.mensagens.map((m) => [m.autor_tipo, m.conteudo, m.privada, m.tipo]), [
    ['contato', 'Oi', false, 'texto'], ['automacao', 'Olá, como posso ajudar?', false, 'texto'], ['contato', 'Tem frete?', false, 'texto'],
  ]);
  assert.deepEqual(entrada.contato, { nome: 'Teste', telefone: null });
  assert.match(entrada.chaveIdempotencia, new RegExp(`^agente:${agente.id}:teste:[0-9a-f-]{36}$`));
  assert.notEqual(entrada.chaveIdempotencia, repetida.chaveIdempotencia, 'repetir o teste não pode reaproveitar resposta');
});

test('testar recusa conversa malformada e agente inexistente', async () => {
  const motor = { gerarResposta: async () => ({ partes: [] }) };
  const { servico, agente } = await servicoComAgente({ motor });

  await assert.rejects(servico.testar(agente.id, { mensagens: [] }), ErroDeContrato);
  await assert.rejects(servico.testar(agente.id, { mensagens: [{ autor: 'robo', texto: 'oi' }] }), ErroDeContrato);
  await assert.rejects(servico.testar(agente.id, { mensagens: [{ autor: 'cliente', texto: 'x'.repeat(2001) }] }), ErroDeContrato);
  await assert.rejects(servico.testar(agente.id, { mensagens: [{ autor: 'agente', texto: 'falando sozinho' }] }), ErroDeContrato);
  const longa = Array.from({ length: 31 }, () => ({ autor: 'cliente', texto: 'oi' }));
  await assert.rejects(servico.testar(agente.id, { mensagens: longa }), ErroDeContrato);
  await rejeitaComStatus(servico.testar(999, { mensagens: [{ autor: 'cliente', texto: 'oi' }] }), 404);
});

// ------------------------------------------------------------ guarda de endereço

test('ehEnderecoPrivado: reservados negados, públicos liberados', () => {
  for (const privado of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '[::1]', 'nao-e-ip',
  ]) {
    assert.equal(ehEnderecoPrivado(privado), true, `${privado} deveria ser negado`);
  }
  for (const publico of ['8.8.8.8', '172.32.0.1', '200.160.2.3', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    assert.equal(ehEnderecoPrivado(publico), false, `${publico} deveria ser liberado`);
  }
});

test('validarUrlPublica recusa o que não é https público na porta padrão', () => {
  for (const recusada of [
    'http://exemplo.com.br', 'ftp://exemplo.com.br', 'https://localhost/', 'https://servidor.local/',
    'https://127.0.0.1/', 'https://2130706433/', 'https://10.0.0.5/admin', 'https://[::1]/',
    'https://usuario:senha@exemplo.com.br/', 'https://exemplo.com.br:8443/', 'https://intranet/',
    'https://169.254.169.254/latest/meta-data', 'não é url',
  ]) {
    assert.throws(() => validarUrlPublica(recusada), (erro) => erro.status === 422, `${recusada} deveria ser recusada`);
  }
  assert.equal(validarUrlPublica('https://www.loslegendarios.org/').hostname, 'www.loslegendarios.org');
  assert.equal(validarUrlPublica('https://exemplo.com.br:443/x').pathname, '/x');
});

function respostaHtml(corpo, { status = 200, tipo = 'text/html; charset=utf-8', cabecalhos = {} } = {}) {
  return new Response(corpo, { status, headers: { 'content-type': tipo, ...cabecalhos } });
}

const lookupPublico = async () => [{ address: '93.184.216.34', family: 4 }];

test('buscador recusa host cujo DNS aponta para rede privada, antes de conectar', async () => {
  let conectou = false;
  const buscar = criarBuscadorDePagina({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }],
    fetchImpl: async () => { conectou = true; return respostaHtml('<p>x</p>'); },
  });
  await rejeitaComStatus(buscar('https://rebind.exemplo.com.br/'), 422);
  assert.equal(conectou, false);
});

test('buscador revalida cada redirecionamento e limita a quantidade', async () => {
  const paraHttp = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://exemplo.com.br/' } }),
  });
  await rejeitaComStatus(paraHttp('https://exemplo.com.br/'), 422);

  const paraInterno = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/' } }),
  });
  await rejeitaComStatus(paraInterno('https://exemplo.com.br/'), 422);

  let saltos = 0;
  const emCirculo = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => { saltos += 1; return new Response(null, { status: 302, headers: { location: `/volta-${saltos}` } }); },
  });
  await rejeitaComStatus(emCirculo('https://exemplo.com.br/'), 422);
  assert.equal(saltos, 4, 'a primeira requisição + 3 redirecionamentos, e para');
});

test('buscador segue redirecionamento válido, converte HTML e devolve a URL final', async () => {
  const pedidos = [];
  const buscar = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async (url, opcoes) => {
      pedidos.push([url, opcoes.redirect]);
      if (url === 'https://exemplo.com.br/') return new Response(null, { status: 301, headers: { location: '/loja' } });
      return respostaHtml('<html><head><title>Loja &amp; Cia</title><style>p{}</style></head><body><p>Tênis</p><script>alert(1)</script></body></html>');
    },
  });
  const pagina = await buscar('https://exemplo.com.br/');
  assert.deepEqual(pedidos, [['https://exemplo.com.br/', 'manual'], ['https://exemplo.com.br/loja', 'manual']]);
  assert.equal(pagina.urlFinal, 'https://exemplo.com.br/loja');
  assert.equal(pagina.titulo, 'Loja & Cia');
  assert.equal(pagina.texto, 'Tênis');
});

test('buscador recusa tipo que não é texto, HTTP de erro e tempo esgotado; corta corpo acima do teto', async () => {
  const imagem = criarBuscadorDePagina({ lookup: lookupPublico, fetchImpl: async () => respostaHtml('x', { tipo: 'image/png' }) });
  await rejeitaComStatus(imagem('https://exemplo.com.br/'), 422);

  const quebrado = criarBuscadorDePagina({ lookup: lookupPublico, fetchImpl: async () => respostaHtml('x', { status: 500 }) });
  await rejeitaComStatus(quebrado('https://exemplo.com.br/'), 422);

  const lento = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => { const erro = new Error('timeout'); erro.name = 'TimeoutError'; throw erro; },
  });
  await rejeitaComStatus(lento('https://exemplo.com.br/'), 422);

  const grande = criarBuscadorDePagina({
    lookup: lookupPublico, maxBytes: 10, fetchImpl: async () => respostaHtml('0123456789ABCDEF', { tipo: 'text/plain' }),
  });
  assert.equal((await grande('https://exemplo.com.br/')).texto, '0123456789');
});

test('htmlParaTexto tira script, estilo e comentário, decodifica entidades e mantém linhas', () => {
  const { titulo, texto } = htmlParaTexto(`
    <title> Página </title>
    <!-- segredo --><style>.a{}</style><noscript>ative o JS</noscript>
    <h1>Tênis&nbsp;Trail</h1><p>Preço: R$&#160;249,67 &lt;promo&gt;</p>
    <ul><li>34 ao 43</li><li>Frete &#x67;rátis</li></ul><script>fetch('/x')</script>`);
  assert.equal(titulo, 'Página');
  assert.equal(texto, 'Tênis Trail\nPreço: R$ 249,67 <promo>\n34 ao 43\nFrete grátis');
});

// ------------------------------------------------------------------- seeder

const seeder = require('../bin/semear-agentes');

test('importar o seeder não conecta em banco: só expõe funções puras', () => {
  // Lição de docs/INCIDENTE-REGRAS-SEMEADAS.md — se `main()` rodasse no
  // require, este teste já teria tentado ler .env e abrir conexão.
  for (const nome of ['lerArgumentos', 'validarArquivo', 'planejarSemeadura', 'aplicarPlano', 'descrever']) {
    assert.equal(typeof seeder[nome], 'function');
  }
  assert.deepEqual(seeder.lerArgumentos(['--arquivo=a.json']), {
    arquivo: 'a.json', aplicar: false, substituirCanais: false, substituirInatividade: false,
  });
  assert.deepEqual(seeder.lerArgumentos(['--aplicar', '--arquivo=a.json']), {
    arquivo: 'a.json', aplicar: true, substituirCanais: false, substituirInatividade: false,
  });
});

function alpins() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'configuracao', 'agentes', 'alpins.json'), 'utf8'));
}

test('o arquivo do Agente Alpins valida inteiro e vira plano de criação desativado', () => {
  const validado = seeder.validarArquivo(alpins());
  const plano = seeder.planejarSemeadura(validado);
  assert.equal(plano.acao, 'criar');
  assert.equal(plano.campos.status, 'desativado');
  assert.equal(plano.treinamentosNovos.length, 9);
  assert.deepEqual(plano.canais, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
  assert.match(seeder.descrever(plano), /Criar "Agente Alpins"/);
});

test('arquivo pedindo "ativo" é gravado desativado, com aviso', () => {
  const dados = { ...alpins(), status: 'ativo' };
  const plano = seeder.planejarSemeadura(seeder.validarArquivo(dados));
  assert.equal(plano.campos.status, 'desativado');
  assert.ok(plano.avisos.some((aviso) => aviso.includes('ativo')));
});

test('arquivo com treinamento inválido falha inteiro, apontando o índice', () => {
  const dados = alpins();
  dados.treinamentos.push({ tipo: 'texto', conteudo: '' });
  assert.throws(() => seeder.validarArquivo(dados), /treinamentos\[9\]/);
});

test('re-semear um agente existente não mexe no status e só acrescenta treinamento novo', () => {
  const validado = seeder.validarArquivo(alpins());
  const existente = {
    id: 7, ...validado.agente, status: 'ativo', nome: 'Nome editado no painel',
  };
  const jaGravados = validado.treinamentos.slice(0, 8).map((treinamento, indice) => ({
    id: indice + 1, ...treinamento, conteudo: `  ${treinamento.conteudo}  `,
  }));

  const plano = seeder.planejarSemeadura(validado, existente, jaGravados);
  assert.equal(plano.acao, 'atualizar');
  assert.deepEqual(plano.camposAlterados, ['nome']);
  assert.ok(!('status' in plano.campos), 'status de agente existente é do painel');
  assert.equal(plano.treinamentosNovos.length, 1, 'espaço em volta não faz o mesmo treinamento parecer novo');
});

test('aplicarPlano grava tudo dentro de uma transação e audita sem conteúdo', async () => {
  const repositorio = repositorioFalso();
  let transacoes = 0;
  const comUsuarioOriginal = repositorio.comUsuario;
  repositorio.comUsuario = async (usuario, funcao) => { transacoes += 1; return comUsuarioOriginal(usuario, funcao); };

  const plano = seeder.planejarSemeadura(seeder.validarArquivo(alpins()));
  const agente = await seeder.aplicarPlano(repositorio, plano);

  assert.equal(transacoes, 1);
  assert.equal(agente.status, 'desativado');
  assert.equal(repositorio.treinamentos.length, 9);
  const agora = await repositorio.obterAgente(agente.id);
  assert.deepEqual(agora.canais.map((c) => c.instancia), ['alpins']);
  assert.equal(agora.acoes_inatividade.length, 1);

  const registro = repositorio.auditoria.find((item) => item.acao === 'agente_semeado');
  assert.equal(registro.detalhe.treinamentos_novos, 9);
  assert.ok(!JSON.stringify(registro).includes('Mountain Trail'));
});

// ------------------------------------------------------- painel de operação

test('pausar leva a desativado, audita com motivo e repetir não audita de novo', async () => {
  const { servico, repositorio, agente } = await servicoComAgente();
  await repositorio.atualizarAgente(agente.id, { status: 'ativo' });

  const pausado = await servico.pausar(agente.id, { motivo: '  almoço da equipe ' }, { usuarioId: 3 });
  assert.equal(pausado.mudou, true);
  assert.equal(pausado.agente.status, 'desativado');
  const registro = repositorio.auditoria.find((item) => item.acao === 'agente_pausado');
  assert.deepEqual(registro.detalhe, { status_de: 'ativo', motivo: 'almoço da equipe' }, 'motivo limpo de caractere de controle');
  assert.equal(registro.usuarioId, 3);

  const repetido = await servico.pausar(agente.id, {}, { usuarioId: 3 });
  assert.equal(repetido.mudou, false);
  assert.equal(repositorio.auditoria.filter((item) => item.acao === 'agente_pausado').length, 1);
});

test('pausar sem motivo não grava motivo; motivo inválido é ErroDeContrato antes de mudar status', async () => {
  const { servico, repositorio, agente } = await servicoComAgente();
  await repositorio.atualizarAgente(agente.id, { status: 'ativo' });

  await assert.rejects(servico.pausar(agente.id, { motivo: 'x'.repeat(201) }), ErroDeContrato);
  await assert.rejects(servico.pausar(agente.id, { motivo: 42 }), ErroDeContrato);
  await assert.rejects(servico.pausar(agente.id, [1]), ErroDeContrato);
  assert.equal((await repositorio.obterAgente(agente.id)).status, 'ativo', 'recusa não pausa');

  await servico.pausar(agente.id, null);
  assert.deepEqual(repositorio.auditoria.find((item) => item.acao === 'agente_pausado').detalhe, { status_de: 'ativo' });
  await rejeitaComStatus(servico.pausar(999, {}), 404);
});

test('retomar leva a ativo e audita de onde veio; já ativo não muda', async () => {
  const { servico, repositorio, agente } = await servicoComAgente();

  const retomado = await servico.retomar(agente.id, { usuarioId: 4 });
  assert.equal(retomado.mudou, true);
  assert.equal(retomado.agente.status, 'ativo');
  assert.deepEqual(repositorio.auditoria.find((item) => item.acao === 'agente_retomado').detalhe, { status_de: 'desativado' });

  assert.equal((await servico.retomar(agente.id)).mudou, false);
  assert.equal(repositorio.auditoria.filter((item) => item.acao === 'agente_retomado').length, 1);
});

test('operação junta números, quem mudou o status por último e conversas — sem conteúdo de mensagem', async () => {
  // 02:30 UTC de 11/09 ainda é 10/09 em São Paulo: "hoje" começa 10/09 às 03:00 UTC.
  const instante = new Date('2026-09-11T02:30:00.000Z');
  const { servico, repositorio, agente } = await servicoComAgente({ agora: () => instante });
  const pedidos = {};
  const conversa = {
    id: 9, status: 'aberta', contato: { nome: 'Cliente da Loja', telefone: '5516900000009' },
    assumida_por_humano: true, ultima_msg_em: '2026-09-11T01:00:00.000Z', previa: 'texto do cliente', responsavel_nome: null,
  };
  Object.assign(repositorio, {
    async resumirOperacaoDoAgente(agenteId, opcoes) {
      pedidos.resumo = [agenteId, opcoes];
      return {
        acoes: [
          { acao: 'agente_respondida', hoje: 3, semana: 5, ultima: '2026-09-11T01:00:00.000Z' },
          { acao: 'acao_que_o_painel_nao_conhece', hoje: 1, semana: 1, ultima: null },
        ],
        conversas_novas: { hoje: 1, semana: 2 },
      };
    },
    async listarAuditoriaDoAgente(agenteId, opcoes) {
      pedidos.auditoria = [agenteId, opcoes];
      return [
        { acao: 'agente_atualizado', detalhe: { campos: ['nome'] }, criado_em: '2026-09-11T02:00:00.000Z', usuario_nome: 'Outra' },
        { acao: 'agente_pausado', detalhe: { status_de: 'ativo', motivo: 'almoço' }, criado_em: '2026-09-11T01:30:00.000Z', usuario_nome: 'Dra. Ana' },
      ];
    },
    async listarConversasDoAgenteAguardandoEquipe(agenteId, opcoes) { pedidos.aguardando = [agenteId, opcoes]; return [conversa]; },
    async listarConversas(opcoes) { pedidos.recentes = opcoes; return [conversa]; },
  });

  const operacao = await servico.operacao(agente.id);

  assert.equal(pedidos.resumo[1].hojeDesde, '2026-09-10T03:00:00.000Z');
  assert.equal(pedidos.resumo[1].semanaDesde, '2026-09-04T02:30:00.000Z');
  assert.ok(pedidos.resumo[1].acoes.includes('transferida_para_humano'));
  assert.deepEqual(pedidos.recentes, { agenteId: agente.id, limite: 10 });

  assert.deepEqual(operacao.agente, { id: agente.id, nome: 'Agente Teste', status: 'desativado' });
  assert.deepEqual(operacao.status_alterado, {
    acao: 'agente_pausado', status: 'desativado', motivo: 'almoço', em: '2026-09-11T01:30:00.000Z', por: 'Dra. Ana',
  }, 'atualização sem troca de status não conta como mudança');
  assert.deepEqual(operacao.numeros.conversas_novas, { hoje: 1, semana: 2 });
  assert.deepEqual(operacao.numeros.por_acao.agente_respondida, { hoje: 3, semana: 5, ultima: '2026-09-11T01:00:00.000Z' });
  assert.deepEqual(operacao.numeros.por_acao.agente_resposta_nao_entregue, { hoje: 0, semana: 0, ultima: null });
  assert.ok(!('acao_que_o_painel_nao_conhece' in operacao.numeros.por_acao));
  assert.deepEqual(operacao.aguardando, [{
    id: 9, status: 'aberta', contato_nome: 'Cliente da Loja', contato_telefone: '5516900000009',
    ultima_msg_em: '2026-09-11T01:00:00.000Z', assumida_por_humano: true, responsavel_nome: null,
  }]);
  assert.ok(!JSON.stringify(operacao).includes('texto do cliente'), 'prévia de mensagem não vai ao painel');
  await rejeitaComStatus(servico.operacao(999), 404);
});

test('aguardandoPorAgente soma o total', async () => {
  const { servico, repositorio } = await servicoComAgente();
  repositorio.contarConversasAguardandoEquipePorAgente = async () => [{ agente_id: 1, total: 2 }, { agente_id: 4, total: 3 }];
  assert.deepEqual(await servico.aguardandoPorAgente(), { total: 5, por_agente: [{ agente_id: 1, total: 2 }, { agente_id: 4, total: 3 }] });
});

function evolutionFalsa({ estado, conectar } = {}) {
  const chamadas = [];
  return {
    chamadas,
    disponivel: true,
    async estado(instancia) { chamadas.push(['estado', instancia]); return estado(instancia); },
    async conectar(instancia, opcoes) { chamadas.push(['conectar', instancia, opcoes]); return conectar(instancia, opcoes); },
  };
}

test('whatsapp: sem canal, Evolution ausente, estado da Evolution e falha dela viram estado — nunca exceção', async () => {
  const semEvolution = await servicoComAgente();
  assert.deepEqual(await semEvolution.servico.whatsapp(semEvolution.agente.id), {
    instancia: null, canal_ativo: false, estado: 'sem_canal', numero: null, perfil: null,
  });
  await semEvolution.repositorio.definirCanaisDoAgente(semEvolution.agente.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
  assert.equal((await semEvolution.servico.whatsapp(semEvolution.agente.id)).estado, 'nao_configurado');

  const evolution = evolutionFalsa({ estado: async () => ({ estado: 'conectado', numero: '5516991271838', perfil: 'Loja' }) });
  const conectado = await servicoComAgente({ evolution });
  await conectado.repositorio.definirCanaisDoAgente(conectado.agente.id, [
    { canal: 'whatsapp', instancia: 'antiga', ativo: false }, { canal: 'whatsapp', instancia: 'alpins', ativo: true },
  ]);
  assert.deepEqual(await conectado.servico.whatsapp(conectado.agente.id), {
    instancia: 'alpins', canal_ativo: true, estado: 'conectado', numero: '5516991271838', perfil: 'Loja',
  }, 'o canal ligado vence o desligado');
  assert.deepEqual(evolution.chamadas, [['estado', 'alpins']]);

  const quebrada = await servicoComAgente({
    evolution: evolutionFalsa({ estado: async () => { const erro = new Error('a Evolution não respondeu a tempo'); erro.status = 503; throw erro; } }),
  });
  await quebrada.repositorio.definirCanaisDoAgente(quebrada.agente.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: false }]);
  assert.deepEqual(await quebrada.servico.whatsapp(quebrada.agente.id), {
    instancia: 'alpins', canal_ativo: false, estado: 'erro', numero: null, perfil: null, erro: 'a Evolution não respondeu a tempo',
  });
});

test('conectarWhatsapp exige canal e Evolution, valida número e audita sem o número', async () => {
  const evolution = evolutionFalsa({ conectar: async () => ({ ja_conectado: false, codigo_pareamento: 'KD2ESVLA', qr: null }) });
  const { servico, repositorio, agente } = await servicoComAgente({ evolution });

  await rejeitaComStatus(servico.conectarWhatsapp(agente.id, {}), 422);
  await repositorio.definirCanaisDoAgente(agente.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);

  await assert.rejects(servico.conectarWhatsapp(agente.id, { numero: '123' }), ErroDeContrato);
  await assert.rejects(servico.conectarWhatsapp(agente.id, { numero: 5516991271838 }), ErroDeContrato);
  assert.equal(evolution.chamadas.length, 0, 'número inválido não chega à Evolution');

  const resultado = await servico.conectarWhatsapp(agente.id, { numero: '+55 (16) 99127-1838' }, { usuarioId: 3 });
  assert.deepEqual(resultado, { instancia: 'alpins', ja_conectado: false, codigo_pareamento: 'KD2ESVLA', qr: null });
  assert.deepEqual(evolution.chamadas, [['conectar', 'alpins', { numero: '5516991271838' }]]);
  const registro = repositorio.auditoria.find((item) => item.acao === 'agente_whatsapp_conexao_pedida');
  assert.deepEqual(registro.detalhe, { instancia: 'alpins', por_codigo: true, ja_conectado: false });
  assert.ok(!JSON.stringify(repositorio.auditoria).includes('99127'), 'o número não entra na auditoria');

  const semEvolution = await servicoComAgente();
  await semEvolution.repositorio.definirCanaisDoAgente(semEvolution.agente.id, [{ canal: 'whatsapp', instancia: 'x', ativo: true }]);
  await rejeitaComStatus(semEvolution.servico.conectarWhatsapp(semEvolution.agente.id, {}), 503);
});
