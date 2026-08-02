'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// Suíte de contrato do repositório.
//
// As mesmas asserções rodam contra as duas implementações. É isto que impede a
// divergência entre memória e PostgreSQL: um comportamento que só existe numa
// delas quebra aqui em vez de aparecer em produção.
//
// Sem `CRMCLINICA_TEST_DATABASE_URL`, só a implementação em memória roda — o CI
// não depende de banco. Com a variável, o PostgreSQL entra na mesma bateria:
//
//   CRMCLINICA_TEST_DATABASE_URL="postgres://..." npm test
//
// O banco apontado é limpo a cada execução: use um de teste, nunca o de produção.

const URL_DE_TESTE = process.env.CRMCLINICA_TEST_DATABASE_URL || '';

const implementacoes = [
  { nome: 'memória', montar: async () => ({ repositorio: criarRepositorioEmMemoria(), encerrar: async () => {} }) },
];

if (URL_DE_TESTE) {
  implementacoes.push({
    nome: 'postgres',
    montar: async () => {
      const { criarPool } = require('../src/dados/pool');
      const { criarRepositorio } = require('../src/dados/repositorio');

      const pool = criarPool({
        configurado: true,
        url: URL_DE_TESTE,
        poolMax: 4,
        tempoLimiteMs: 10000,
      });

      // Estado limpo por execução. TRUNCATE em cascata devolve as sequências ao
      // início, o que mantém os identificadores previsíveis entre as duas suítes.
      await pool.query(`
        TRUNCATE conversa_etiquetas, mensagens, notas_internas, leads, conversas,
                 contatos, sessoes, audit_log, eventos_recebidos, usuarios
        RESTART IDENTITY CASCADE
      `);

      return { repositorio: criarRepositorio(pool), encerrar: () => pool.end() };
    },
  });
}

for (const { nome, montar } of implementacoes) {
  test(`[${nome}] contrato do repositório`, async (t) => {
    const { repositorio, encerrar } = await montar();
    t.after(() => encerrar());

    await t.test('saúde responde operacional', async () => {
      assert.equal((await repositorio.verificarSaude()).estado, 'operacional');
    });

    await t.test('contato não duplica pelo telefone', async () => {
      const primeiro = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
      const segundo = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina Souza' });

      assert.equal(primeiro.id, segundo.id);
      assert.equal(segundo.nome, 'Marina', 'nome já registrado não é sobrescrito');
    });

    await t.test('conversa aberta é reaproveitada; resolvida abre outra', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000001', nome: 'Teste A' });

      const primeira = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      const mesma = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      assert.equal(mesma.id, primeira.id);

      await repositorio.atualizarConversa(primeira.id, { status: 'resolvida' });
      const nova = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      assert.notEqual(nova.id, primeira.id);
    });

    await t.test('a conversa devolve a forma esperada', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000002', nome: 'Teste B' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      // Tipos e nomes precisam bater entre as implementações, não só os valores.
      assert.equal(typeof conversa.id, 'number');
      assert.equal(typeof conversa.contato_id, 'number');
      assert.equal(conversa.status, 'aberta');
      assert.equal(conversa.assumida_por_humano, false);
      assert.equal(conversa.prioridade, null);
      assert.equal(conversa.atribuido_a, null);
      assert.ok(Array.isArray(conversa.etiquetas));
      assert.equal(typeof conversa.contato.telefone, 'string');
    });

    await t.test('obter e listar devolvem a mesma forma de conversa', async () => {
      // Regressão: `obterConversa` no PostgreSQL não trazia `previa`, que o de
      // memória sempre traz. A interface lê os dois lugares e mostraria vazio.
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000012', nome: 'Teste L' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'mensagem de forma' });
      await repositorio.definirEtiquetasDaConversa(conversa.id, ['pagou_sinal']);

      const obtida = await repositorio.obterConversa(conversa.id);
      const listada = (await repositorio.listarConversas({})).find((item) => item.id === conversa.id);

      for (const campo of ['previa', 'etiquetas', 'status', 'assumida_por_humano', 'temperatura', 'estagio']) {
        assert.deepEqual(obtida[campo], listada[campo], `campo "${campo}" difere entre obter e listar`);
      }
      assert.equal(obtida.previa, 'mensagem de forma');
      assert.deepEqual(obtida.etiquetas, ['pagou_sinal']);
    });

    await t.test('mensagem move o relógio; nota interna não', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000003', nome: 'Teste C' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'Olá' });
      const depoisDaMensagem = await repositorio.obterConversa(conversa.id);
      assert.ok(depoisDaMensagem.ultima_msg_em);
      assert.equal(depoisDaMensagem.previa, 'Olá');

      await repositorio.registrarMensagem(conversa.id, {
        direcao: 'saida', conteudo: 'nota', privada: true,
      });
      const depoisDaNota = await repositorio.obterConversa(conversa.id);

      assert.equal(
        new Date(depoisDaNota.ultima_msg_em).getTime(),
        new Date(depoisDaMensagem.ultima_msg_em).getTime(),
      );
      assert.equal(depoisDaNota.previa, 'Olá');
    });

    await t.test('id externo repetido não vira segunda mensagem', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000004', nome: 'Teste D' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      const primeira = await repositorio.registrarMensagem(conversa.id, {
        direcao: 'entrada', conteudo: 'Olá', id_externo: 'wa:contrato-1',
      });
      const reentrega = await repositorio.registrarMensagem(conversa.id, {
        direcao: 'entrada', conteudo: 'Olá de novo', id_externo: 'wa:contrato-1',
      });

      assert.equal(primeira.duplicada, false);
      assert.equal(reentrega.duplicada, true);
      assert.equal(reentrega.mensagem.id, primeira.mensagem.id);
      assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1);
    });

    await t.test('a thread sai em ordem e sabe omitir notas', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000005', nome: 'Teste E' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'primeira' });
      await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'nota', privada: true });
      await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'segunda' });

      const todas = await repositorio.listarMensagens(conversa.id);
      assert.deepEqual(todas.map((m) => m.conteudo), ['primeira', 'nota', 'segunda']);

      const publicas = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: false });
      assert.deepEqual(publicas.map((m) => m.conteudo), ['primeira', 'segunda']);
      assert.equal(typeof todas[0].id, 'number');
    });

    await t.test('etiqueta desconhecida é ignorada, não criada', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000006', nome: 'Teste F' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      const aplicadas = await repositorio.definirEtiquetasDaConversa(conversa.id, [
        'pagou_sinal', 'etiqueta_que_nao_existe', 'lead_quente',
      ]);
      assert.deepEqual(aplicadas, ['lead_quente', 'pagou_sinal']);

      // Substituição, não acréscimo.
      await repositorio.definirEtiquetasDaConversa(conversa.id, ['em_protocolo']);
      assert.deepEqual(await repositorio.listarEtiquetasDaConversa(conversa.id), ['em_protocolo']);
    });

    await t.test('as etiquetas iniciais estão cadastradas', async () => {
      const nomes = (await repositorio.listarEtiquetas()).map((etiqueta) => etiqueta.nome);
      for (const esperada of ['lead_quente', 'lead_morno', 'lead_frio', 'pagou_sinal', 'avaliacao']) {
        assert.ok(nomes.includes(esperada), `falta a etiqueta "${esperada}"`);
      }
    });

    await t.test('a ficha guarda atributos livres e ignora campo fora da lista', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000007', nome: 'Teste G' });

      await repositorio.atualizarContato(contato.id, {
        email: 'teste@exemplo.com',
        atributos: { convenio: 'particular', indicado_por: 'Instagram' },
      });
      await repositorio.atualizarContato(contato.id, { id: 999999 });

      const atualizado = await repositorio.obterContato(contato.id);
      assert.equal(atualizado.email, 'teste@exemplo.com');
      assert.equal(atualizado.atributos.convenio, 'particular');
      assert.equal(atualizado.id, contato.id, 'o identificador não pode ser reescrito');
    });

    await t.test('o lead guarda o vínculo com a conversa e atualiza sem duplicar', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000008', nome: 'Teste H' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      await repositorio.salvarLead(contato.id, { conversaId: conversa.id, temperatura: 'frio' });
      const atualizado = await repositorio.salvarLead(contato.id, { temperatura: 'quente', estagio: 'agendado' });

      assert.equal(atualizado.temperatura, 'quente');
      assert.equal(atualizado.estagio, 'agendado');
      assert.equal(atualizado.conversa_id, conversa.id, 'o vínculo não se perde na atualização');

      const doContato = (await repositorio.listarLeads()).filter((lead) => lead.contato_id === contato.id);
      assert.equal(doContato.length, 1);
    });

    await t.test('a busca encontra por nome e por telefone', async () => {
      await repositorio.encontrarOuCriarContato({ telefone: '5516900000009', nome: 'Zoraide Especial' });
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000009' });
      await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      assert.equal((await repositorio.listarConversas({ busca: 'zoraide' })).length, 1, 'busca sem diferenciar caixa');
      assert.equal((await repositorio.listarConversas({ busca: '00000009' })).length, 1);
      assert.equal((await repositorio.listarConversas({ busca: 'inexistente-xyz' })).length, 0);
    });

    await t.test('o filtro por status funciona', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000010', nome: 'Teste J' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      await repositorio.atualizarConversa(conversa.id, { status: 'pendente' });

      const pendentes = await repositorio.listarConversas({ status: 'pendente' });
      assert.ok(pendentes.some((item) => item.id === conversa.id));
      assert.ok(!(await repositorio.listarConversas({ status: 'aberta' })).some((item) => item.id === conversa.id));
    });

    await t.test('o registro de evento é idempotente', async () => {
      assert.equal(await repositorio.consultarEvento('contrato-chave-a'), null);

      await repositorio.registrarEvento('contrato-chave-a', { ordem: 'primeiro' });
      const segundo = await repositorio.registrarEvento('contrato-chave-a', { ordem: 'segundo' });

      assert.deepEqual(segundo, { ordem: 'primeiro' }, 'o primeiro recibo é o que vale');
      assert.deepEqual(await repositorio.consultarEvento('contrato-chave-a'), { ordem: 'primeiro' });
    });

    await t.test('notas saem da mais recente para a mais antiga', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000011', nome: 'Teste K' });

      await repositorio.criarNota(contato.id, 'primeira nota');
      await new Promise((resolver) => setTimeout(resolver, 10));
      await repositorio.criarNota(contato.id, 'segunda nota');

      const notas = await repositorio.listarNotas(contato.id);
      assert.equal(notas.length, 2);
      assert.equal(notas[0].texto, 'segunda nota');
      assert.equal(typeof notas[0].id, 'number');
    });

    await t.test('criar nota devolve o vínculo com o contato', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900000013', nome: 'Teste M' });
      const nota = await repositorio.criarNota(contato.id, 'nota de contrato');

      assert.equal(typeof nota.id, 'number');
      assert.equal(nota.contato_id, contato.id);
      assert.equal(nota.texto, 'nota de contrato');
    });

    await t.test('usuário é encontrado por e-mail sem diferenciar caixa', async () => {
      const criado = await repositorio.criarUsuario({
        nome: 'Recepção',
        email: 'Recepcao.Contrato@teste.local',
        senhaHash: 'scrypt$16384$8$1$aa$bb',
        papel: 'atendente',
      });

      const porEmail = await repositorio.obterUsuarioPorEmail('recepcao.contrato@teste.local');
      assert.ok(porEmail, 'a busca precisa ignorar a caixa do e-mail');
      assert.equal(porEmail.id, criado.id);
      assert.equal(porEmail.senha_hash, 'scrypt$16384$8$1$aa$bb', 'o login precisa do hash');

      const porId = await repositorio.obterUsuarioPorId(criado.id);
      assert.equal(porId.papel, 'atendente');
      assert.equal(porId.senha_hash, undefined, 'quem busca por id não precisa do hash');
    });

    await t.test('a sessão é encontrada pelo hash e revogada uma vez só', async () => {
      const usuario = await repositorio.criarUsuario({
        nome: 'Sessão',
        email: 'sessao.contrato@teste.local',
        senhaHash: 'scrypt$16384$8$1$aa$bb',
      });

      const expiraEm = new Date(Date.now() + 3_600_000).toISOString();
      const { id } = await repositorio.criarSessao({
        usuarioId: usuario.id,
        hashRefresh: 'hash-de-contrato-1',
        expiraEm,
      });

      const encontrada = await repositorio.obterSessaoPorHash('hash-de-contrato-1');
      assert.equal(encontrada.id, id);
      assert.equal(encontrada.usuario_id, usuario.id);
      assert.equal(encontrada.revogada_em, null);
      // O hash precisa voltar: é como se verifica que o token não foi guardado em claro.
      assert.equal(encontrada.hash_refresh, 'hash-de-contrato-1');

      await repositorio.revogarSessao(id);
      assert.ok((await repositorio.obterSessaoPorHash('hash-de-contrato-1')).revogada_em);

      assert.equal(await repositorio.obterSessaoPorHash('hash-que-nao-existe'), null);
    });

    await t.test('revogar todas as sessões do usuário atinge só as vivas', async () => {
      const usuario = await repositorio.criarUsuario({
        nome: 'Multi',
        email: 'multi.contrato@teste.local',
        senhaHash: 'scrypt$16384$8$1$aa$bb',
      });
      const expiraEm = new Date(Date.now() + 3_600_000).toISOString();

      await repositorio.criarSessao({ usuarioId: usuario.id, hashRefresh: 'contrato-h1', expiraEm });
      const segunda = await repositorio.criarSessao({ usuarioId: usuario.id, hashRefresh: 'contrato-h2', expiraEm });
      await repositorio.revogarSessao(segunda.id);

      assert.equal(await repositorio.revogarSessoesDoUsuario(usuario.id), 1);
      assert.equal(await repositorio.revogarSessoesDoUsuario(usuario.id), 0);
    });

    await t.test('a auditoria aceita registro com e sem detalhe', async () => {
      await repositorio.registrarAuditoria({ entidade: 'conversa', entidadeId: 1, acao: 'teste_contrato' });
      await repositorio.registrarAuditoria({
        entidade: 'conversa', entidadeId: 1, acao: 'teste_contrato', detalhe: { motivo: 'x' },
      });
      // Sem asserção de leitura: a auditoria é append-only e não tem rota de consulta ainda.
    });
  });
}
