'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Posse verificável dos trabalhos da outbox — contra PostgreSQL real.
//
// O defeito que estes testes existem para impedir: `concluirTrabalhoDeOutbox`
// fechava o trabalho com `UPDATE ... WHERE id = $1` — só pelo id. Não conferia
// status, não conferia dono, não usava RETURNING. Um worker cujo lease havia
// vencido, e cujo trabalho já fora retomado por outro, conseguia marcar
// `concluido` por cima do dono atual — e ainda recebia de volta a linha lida
// depois, o que fazia o chamador acreditar que deu certo.
//
// Com paciente do outro lado, o desfecho é resposta duplicada ou resposta que
// nunca sai. `reivindicado_por` sozinho não resolve: o MESMO worker pode ter
// perdido e retomado o trabalho no intervalo, e aí o nome bate. É por isso que
// existe `posse_token` (migration 033), monotônico por linha.
//
// Só roda por `npm run test:pg`. Sem CRMCLINICA_TEST_DATABASE_URL os casos
// ficam SKIPPED, visíveis no contador — nunca "passam vazios".

const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';
const SEM_BANCO = URL_DE_TESTE
  ? false
  : 'exige PostgreSQL real — rode por `npm run test:pg` com CRMCLINICA_TEST_DATABASE_URL';

/**
 * Monta o repositório e devolve a hora do PRÓPRIO BANCO — nunca uma string
 * fixa. `enfileirarTrabalhoDeOutbox` grava `disponivel_em` com o `now()` do
 * Postgres; se o teste comparasse contra um instante hardcoded, bastaria a
 * suíte rodar num dia diferente do escrito no arquivo para
 * `disponivel_em <= agora` falhar sempre e a reivindicação nunca achar nada
 * — não é o defeito que o teste existe para provar, é o teste mentindo sobre
 * si mesmo. Pior ainda com o host de teste (WSL) e o host do runner podendo
 * divergir por minutos.
 *
 * `instante` carrega uma folga de alguns segundos à frente do `now()` lido
 * aqui. Sem ela, existe uma corrida real: este `SELECT now()` roda ANTES de
 * `enfileirarTrabalhoDeOutbox`, e o INSERT que grava `disponivel_em` chama o
 * PRÓPRIO `now()` do Postgres de novo, um pouco DEPOIS — a diferença é da
 * ordem de milissegundos, mas basta para `disponivel_em <= agora` falhar na
 * hora de reivindicar o trabalho recém-criado. `passado` e `limiar` ficam de
 * fora da folga: continuam relativos ao `now()` real, porque simulam um lease
 * vencido minutos atrás — a folga de segundos não interfere nessa comparação.
 */
async function montar() {
  const { criarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool({ configurado: true, url: URL_DE_TESTE, poolMax: 6, tempoLimiteMs: 10000 });
  await pool.query(`
    TRUNCATE automacao_outbox, mensagens, conversa_etiquetas, leads, conversas, contatos
    RESTART IDENTITY CASCADE
  `);

  const repositorio = criarRepositorio(pool);
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990100', nome: 'Paciente Fencing' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

  const { rows } = await pool.query('SELECT now()::timestamptz AS agora');
  const agoraMs = rows[0].agora.getTime();
  const instante = new Date(agoraMs + 5000).toISOString(); // +5s de folga contra a corrida do INSERT
  const passado = new Date(agoraMs - 60 * 60 * 1000).toISOString(); // 1h atrás, na hora do banco
  // Limiar de "preso": entre `passado` (onde o lease vencido foi carimbado) e
  // `instante` (agora). É o que `liberarTrabalhosDeOutboxPresos` usa como corte.
  const limiar = new Date(agoraMs - 5 * 60 * 1000).toISOString();

  return { pool, repositorio, conversa, instante, passado, limiar, encerrar: () => pool.end() };
}

test('[pg] worker que perdeu a posse NÃO consegue concluir; só o dono atual conclui', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, conversa, instante, passado, limiar, encerrar } = await montar();
  t.after(() => encerrar());

  await repositorio.enfileirarTrabalhoDeOutbox({
    conversaId: conversa.id, chaveIdempotencia: 'fencing:1',
  });

  // 1. Worker A reivindica e leva o token da SUA posse.
  const [paraA] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: instante, limite: 10, worker: 'worker-A',
  });
  assert.ok(paraA, 'A precisa ter reivindicado');
  const tokenDeA = Number(paraA.posse_token);
  assert.equal(tokenDeA, 1, 'primeira reivindicação leva a posse ao token 1');

  // 2. O lease de A vence. Simulado empurrando `reivindicado_em` para trás —
  //    é o que o relógio faria enquanto A espera a IA responder.
  await pool.query(
    "UPDATE automacao_outbox SET reivindicado_em = $1::timestamptz WHERE id = $2",
    [passado, paraA.id],
  );

  // 3. Worker B recupera o trabalho preso.
  const liberados = await repositorio.liberarTrabalhosDeOutboxPresos({
    antesDe: limiar, agora: instante,
  });
  assert.ok(liberados.length >= 1, 'o trabalho preso precisa ter voltado à fila');

  const [paraB] = await repositorio.reivindicarTrabalhosDeOutbox({
    agora: instante, limite: 10, worker: 'worker-B',
  });
  assert.ok(paraB, 'B precisa ter reivindicado');
  const tokenDeB = Number(paraB.posse_token);

  // 4. O token de B é NOVO e maior. É o que torna "posse antiga" detectável,
  //    em vez de apenas "diferente".
  assert.ok(tokenDeB > tokenDeA, `a nova posse precisa ter token maior (A=${tokenDeA}, B=${tokenDeB})`);

  // 5. A volta da chamada de IA, alheio a tudo, e tenta concluir com o token
  //    velho. Antes da correção, isto marcava `concluido` por cima de B.
  const tentativaDeA = await repositorio.concluirTrabalhoDeOutbox(paraA.id, {
    status: 'concluido', worker: 'worker-A', posseToken: tokenDeA,
  });
  assert.equal(tentativaDeA, null, 'A perdeu a posse: a conclusão precisa ser RECUSADA');

  // 6. E o registro não pode ter mudado: continua com B, ainda processando.
  const { rows: depoisDeA } = await pool.query(
    'SELECT status, reivindicado_por, posse_token FROM automacao_outbox WHERE id = $1', [paraA.id],
  );
  assert.equal(depoisDeA[0].status, 'processando', 'a tentativa de A não pode ter mudado o status');
  assert.equal(depoisDeA[0].reivindicado_por, 'worker-B', 'o dono continua sendo B');
  assert.equal(Number(depoisDeA[0].posse_token), tokenDeB, 'o token da posse continua o de B');

  // 7. B conclui com o token dele. Este é o único que pode.
  const tentativaDeB = await repositorio.concluirTrabalhoDeOutbox(paraB.id, {
    status: 'concluido', worker: 'worker-B', posseToken: tokenDeB,
  });
  assert.ok(tentativaDeB, 'B é o dono atual: a conclusão precisa ser ACEITA');
  assert.equal(tentativaDeB.status, 'concluido');
});

test('[pg] worker que perdeu a posse também não consegue REAGENDAR nem matar o trabalho', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, conversa, instante, passado, limiar, encerrar } = await montar();
  t.after(() => encerrar());

  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: conversa.id, chaveIdempotencia: 'fencing:2' });

  const [paraA] = await repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 10, worker: 'worker-A' });
  const tokenDeA = Number(paraA.posse_token);

  await pool.query(
    "UPDATE automacao_outbox SET reivindicado_em = $1::timestamptz WHERE id = $2",
    [passado, paraA.id],
  );
  await repositorio.liberarTrabalhosDeOutboxPresos({ antesDe: limiar, agora: instante });
  const [paraB] = await repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 10, worker: 'worker-B' });

  // Reagendar é o caso mais perigoso: sem a guarda, o worker velho devolveria
  // à fila um trabalho que o dono atual está prestes a concluir — e a fila
  // entregaria a MESMA resposta ao paciente de novo.
  const reagendou = await repositorio.concluirTrabalhoDeOutbox(paraA.id, {
    status: 'pendente', tentativas: 1, disponivelEm: instante, worker: 'worker-A', posseToken: tokenDeA,
  });
  assert.equal(reagendou, null, 'A não pode reagendar um trabalho que não é mais dele');

  const matou = await repositorio.concluirTrabalhoDeOutbox(paraA.id, {
    status: 'morto', worker: 'worker-A', posseToken: tokenDeA,
  });
  assert.equal(matou, null, 'A não pode matar um trabalho que não é mais dele');

  const { rows } = await pool.query('SELECT status, reivindicado_por FROM automacao_outbox WHERE id = $1', [paraA.id]);
  assert.equal(rows[0].status, 'processando', 'nenhuma das tentativas pode ter mudado o estado');
  assert.equal(rows[0].reivindicado_por, 'worker-B');

  assert.ok(paraB, 'B segue como dono');
});

test('[pg] a renovação do lease também exige a posse corrente', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, conversa, instante, passado, limiar, encerrar } = await montar();
  t.after(() => encerrar());

  await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: conversa.id, chaveIdempotencia: 'fencing:3' });

  const [paraA] = await repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 10, worker: 'worker-A' });
  const tokenDeA = Number(paraA.posse_token);

  await pool.query(
    "UPDATE automacao_outbox SET reivindicado_em = $1::timestamptz WHERE id = $2",
    [passado, paraA.id],
  );
  await repositorio.liberarTrabalhosDeOutboxPresos({ antesDe: limiar, agora: instante });
  await repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 10, worker: 'worker-B' });

  // A tenta renovar com o token velho: é assim que ele DESCOBRE, no meio de uma
  // operação longa, que já não é mais o dono — e para antes de enviar.
  const renovou = await repositorio.renovarReivindicacaoDeOutbox(paraA.id, {
    worker: 'worker-A', agora: instante, posseToken: tokenDeA,
  });
  assert.equal(renovou, null, 'renovar com token de posse antiga precisa ser recusado');
});

test('[pg] cada trabalho é reivindicado por exatamente um worker, e o token sobe a cada posse', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, conversa, instante, passado, limiar, encerrar } = await montar();
  t.after(() => encerrar());

  for (let indice = 0; indice < 6; indice += 1) {
    await repositorio.enfileirarTrabalhoDeOutbox({ conversaId: conversa.id, chaveIdempotencia: `fencing:lote:${indice}` });
  }

  // Dois workers disputando o mesmo lote, como dois processos fariam.
  const [deA, deB] = await Promise.all([
    repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 6, worker: 'worker-A' }),
    repositorio.reivindicarTrabalhosDeOutbox({ agora: instante, limite: 6, worker: 'worker-B' }),
  ]);

  const idsA = deA.map((t2) => Number(t2.id));
  const idsB = deB.map((t2) => Number(t2.id));
  const repetidos = idsA.filter((id) => idsB.includes(id));

  assert.deepEqual(repetidos, [], 'nenhum trabalho pode ser reivindicado pelos dois');
  assert.equal(idsA.length + idsB.length, 6, 'os seis trabalhos precisam ter sido distribuídos');

  const { rows } = await pool.query('SELECT posse_token FROM automacao_outbox ORDER BY id');
  for (const linha of rows) {
    assert.equal(Number(linha.posse_token), 1, 'primeira posse de cada trabalho leva o token a 1');
  }
});
