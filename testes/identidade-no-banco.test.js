'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorio } = require('../src/dados/repositorio');
const contexto = require('../src/dados/contexto');

// A mecânica de `comUsuario`: transação, identidade declarada e devolução da
// conexão. Estas asserções não precisam de PostgreSQL — precisam observar a
// sequência exata de comandos, que é onde os erros deste tipo moram.

/** Pool que registra tudo o que recebe e devolve o client que emprestou. */
function poolEspiao({ falharEm = null } = {}) {
  const comandos = [];
  let emprestados = 0;
  let devolvidos = 0;

  const client = {
    query(texto, valores) {
      comandos.push({ texto: String(texto).split('\n')[0].trim(), valores });
      if (falharEm && String(texto).includes(falharEm)) {
        throw new Error(`falha simulada em ${falharEm}`);
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      devolvidos += 1;
    },
  };

  return {
    async connect() {
      emprestados += 1;
      return client;
    },
    query(texto, valores) {
      comandos.push({ texto: `[POOL] ${String(texto).split('\n')[0].trim()}`, valores });
      return { rows: [], rowCount: 0 };
    },
    comandos,
    get emprestados() { return emprestados; },
    get devolvidos() { return devolvidos; },
  };
}

const textos = (pool) => pool.comandos.map((c) => c.texto);

test('a transação abre, declara o usuário e confirma', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  const resultado = await repositorio.comUsuario(42, async () => 'pronto');

  assert.equal(resultado, 'pronto');
  // Duas declarações, porque o banco pergunta duas coisas: `app.usuario_id`,
  // lido por `app_usuario_atual()`, e `request.jwt.claims`, lido por
  // `current_app_role()` — de que dependem todas as políticas do banco.
  assert.deepEqual(textos(pool), [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'COMMIT',
  ]);

  // O terceiro argumento `true` é o que torna o valor local à transação. Sem
  // ele, a identidade sobreviveria na conexão e a próxima requisição a herdaria.
  const declaracao = pool.comandos[1];
  assert.deepEqual(declaracao.valores, ['app.usuario_id', '42']);
});

test('o usuário vai como parâmetro, nunca concatenado no SQL', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  // `SET LOCAL` não aceita $1, e quem tenta contornar isso acaba interpolando um
  // valor vindo do token dentro do comando. `set_config` aceita parâmetro.
  await repositorio.comUsuario("1'; DROP TABLE usuarios; --", async () => null);

  const declaracao = pool.comandos[1];
  assert.equal(declaracao.texto, 'SELECT set_config($1, $2, true)');
  assert.equal(declaracao.valores[1], "1'; DROP TABLE usuarios; --");
  assert.ok(!declaracao.texto.includes('DROP'), 'o valor não pode entrar no texto do comando');
});

test('erro no meio desfaz tudo — meia escrita é pior que nenhuma', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await assert.rejects(
    () => repositorio.comUsuario(7, async () => {
      throw new Error('a rota falhou depois de gravar a mensagem');
    }),
    /a rota falhou/,
  );

  assert.deepEqual(textos(pool), [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'ROLLBACK',
  ]);
  assert.ok(!textos(pool).includes('COMMIT'));
});

test('o papel do usuário vai declarado ao banco, não só o id', async () => {
  // Sem isto, `current_app_role()` devolve `deny` e as políticas do banco
  // recusam todo INSERT — com o usuário identificado na aplicação e o
  // privilégio de tabela concedido. Foi exatamente o que aconteceu em produção
  // até esta declaração existir.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 42, papel: 'atendente' }, async () => null);

  const claims = pool.comandos.find((comando) => comando.valores?.[0] === 'request.jwt.claims');
  assert.ok(claims, 'as claims precisam ser declaradas');
  assert.deepEqual(JSON.parse(claims.valores[1]), { usuario_id: '42', app_role: 'atendente' });
});

test('sem papel informado, a transação não se promove a nada — fica no que a conexão já é', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  // A chamada antiga, só com o id, continua funcionando: assume `backend`, que
  // é o papel com que a conexão já nasce. Não há elevação de privilégio aqui.
  await repositorio.comUsuario(7, async () => null);

  const claims = pool.comandos.find((comando) => comando.valores?.[0] === 'request.jwt.claims');
  assert.deepEqual(JSON.parse(claims.valores[1]), { usuario_id: '7', app_role: 'backend' });
});

test('a conexão volta ao pool mesmo quando tudo dá errado', async () => {
  // Conexão não devolvida é conexão perdida: com pool pequeno, algumas falhas
  // seguidas deixam a clínica sem banco.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario(1, async () => 'ok');
  await assert.rejects(() => repositorio.comUsuario(1, async () => { throw new Error('x'); }));

  assert.equal(pool.emprestados, 2);
  assert.equal(pool.devolvidos, 2);
});

test('ROLLBACK que também falha não engole o erro original', async () => {
  // Conexão já perdida: o ROLLBACK não vai a lugar nenhum. Quem depura precisa
  // ver por que a rota falhou, não um erro de limpeza.
  const pool = poolEspiao({ falharEm: 'ROLLBACK' });
  const repositorio = criarRepositorio(pool);

  await assert.rejects(
    () => repositorio.comUsuario(1, async () => { throw new Error('causa de verdade'); }),
    /causa de verdade/,
  );
  assert.equal(pool.devolvidos, 1, 'e a conexão ainda assim é devolvida');
});

test('as consultas de dentro usam o client da transação, não o pool', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario(9, async (dentro) => {
    await dentro.verificarSaude();
  });

  // Nada marcado com [POOL]: uma consulta que escapasse para o pool rodaria em
  // outra conexão, fora da transação e sem a identidade declarada.
  assert.ok(
    !textos(pool).some((texto) => texto.startsWith('[POOL]')),
    'consulta dentro da transação não pode ir pelo pool',
  );
});

test('fora de comUsuario as consultas vão pelo pool', async () => {
  // Semeadura, manutenção e health check não têm usuário e não precisam de um.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.verificarSaude();

  assert.ok(textos(pool)[0].startsWith('[POOL]'));
});

test('o contexto não vaza para fora da requisição', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  assert.equal(contexto.atual(), null, 'antes');

  await repositorio.comUsuario(5, async () => {
    assert.equal(contexto.atual().usuarioId, 5, 'durante');
  });

  assert.equal(contexto.atual(), null, 'depois');
});

test('requisições paralelas não trocam de identidade', async () => {
  // O risco clássico de guardar identidade num campo do repositório: duas
  // requisições concorrentes, e a segunda sobrescreve a primeira no meio.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  const vistos = await Promise.all([1, 2, 3, 4, 5].map((id) => (
    repositorio.comUsuario(id, async () => {
      // Cede o controle no meio, dando chance de outra requisição atropelar.
      await new Promise((resolve) => setTimeout(resolve, 5 - id));
      return contexto.atual().usuarioId;
    })
  )));

  assert.deepEqual(vistos, [1, 2, 3, 4, 5]);
});

test('o repositório em memória oferece a mesma porta', async () => {
  const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
  const memoria = criarRepositorioEmMemoria();

  // Sem isto, uma rota que chama `comUsuario` quebraria em desenvolvimento e só
  // apareceria com banco configurado.
  assert.equal(typeof memoria.comUsuario, 'function');
  assert.equal(await memoria.comUsuario(1, async (dentro) => dentro.tipo), 'memoria');
});
