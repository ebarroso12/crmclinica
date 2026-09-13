'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CABECALHOS_SEGURANCA } = require('../src/servidor/http');

// Invariantes de OWASP que já valem neste código, travados para não se perderem.
//
// A maior parte destas defesas não é nova: o repositório já parametriza todo
// SQL, já serve CSP estrita, já decide acesso por RBAC + escopo + RLS. O que
// faltava era o teste que impede a próxima edição de desfazer isso em silêncio
// — invariante sem teste é intenção, não garantia.

const RAIZ = path.join(__dirname, '..');
const REPOSITORIO = fs.readFileSync(path.join(RAIZ, 'src', 'dados', 'repositorio.js'), 'utf8');

// ------------------------------------------------------------- A03: injeção

test('todo SQL dinâmico monta só NOME DE COLUNA, e a partir de lista branca', () => {
  // O padrão seguro do repositório: `partes` recebe `campo = $N` onde `campo`
  // passou por uma lista branca literal, e o VALOR vai sempre como parâmetro.
  // Interpolar valor — em vez de nome de coluna — é o caminho clássico de
  // injeção, e é exatamente o que este teste impede de aparecer.
  const funcoes = REPOSITORIO.split(/\n    async /).slice(1);
  const comSqlDinamico = funcoes.filter((corpo) => /\$\{partes\.join\(/.test(corpo));

  assert.ok(comSqlDinamico.length >= 5, 'esperava encontrar os UPDATEs dinâmicos do repositório');

  for (const corpo of comSqlDinamico) {
    const nome = corpo.slice(0, corpo.indexOf('(')).trim();

    // Duas formas seguras, e o que as separa é a origem do NOME DA COLUNA:
    //
    //   a) a função percorre as chaves que o chamador mandou — aí precisa de
    //      lista branca, senão a chave vira nome de coluna;
    //   b) os nomes são literais no próprio código (`acrescentar('modo_entrega',
    //      …)`) — não há nome dinâmico nenhum, e lista branca ali não
    //      acrescentaria nada.
    const percorreEntradaDoChamador = /Object\.(entries|keys)\(/.test(corpo);
    if (percorreEntradaDoChamador) {
      assert.match(
        corpo, /permitidos|PERMITIDOS|COLUNAS/,
        `${nome}: percorre chaves do chamador sem lista branca — a chave viraria nome de coluna`,
      );
    }

    assert.match(
      corpo, /valores\.push\(/,
      `${nome}: o valor precisa ir como parâmetro, nunca interpolado`,
    );
  }
});

test('nenhuma consulta interpola valor vindo de fora direto no SQL', () => {
  // Procura a forma perigosa: `${algo}` dentro de aspas no SQL, que é como um
  // valor entraria no texto do comando em vez de ir como parâmetro.
  const perigosas = [...REPOSITORIO.matchAll(/consultar\(`[^`]*'\$\{[^}]+\}'/g)];
  assert.deepEqual(
    perigosas.map((m) => m[0].slice(0, 80)), [],
    'valor interpolado entre aspas no SQL é injeção esperando acontecer',
  );
});

test('o identificador de conversa é validado antes de virar consulta', () => {
  // IDOR/BOLA começa antes do escopo: id que não é número nem deve chegar ao
  // banco. `exigirIdentificador` é quem recusa.
  const rotas = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'rotas-conversas.js'), 'utf8');
  assert.match(rotas, /function exigirIdentificador/);
  const funcao = rotas.slice(rotas.indexOf('function exigirIdentificador'));
  assert.match(funcao.slice(0, 400), /Number\.isInteger|\/\^\\d/);
});

// ----------------------------------------------------------------- A07: XSS

test('a interface não injeta HTML com dado vindo do servidor', () => {
  // Com CSP estrita (`script-src 'self'`, sem inline) um XSS já teria pouco
  // para onde ir, mas a defesa que vale é não criar a injeção.
  const app = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');

  // O QUE ESTE TESTE PROVA, E O QUE NÃO PROVA.
  //
  // Uma varredura genérica por "interpolação sem escape" não funciona aqui, e
  // eu tentei: ela acusa `${versao.id}` (número em atributo `data-`), acusa
  // template aninhado que só monta marcação, e acusa a montagem intermediária
  // de uma string que É escapada no ponto de inserção. Ruído assim faz alguém
  // desligar o teste — e teste desligado não protege nada.
  //
  // Então a checagem é estreita e confiável: os campos de TEXTO LIVRE, que a
  // pessoa digita e o banco guarda como veio, nunca entram no HTML sem passar
  // por um dos dois escapes do projeto. É a classe que de fato carrega
  // marcação — e foi assim que `criado_por` (o nome do usuário) apareceu cru.
  const CAMPOS_DE_TEXTO_LIVRE = [
    'nome', 'titulo', 'descricao', 'instancia', 'motivo', 'observacao',
    'criado_por', 'autor', 'autor_nome', 'conteudo', 'comportamento',
  ];

  // Uma exceção, e ela é o padrão CERTO, não um desvio: `canais` é montado num
  // passo intermediário e escapado no ponto de inserção (`${escapar(canais)}`)
  // — escapar na fronteira é onde se deve escapar. O recorte por `;` desta
  // varredura não distingue o passo intermediário do HTML final, então a
  // exceção fica nomeada aqui em vez de a checagem ser afrouxada para todos.
  const CONSTRUCAO_ESCAPADA_NA_INSERCAO = /canal\.instancia/;

  const cruas = [];
  for (const atribuicao of app.matchAll(/innerHTML\s*=[^;]*;/g)) {
    for (const interpolacao of atribuicao[0].matchAll(/\$\{([^}]*)\}/g)) {
      const expressao = interpolacao[1];
      if (/escapar\(|escaparAtributo\(|Number\(/.test(expressao)) continue;
      if (CONSTRUCAO_ESCAPADA_NA_INSERCAO.test(expressao)) continue;
      const campo = CAMPOS_DE_TEXTO_LIVRE.find((nome) => new RegExp(`\\.${nome}\\b`).test(expressao));
      if (campo) cruas.push(`${campo}: ${expressao.trim().slice(0, 60)}`);
    }
  }

  assert.deepEqual(cruas, [], 'texto livre precisa entrar escapado, ou por textContent');
});

test('o escape do projeto delega ao próprio navegador', () => {
  // A exceção acima só se sustenta se `escapar` realmente escapar — e ele
  // escapa pelo caminho mais confiável que existe: põe o texto em
  // `textContent` e lê de volta `innerHTML`, deixando o navegador decidir o
  // que precisa virar entidade. Melhor que uma lista de caracteres escrita à
  // mão, que é onde se esquece justamente o caso novo.
  const app = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
  const escapar = app.slice(app.indexOf('function escapar('), app.indexOf('function escapar(') + 260);

  assert.match(escapar, /textContent = String\(texto \?\? ''\)/);
  assert.match(escapar, /return div\.innerHTML/);
  assert.match(app, /function escaparAtributo\(/, 'atributo tem regra própria: aspas também');
});

// ------------------------------------------------ A05: cabeçalhos e CSP

test('a CSP continua estrita nos pontos que importam', () => {
  const csp = CABECALHOS_SEGURANCA['content-security-policy'];

  assert.match(csp, /script-src 'self'/, 'sem script inline e sem CDN');
  assert.ok(!csp.includes("'unsafe-inline'"), "'unsafe-inline' anula a CSP");
  assert.ok(!csp.includes("'unsafe-eval'"), "'unsafe-eval' anula a CSP");
  assert.match(csp, /frame-ancestors 'none'/, 'sem clickjacking');
  assert.match(csp, /base-uri 'none'/, 'sem sequestro de URL relativa');
  assert.match(csp, /object-src 'none'/);
});

test('em produção a CSP não admite WebSocket sem TLS', () => {
  // `ws:` seria um canal de saída para qualquer host, em texto claro. A
  // interface abre WebSocket de verdade (gateway de voz), então `wss:` fica.
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'http.js'), 'utf8');
  assert.match(fonte, /process\.env\.NODE_ENV === 'production' \? "'self' wss:" : "'self' ws: wss:"/);
});

test('os cabeçalhos fundamentais acompanham TODA resposta', () => {
  // Não só as de erro, não só as de API: `responder()` é o único caminho.
  for (const cabecalho of ['x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert.ok(CABECALHOS_SEGURANCA[cabecalho], `faltou ${cabecalho}`);
  }
  assert.equal(CABECALHOS_SEGURANCA['x-content-type-options'], 'nosniff');
  assert.equal(CABECALHOS_SEGURANCA['x-frame-options'], 'DENY');
});

// --------------------------------------------------- A09: log sem vazamento

test('o log de requisição não carrega corpo, telefone nem identidade', () => {
  // Observabilidade sem dado clínico: rota, método, status e duração bastam
  // para ligar um erro ao pedido. Stack trace e corpo ficam fora do que sai.
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'http.js'), 'utf8');

  // O OBJETO do log, não o comentário em volta: o comentário cita "corpo,
  // telefone ou usuário" justamente para dizer que eles NÃO entram, e uma
  // janela de caracteres em volta acusaria a própria documentação da regra.
  const inicio = fonte.indexOf("evento: 'http_request'");
  const objeto = fonte.slice(fonte.lastIndexOf('JSON.stringify({', inicio), fonte.indexOf('})', inicio));

  for (const proibido of ['telefone', 'corpo', 'body', 'senha', 'stack', 'usuario']) {
    assert.ok(!objeto.includes(proibido), `o log de requisição não pode carregar ${proibido}`);
  }
  // O que ele carrega é o suficiente para investigar sem identificar ninguém.
  for (const esperado of ['rota', 'metodo', 'status', 'duracao_ms', 'request_id']) {
    assert.ok(objeto.includes(esperado), `o log precisa de ${esperado} para ser investigável`);
  }
});

test('a resposta de erro não devolve stack trace', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'servidor', 'http.js'), 'utf8');
  // O 500 genérico responde mensagem fixa; o detalhe vive no log do servidor.
  assert.ok(!/responderJson\([^)]*erro\.stack/.test(fonte), 'stack trace nunca vai para o cliente');
});
