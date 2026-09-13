'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorio } = require('../src/dados/repositorio');

// "Assumir" respondia 500 e a conversa não era assumida (13/09/2026).
//
// O erro em produção era `new row violates row-level security policy for table
// "mensagens"`, em `POST /api/conversas/941/assumir`. A causa não estava no
// assumir: estava no AVISO que o assumir grava logo depois ("Conversa assumida
// pela equipe. A resposta automática está pausada.").
//
// A policy de INSERT em `mensagens` (`crm008_m_i`) diz, para o papel do
// usuário:
//
//   is_backend() OR (can_access_conversa(...) AND direcao='saida'
//                    AND autor_tipo='equipe' AND privada=false)
//
// que é a regra certa para o que uma PESSOA digita. Só que aquele aviso é
// `autor_tipo='sistema'` e `privada=true` — escrito pela aplicação, não pela
// pessoa. Dentro da requisição a conexão está com o papel do usuário
// (`comUsuario`), então `is_backend()` é falso e o INSERT era recusado. Pior:
// o PostgreSQL aborta a transação inteira quando um comando falha, então a
// tomada de posse voltava atrás junto — a equipe clicava e nada acontecia.
//
// Evidência de que não era um caso isolado: `audit_log` em produção tinha UM
// `assumida_por_humano`, de 13/08/2026, contra 714 mensagens de sistema
// gravadas por workers (que rodam como `backend` e por isso nunca esbarraram
// nisto).
//
// A elevação é a mesma que a auditoria já usava, e pelo mesmo motivo. O que
// estes testes seguram é o alcance dela: só para o que a aplicação escreve,
// nunca para o que a pessoa manda.

const CLAIMS_DE_SISTEMA = JSON.stringify({ app_role: 'backend' });

/**
 * Pool que anota cada comando e devolve uma linha plausível para o INSERT —
 * sem linha, `registrarMensagem` acha que foi reentrega e toma outro caminho.
 */
function poolEspiao() {
  const comandos = [];

  const client = {
    query(texto, valores) {
      const primeira = String(texto).trim().split('\n')[0].trim();
      comandos.push({ texto: primeira, valores, sql: String(texto) });
      if (String(texto).includes('INSERT INTO mensagens')) {
        return {
          rows: [{
            id: 1, conversa_id: 941, direcao: valores[1], tipo: valores[2],
            conteudo: valores[3], media_url: null, autor_tipo: valores[5],
            autor_nome: valores[6], privada: valores[7], criado_em: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  return {
    async connect() { return client; },
    query(texto, valores) {
      comandos.push({ texto: `[POOL] ${String(texto).trim().split('\n')[0].trim()}`, valores, sql: String(texto) });
      return { rows: [], rowCount: 0 };
    },
    comandos,
  };
}

/** Os `set_config` de claims, na ordem, com o valor declarado em cada um. */
function claimsDeclaradas(pool) {
  return pool.comandos
    .filter((c) => c.valores?.[0] === 'request.jwt.claims')
    .map((c) => c.valores[1]);
}

/** Posição do INSERT na sequência — para saber o que veio antes e depois dele. */
function posicaoDoInsert(pool) {
  return pool.comandos.findIndex((c) => c.sql.includes('INSERT INTO mensagens'));
}

const AVISO_DE_ASSUMIR = {
  direcao: 'saida',
  tipo: 'sistema',
  conteudo: 'Conversa assumida pela equipe. A resposta automática está pausada.',
  autor_tipo: 'sistema',
  privada: true,
};

test('o aviso de "assumida pela equipe" é gravado como sistema, não como o usuário', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'admin' }, () => (
    repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR)
  ));

  const insert = posicaoDoInsert(pool);
  assert.ok(insert > 0, 'o INSERT precisa ter acontecido');

  const antesDoInsert = pool.comandos
    .slice(0, insert)
    .filter((c) => c.valores?.[0] === 'request.jwt.claims');
  assert.equal(
    antesDoInsert.at(-1).valores[1], CLAIMS_DE_SISTEMA,
    'sem elevar, `is_backend()` é falso e a policy recusa a linha',
  );
});

test('o papel do usuário volta assim que o aviso é gravado', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'atendente' }, () => (
    repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR)
  ));

  // Uma transação que segue com privilégio de sistema depois da instrução que
  // precisava dele é pior que a falha original.
  const claims = claimsDeclaradas(pool);
  assert.equal(claims.at(-1), JSON.stringify({ usuario_id: '3', app_role: 'atendente' }));
  assert.equal(claims.at(-2), CLAIMS_DE_SISTEMA, 'elevou só em volta do INSERT');
});

test('a mensagem que a PESSOA escreve continua indo com o papel dela', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'atendente' }, () => (
    repositorio.registrarMensagem(941, {
      direcao: 'saida', tipo: 'texto', conteudo: 'Bom dia! Já te respondo.',
      autor_tipo: 'equipe', autor_nome: 'Lisley', privada: false,
    })
  ));

  // É o caso que a policy existe para julgar: `can_access_conversa` decide se
  // esta pessoa pode escrever nesta conversa. Elevar aqui apagaria a regra.
  assert.deepEqual(
    claimsDeclaradas(pool),
    [JSON.stringify({ usuario_id: '3', app_role: 'atendente' })],
    'nenhuma elevação para o que a pessoa digitou',
  );
});

test('a mensagem que CHEGA do paciente também não eleva', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'atendente' }, () => (
    repositorio.registrarMensagem(941, {
      direcao: 'entrada', tipo: 'texto', conteudo: 'oi', autor_tipo: 'contato',
    })
  ));

  assert.deepEqual(claimsDeclaradas(pool), [JSON.stringify({ usuario_id: '3', app_role: 'atendente' })]);
});

test('fora de requisição (worker) nada muda: a conexão já é backend', async () => {
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  // Sem `comUsuario` em volta não há papel de usuário para elevar — e não pode
  // haver `set_config` de claims solto numa conexão do pool, que seria herdado
  // pela próxima requisição.
  await repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR);

  assert.deepEqual(claimsDeclaradas(pool), []);
  // E a atomicidade do worker continua: INSERT e o toque em `conversas` na
  // mesma transação, como antes.
  assert.equal(pool.comandos[0].texto, 'BEGIN');
  assert.equal(pool.comandos.at(-1).texto, 'COMMIT');
});

test('a elevação não é alcançável pelo corpo da requisição', () => {
  // `autor_tipo` é o gatilho da elevação, então ele nunca pode vir de fora.
  // Quem o define é sempre o domínio (atendimento.js, crm-fluxo.js): as rotas
  // passam texto, anexo e usuário — nunca o tipo de autor.
  const fs = require('node:fs');
  const path = require('node:path');
  const pasta = path.join(__dirname, '..', 'src', 'servidor');
  for (const arquivo of fs.readdirSync(pasta).filter((n) => n.endsWith('.js'))) {
    const fonte = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
    assert.ok(
      !fonte.includes('autor_tipo'),
      `${arquivo} menciona autor_tipo: a camada HTTP não pode escolher o autor da mensagem`,
    );
  }
});
