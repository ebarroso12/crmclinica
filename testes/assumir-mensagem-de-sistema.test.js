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
    repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR, { comoSistema: true })
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
    repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR, { comoSistema: true })
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
  await repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR, { comoSistema: true });

  assert.deepEqual(claimsDeclaradas(pool), []);
  // E a atomicidade do worker continua: INSERT e o toque em `conversas` na
  // mesma transação, como antes.
  assert.equal(pool.comandos[0].texto, 'BEGIN');
  assert.equal(pool.comandos.at(-1).texto, 'COMMIT');
});

test('a elevação é OPT-IN: sem pedir, a mensagem vai com o papel da pessoa', async () => {
  // A primeira versão desta correção DEDUZIA a elevação de
  // `autor_tipo === 'sistema'`, e o teste que ficava aqui varria
  // `src/servidor/` atrás da string `autor_tipo` para "provar" que não era
  // alcançável de fora. A varredura passava e mesmo assim estava errada:
  // `privada` VEM do corpo da requisição e é ele que decide o `autor_tipo` em
  // `responderComoEquipe`. Achado em revisão independente, 13/09/2026.
  //
  // Agora quem eleva diz isso na chamada. Passar a mesma mensagem sem a opção
  // não eleva nada — é o que impede a dedução de voltar por acidente.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'atendente' }, () => (
    repositorio.registrarMensagem(941, AVISO_DE_ASSUMIR)
  ));

  assert.deepEqual(
    claimsDeclaradas(pool),
    [JSON.stringify({ usuario_id: '3', app_role: 'atendente' })],
    'o formato da mensagem não pode, sozinho, conceder privilégio de sistema',
  );
});

test('quem eleva a partir de ação da pessoa confere o acesso antes, na aplicação', () => {
  // Elevar tira `can_access_conversa` da jogada. Os dois caminhos que elevam a
  // partir de um clique — nota interna (`privada`) e resposta de orientação —
  // precisam aplicar a mesma regra na aplicação, senão um atendente passa a
  // escrever na conversa de um colega.
  const fs = require('node:fs');
  const path = require('node:path');
  const http = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');

  assert.match(http, /const elevaAoGravar = partes\[3\] === 'orientacao' \|\| \(partes\[3\] === 'mensagens' && Boolean\(corpo\?\.privada\)\)/);
  assert.match(http, /podeAcessarConversaAoVivo\(usuario\.papel, usuario\.id, alvo\.atribuido_a \?\? null\)/);
  // Mesma resposta de "não existe": confirmar a conversa já contaria algo sobre
  // o atendimento de outra pessoa.
  assert.match(http, /if \(elevaAoGravar[\s\S]{0,400}404/);
});

test('a resposta compilada de uma orientação também é gravada como sistema', async () => {
  // Bloqueador achado em revisão independente do PR #76: o primeiro commit
  // consertou o "assumir", mas `responderComoAssistente` grava
  // `autor_tipo: 'automacao'` — que a MESMA policy recusa, porque só aceita
  // `'equipe'` do papel do usuário. A rota roda dentro de `comIdentidade` com
  // papel admin/gestor/atendente, nunca `backend`.
  //
  // O efeito seria exatamente o de 13/08: 500, transação abortada, e o UPDATE
  // que marcou a orientação como respondida voltando atrás junto — a atendente
  // escreveria a orientação e ela continuaria pendente, para sempre.
  //
  // Nenhum teste com repositório em memória pega isto (não há RLS lá), e o de
  // `assumir` só exercita `autor_tipo: 'sistema'`. Por isso este, no espião.
  const pool = poolEspiao();
  const repositorio = criarRepositorio(pool);

  await repositorio.comUsuario({ id: 3, papel: 'admin' }, () => (
    repositorio.registrarMensagem(941, {
      direcao: 'saida',
      conteudo: 'A promoção do post está R$ 300. Quer que eu reserve?',
      autor_tipo: 'automacao',
      autor_nome: 'Serena',
      id_externo: 'orientacao-aviso-7',
    }, { comoSistema: true })
  ));

  const insert = posicaoDoInsert(pool);
  const antesDoInsert = pool.comandos
    .slice(0, insert)
    .filter((c) => c.valores?.[0] === 'request.jwt.claims');
  assert.equal(antesDoInsert.at(-1).valores[1], CLAIMS_DE_SISTEMA);
  assert.equal(claimsDeclaradas(pool).at(-1), JSON.stringify({ usuario_id: '3', app_role: 'admin' }));
});

test('o domínio pede a elevação nos caminhos que a policy recusaria', () => {
  // Cinta de segurança contra a regressão mais fácil de cometer aqui: escrever
  // um aviso novo de sistema e esquecer o `{ comoSistema: true }`. O sintoma
  // seria 500 em produção e nada nos testes em memória.
  const fs = require('node:fs');
  const path = require('node:path');
  const atendimento = fs.readFileSync(path.join(__dirname, '..', 'src', 'dominio', 'atendimento.js'), 'utf8');

  // `autor_tipo: 'sistema'` NUNCA passa pela policy com o papel do usuário —
  // nem como `equipe`, nem como não-privada. Toda escrita assim precisa da
  // opção, sem exceção.
  const chamadas = atendimento.split('registrarMensagem(').slice(1);
  for (const chamada of chamadas) {
    const corpo = chamada.slice(0, chamada.indexOf('});') + 3);
    if (!/autor_tipo: 'sistema'/.test(corpo)) continue;
    assert.match(
      chamada.slice(0, corpo.length + 40), /comoSistema: (true|privada)/,
      `escrita de sistema sem elevação: ${corpo.slice(0, 120)}`,
    );
  }

  // `autor_tipo: 'automacao'` é outro caso, e a diferença é ONDE roda. A
  // resposta normal da Serena nasce no webhook e na outbox, onde a conexão já é
  // `backend` — elevar ali não muda nada. Já `responderComoAssistente` é
  // chamada por uma rota, dentro da transação com o papel da pessoa: sem a
  // opção, é o bloqueador que a revisão achou.
  const compilada = atendimento.slice(atendimento.indexOf('async function responderComoAssistente'));
  assert.match(compilada.slice(0, 1600), /comoSistema: true/,
    'a resposta compilada roda sob o papel do usuário e a policy recusa `automacao`');
});
