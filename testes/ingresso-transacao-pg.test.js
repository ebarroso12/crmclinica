'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// P0 — o ingresso do WhatsApp inteiro tem que caber numa transação só.
//
// A porta HTTP (`src/servidor/http.js`, "Comando 3: na porta da ponte") roda
// `atendimento.receberMensagem` dentro de `repositorio.comUsuario(...)`: contato,
// conversa, mensagem, etiquetas e o trabalho da outbox precisam nascer juntos,
// porque o `202` só sai depois do COMMIT. Se qualquer um desses passos abrir
// conexão própria, ele não enxerga o que a transação externa ainda não
// commitou — e um contato NOVO bate na chave estrangeira.
//
// Em produção o sintoma foi centenas de HTTP 500 com
// `mensagens_conversa_id_fkey` na rota `/api/canais/whatsapp/eventos`, só para
// contato novo: conversa antiga já estava commitada havia muito tempo e por
// isso era visível de qualquer conexão.
//
// Este arquivo não tem contrapartida em `repositorio-memoria.js`, e não é
// esquecimento: memória não abre conexão, não tem transação e não tem MVCC.
// Um teste verde lá não provaria nada sobre este defeito. Precisa de PostgreSQL
// de verdade, com duas conexões disputando visibilidade — é por isso que ele só
// roda por `npm run test:pg`.
//
// Sem `CRMCLINICA_TEST_DATABASE_URL` os casos ficam SKIPPED, visíveis no
// contador de pulados. Nunca "passam vazios": teste que passa sem exercitar
// nada é pior que teste ausente, porque conta como cobertura.

const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';
const SEM_BANCO = URL_DE_TESTE
  ? false
  : 'exige PostgreSQL real — rode por `npm run test:pg` com CRMCLINICA_TEST_DATABASE_URL';

/** Sobe repositório e pool contra o banco de teste, com estado limpo. */
async function montar() {
  const { criarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool({ configurado: true, url: URL_DE_TESTE, poolMax: 6, tempoLimiteMs: 10000 });
  await pool.query(`
    TRUNCATE automacao_outbox, lembretes, agendamentos, disponibilidades, agenda_bloqueios,
             profissionais, conversa_etiquetas, mensagens, notas_internas, lead_eventos,
             leads, conversas, contatos, sessoes, audit_log, eventos_recebidos, usuarios
    RESTART IDENTITY CASCADE
  `);

  return { pool, repositorio: criarRepositorio(pool), encerrar: () => pool.end() };
}

test('[pg] ingresso de contato NOVO cabe inteiro numa transação só', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, encerrar } = await montar();
  t.after(() => encerrar());

  // Exatamente a sequência de `atendimento.receberMensagem` para um contato que
  // o CRM nunca viu, dentro da transação que a porta HTTP abre.
  const resultado = await repositorio.comUsuario(null, async () => {
    const contato = await repositorio.encontrarOuCriarContato({
      telefone: '5516999990001', nome: 'Paciente Novo', canal: 'whatsapp',
    });
    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

    // (1) A mensagem. Aqui batia `mensagens_conversa_id_fkey`: a conversa acima
    //     existe só nesta transação, ainda sem COMMIT.
    const { mensagem, duplicada } = await repositorio.registrarMensagem(conversa.id, {
      direcao: 'entrada', tipo: 'texto', conteudo: 'oi, queria marcar',
      autor_tipo: 'contato', autor_nome: contato.nome, id_externo: 'evt-p0-001',
    });

    // (2) As etiquetas. `atendimento.js:145` chama `sincronizarTemperatura`
    //     para toda conversa, e ela cai em `definirEtiquetasDaConversa`.
    //     Mesmo defeito, alguns passos adiante — e é por isso que corrigir só
    //     a mensagem não fazia o webhook voltar a funcionar.
    await repositorio.definirEtiquetasDaConversa(conversa.id, ['lead_quente']);

    // (3) O trabalho da automação, que precisa nascer junto com a mensagem.
    const { trabalho } = await repositorio.enfileirarTrabalhoDeOutbox({
      conversaId: conversa.id,
      mensagemEntradaId: mensagem.id,
      chaveIdempotencia: 'evt-p0-001',
    });

    return { contatoId: contato.id, conversaId: conversa.id, mensagemId: mensagem.id, trabalhoId: trabalho.id, duplicada };
  });

  assert.equal(resultado.duplicada, false);

  // Depois do COMMIT, as quatro escritas existem de verdade no banco — não é o
  // retorno da função que está sendo conferido, é o estado persistido.
  const conferir = async (sql, valores) => Number((await pool.query(sql, valores)).rows[0].total);

  assert.equal(await conferir('SELECT count(*)::int AS total FROM contatos WHERE id = $1', [resultado.contatoId]), 1, 'contato');
  assert.equal(await conferir('SELECT count(*)::int AS total FROM conversas WHERE id = $1', [resultado.conversaId]), 1, 'conversa');
  assert.equal(await conferir('SELECT count(*)::int AS total FROM mensagens WHERE id = $1', [resultado.mensagemId]), 1, 'mensagem');
  assert.equal(await conferir('SELECT count(*)::int AS total FROM conversa_etiquetas WHERE conversa_id = $1', [resultado.conversaId]), 1, 'etiqueta');
  assert.equal(await conferir('SELECT count(*)::int AS total FROM automacao_outbox WHERE id = $1', [resultado.trabalhoId]), 1, 'trabalho da outbox');

  // E o relógio da conversa andou junto — sem isso a conversa some do topo da
  // lista e a equipe não vê o paciente que acabou de escrever.
  const { rows } = await pool.query('SELECT ultima_msg_em, aguardando_resposta_desde FROM conversas WHERE id = $1', [resultado.conversaId]);
  assert.ok(rows[0].ultima_msg_em, 'ultima_msg_em precisa ter sido atualizado na mesma transação');
  assert.ok(rows[0].aguardando_resposta_desde, 'a espera do paciente precisa ter começado');
});

test('[pg] falha no meio do ingresso desfaz TUDO, sem deixar metade gravada', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, encerrar } = await montar();
  t.after(() => encerrar());

  const erroCombinado = new Error('falha simulada depois de gravar a mensagem');

  await assert.rejects(
    repositorio.comUsuario(null, async () => {
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516999990002', nome: 'Paciente Que Nao Vinga', canal: 'whatsapp',
      });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      await repositorio.registrarMensagem(conversa.id, {
        direcao: 'entrada', tipo: 'texto', conteudo: 'mensagem que não deve sobreviver',
        autor_tipo: 'contato', id_externo: 'evt-p0-002',
      });
      await repositorio.definirEtiquetasDaConversa(conversa.id, ['lead_morno']);
      throw erroCombinado;
    }),
    (erro) => erro === erroCombinado,
  );

  // Nada pode ter sobrado. Uma mensagem gravada sem a conversa correspondente,
  // ou um contato órfão, é pior que a falha: vira dado sujo que ninguém procura.
  const sobrou = async (sql, valores) => Number((await pool.query(sql, valores)).rows[0].total);

  assert.equal(await sobrou('SELECT count(*)::int AS total FROM contatos WHERE telefone = $1', ['5516999990002']), 0, 'contato não pode sobreviver');
  assert.equal(await sobrou('SELECT count(*)::int AS total FROM mensagens WHERE id_externo = $1', ['evt-p0-002']), 0, 'mensagem não pode sobreviver');
  assert.equal(await sobrou('SELECT count(*)::int AS total FROM conversa_etiquetas', []), 0, 'etiqueta não pode sobreviver');
  assert.equal(await sobrou('SELECT count(*)::int AS total FROM conversas', []), 0, 'conversa não pode sobreviver');
});

test('[pg] reentrega do mesmo id_externo não duplica nem derruba a transação', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, encerrar } = await montar();
  t.after(() => encerrar());

  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516999990003', nome: 'Paciente Repetido' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', tipo: 'texto', conteudo: 'oi', autor_tipo: 'contato', id_externo: 'evt-p0-003',
  });

  // O canal reentrega o mesmo evento — acontece o tempo todo. Dentro de uma
  // transação ambiente, "já existe" não pode virar ROLLBACK: abortaria escritas
  // legítimas vizinhas que nada têm a ver com a duplicata.
  const resultado = await repositorio.comUsuario(null, async () => {
    const repetida = await repositorio.registrarMensagem(conversa.id, {
      direcao: 'entrada', tipo: 'texto', conteudo: 'oi', autor_tipo: 'contato', id_externo: 'evt-p0-003',
    });
    // Uma escrita legítima depois da duplicata: se a transação tivesse sido
    // abortada, esta linha não existiria no fim.
    await repositorio.definirEtiquetasDaConversa(conversa.id, ['lead_frio']);
    return repetida;
  });

  assert.equal(resultado.duplicada, true);

  const contar = async (sql, valores) => Number((await pool.query(sql, valores)).rows[0].total);
  assert.equal(await contar('SELECT count(*)::int AS total FROM mensagens WHERE id_externo = $1', ['evt-p0-003']), 1, 'não pode duplicar');
  assert.equal(await contar('SELECT count(*)::int AS total FROM conversa_etiquetas WHERE conversa_id = $1', [conversa.id]), 1, 'a escrita seguinte precisa ter sobrevivido');
});

test('[pg] definirDisponibilidades participa da transação ambiente', { skip: SEM_BANCO }, async (t) => {
  const { pool, repositorio, encerrar } = await montar();
  t.after(() => encerrar());

  // Mesma classe de defeito da agenda: profissional novo criado na transação,
  // disponibilidades gravadas em seguida. Se `definirDisponibilidades` abrir
  // conexão própria, o profissional ainda não está commitado e a FK recusa.
  const profissionalId = await repositorio.comUsuario(null, async () => {
    const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena' });
    await repositorio.definirDisponibilidades(profissional.id, [
      { dia_semana: 1, hora_inicio: '09:00', hora_fim: '12:00' },
      { dia_semana: 3, hora_inicio: '14:00', hora_fim: '18:00' },
    ]);
    return profissional.id;
  });

  const { rows } = await pool.query(
    'SELECT count(*)::int AS total FROM disponibilidades WHERE profissional_id = $1', [profissionalId],
  );
  assert.equal(rows[0].total, 2, 'as duas janelas precisam existir depois do COMMIT');
});
