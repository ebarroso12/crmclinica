'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  criarBuscadorDePagina, validarUrlPublica, ehEnderecoPrivado, htmlParaTexto,
} = require('../src/dominio/agentes/servico');
const seeder = require('../bin/semear-agentes');
const { normalizarConfiguracoes } = require('../src/dominio/agentes/regras');

// Achados da auditoria de segurança dos agentes (API, tela e semeadura).
// Cada teste reproduz o cenário provado pela auditoria. NÃO prova DNS
// rebinding real nem o comportamento do fetch do Node com um site hostil de
// verdade: fetch, DNS e corpo são falsos, e nenhuma rede sai da máquina.

const lookupPublico = async () => [{ address: '93.184.216.34', family: 4 }];

async function rejeitaCom(promessa, { status, codigo }) {
  await assert.rejects(promessa, (erro) => {
    assert.equal(erro.status, status, `status esperado ${status}, veio ${erro.status}: ${erro.message}`);
    if (codigo) assert.equal(erro.codigo, codigo);
    return true;
  });
}

// ------------------------------------------------------------ ReDoS (MÉDIO)

test('HTML hostil de ~300 KB vira texto em tempo linear, sem travar o processo', () => {
  for (const [nome, pedaco] of [['<a', '<a'], ['<script ', '<script '], ['<!--', '<!--'], ['<title', '<title']]) {
    const hostil = pedaco.repeat(Math.ceil(300_000 / pedaco.length));
    const inicio = process.hrtime.bigint();
    htmlParaTexto(hostil);
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    assert.ok(ms < 500, `${nome} repetido levou ${ms.toFixed(0)}ms`);
  }
});

test('entrada acima do teto é cortada antes da conversão', () => {
  const enorme = `<p>${'a'.repeat(2 * 1024 * 1024)}</p><p>FIM</p>`;
  const inicio = process.hrtime.bigint();
  const { texto } = htmlParaTexto(enorme);
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
  assert.ok(!texto.includes('FIM'), 'o que passa do teto não é convertido');
  assert.ok(ms < 500, `2 MB levou ${ms.toFixed(0)}ms`);
});

test('a conversão linear mantém o resultado de antes: script, estilo, comentário e título fora', () => {
  const { titulo, texto } = htmlParaTexto(`
    <title> Página </title>
    <!-- segredo --><style>.a{}</style><noscript>ative o JS</noscript>
    <h1>Tênis&nbsp;Trail</h1><p>Preço: R$&#160;249,67 &lt;promo&gt;</p>
    <ul><li>34 ao 43</li><li>Frete &#x67;rátis</li></ul><SCRIPT type="x">fetch('/x')</SCRIPT >
    <br/>linha<br>outra<img src="a.png" alt="x"> fim <!-- sem fechar`);
  assert.equal(titulo, 'Página');
  assert.equal(texto, 'Tênis Trail\nPreço: R$ 249,67 <promo>\n34 ao 43\nFrete grátis\nlinha\noutra fim');
});

// ------------------------------------------- tempo esgotado no corpo (BAIXO)

test('site que goteja o corpo até estourar o tempo vira 422 site_inacessivel, nunca 500', async () => {
  const buscar = criarBuscadorDePagina({
    lookup: lookupPublico,
    timeoutMs: 150,
    fetchImpl: async (_url, opcoes) => {
      const corpo = new ReadableStream({
        start(controle) {
          controle.enqueue(new TextEncoder().encode('<p>começo'));
          // Igual ao fetch real: o aborte do sinal derruba a leitura do corpo.
          opcoes.signal.addEventListener('abort', () => controle.error(opcoes.signal.reason));
        },
      });
      return new Response(corpo, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  await rejeitaCom(buscar('https://exemplo.com.br/'), { status: 422, codigo: 'site_inacessivel' });
});

// ------------------------------------------------- DNS sem resposta (BAIXO)

test('DNS que nunca responde não segura a requisição além do tempo limite', async () => {
  let conectou = false;
  const buscar = criarBuscadorDePagina({
    lookup: () => new Promise(() => {}),
    timeoutMs: 150,
    fetchImpl: async () => { conectou = true; return new Response('x'); },
  });
  const inicio = Date.now();
  await rejeitaCom(buscar('https://exemplo.com.br/'), { status: 422, codigo: 'site_nao_encontrado' });
  assert.ok(Date.now() - inicio < 2000, 'desistiu perto do tempo limite');
  assert.equal(conectou, false);
});

// ------------------------------------------- guarda de host e de IP (BAIXO)

test('host com ponto final não escapa da lista de nomes locais', () => {
  for (const url of ['https://localhost./', 'https://intranet./', 'https://metadata.google.internal./',
    'https://servidor.local./', 'https://painel.localhost./']) {
    assert.throws(() => validarUrlPublica(url), (erro) => erro.status === 422, `${url} deveria ser recusada`);
  }
  assert.equal(validarUrlPublica('https://www.loslegendarios.org./').hostname, 'www.loslegendarios.org.');
});

test('faixas IPv6 de transição e legadas são negadas; IPv6 público continua liberado', () => {
  for (const privado of [
    '::ffff:0:7f00:1', // IPv4-translated (::ffff:0:0/96) apontando para 127.0.0.1
    '::ffff:0:a00:1', // IPv4-translated para 10.0.0.1
    '2002:7f00:1::1', // 6to4 embrulhando 127.0.0.1
    '2002:c000:0204::1', // 6to4 de qualquer coisa: a faixa inteira fica fora
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    'fec0::1', // site-local (legado)
    '100::1', // discard-only
  ]) {
    assert.equal(ehEnderecoPrivado(privado), true, `${privado} deveria ser negado`);
  }
  for (const publico of ['2001:4860:4860::8888', '2606:4700::6810:84e5', '2800:3f0:4001:80a::200e']) {
    assert.equal(ehEnderecoPrivado(publico), false, `${publico} deveria ser liberado`);
  }
});

test('tipo de conteúdo é o que vem antes do ";" — parâmetro não disfarça JSON de HTML', async () => {
  const disfarcado = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json; x=text/html' } }),
  });
  await rejeitaCom(disfarcado('https://exemplo.com.br/'), { status: 422, codigo: 'site_tipo' });

  const legitimo = criarBuscadorDePagina({
    lookup: lookupPublico,
    fetchImpl: async () => new Response('<p>ok</p>', { headers: { 'content-type': 'Text/HTML ; charset=UTF-8' } }),
  });
  assert.equal((await legitimo('https://exemplo.com.br/')).texto, 'ok');
});

// ------------------------------------------------- semeadura (MÉDIO)

function alpins() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'configuracao', 'agentes', 'alpins.json'), 'utf8'));
}

/** Repositório mínimo com o estado que o painel deixou: agente ativo, canal desligado, sem inatividade. */
function repositorioComAgenteEditadoNoPainel(validado) {
  const estado = {
    agente: {
      id: 7, ...validado.agente, status: 'ativo',
      configuracoes: normalizarConfiguracoes(validado.agente.configuracoes),
      canais: [{ id: 1, canal: 'whatsapp', instancia: 'alpins', ativo: false }],
      acoes_inatividade: [],
    },
    treinamentos: validado.treinamentos.map((treinamento, indice) => ({ id: indice + 1, ...treinamento })),
    auditoria: [],
  };
  return {
    estado,
    async comUsuario(_usuario, funcao) { return funcao(); },
    async obterAgente() { return { ...estado.agente }; },
    async atualizarAgente(_id, campos) { Object.assign(estado.agente, campos); return { ...estado.agente }; },
    async criarTreinamento(_id, treinamento) { estado.treinamentos.push(treinamento); return treinamento; },
    async definirAcoesDeInatividade(_id, acoes) { estado.agente.acoes_inatividade = acoes; return acoes; },
    async definirCanaisDoAgente(_id, canais) { estado.agente.canais = canais; return canais; },
    async registrarAuditoria(registro) { estado.auditoria.push(registro); },
  };
}

test('ressemear um agente existente NÃO religa canal desligado nem recria inatividade apagada', async () => {
  const validado = seeder.validarArquivo(alpins());
  const repositorio = repositorioComAgenteEditadoNoPainel(validado);

  const plano = seeder.planejarSemeadura(validado, repositorio.estado.agente, repositorio.estado.treinamentos);
  await seeder.aplicarPlano(repositorio, plano);

  assert.deepEqual(repositorio.estado.agente.canais, [{ id: 1, canal: 'whatsapp', instancia: 'alpins', ativo: false }]);
  assert.deepEqual(repositorio.estado.agente.acoes_inatividade, []);
  assert.equal(repositorio.estado.agente.status, 'ativo');
  const descricao = seeder.descrever(plano);
  assert.match(descricao, /Canais: mantidos/);
  assert.match(descricao, /--substituir-canais/);
  assert.match(descricao, /Ações de inatividade: mantidas/);
});

test('com as flags explícitas, canais e inatividade do arquivo substituem os do banco', async () => {
  const validado = seeder.validarArquivo(alpins());
  const repositorio = repositorioComAgenteEditadoNoPainel(validado);

  const plano = seeder.planejarSemeadura(validado, repositorio.estado.agente, repositorio.estado.treinamentos, {
    substituirCanais: true, substituirInatividade: true,
  });
  await seeder.aplicarPlano(repositorio, plano);

  assert.deepEqual(repositorio.estado.agente.canais, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);
  assert.equal(repositorio.estado.agente.acoes_inatividade.length, 1);
});

test('as flags de substituição chegam pela linha de comando', () => {
  assert.deepEqual(seeder.lerArgumentos(['--arquivo=a.json', '--aplicar', '--substituir-canais']), {
    arquivo: 'a.json', aplicar: true, substituirCanais: true, substituirInatividade: false,
  });
});

test('com --aplicar, o seeder recusa conexão privilegiada em qualquer ambiente', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'semear-agentes.js'), 'utf8');
  assert.match(fonte, /exigirConexaoSegura\(pool, \{ producao: true \}\)/);
  assert.doesNotMatch(fonte, /exigirConexaoSegura\(pool, \{ producao: configuracao\.producao \}\)/);
});
