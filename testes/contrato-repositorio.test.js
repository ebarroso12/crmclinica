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
        TRUNCATE serena_prompts, serena_regras, lembretes, agendamentos, disponibilidades, agenda_bloqueios, profissionais,
                 conversa_etiquetas, mensagens, notas_internas, leads, conversas,
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

    await t.test('busca de contato acha por nome e por telefone digitado', async () => {
      await repositorio.encontrarOuCriarContato({ telefone: '5516988887777', nome: 'Joana Ribeiro' });
      await repositorio.encontrarOuCriarContato({ telefone: '5511955554444', nome: 'Carlos Menezes' });

      const porNome = await repositorio.buscarContatos({ termo: 'joana' });
      assert.equal(porNome.length, 1);
      assert.equal(porNome[0].nome, 'Joana Ribeiro');
      assert.equal(typeof porNome[0].id, 'number');

      // Quem atende digita o telefone como está na tela do paciente. A busca
      // precisa achar o mesmo contato com ou sem máscara.
      const comMascara = await repositorio.buscarContatos({ termo: '(16) 98888' });
      assert.equal(comMascara.length, 1, 'pontuação no telefone não pode atrapalhar');
      assert.equal(comMascara[0].telefone, '5516988887777');

      const semTermo = await repositorio.buscarContatos({ termo: '  ' });
      assert.deepEqual(semTermo, [], 'busca vazia não despeja a base inteira');

      // Um ou dois dígitos casariam com quase todo mundo: melhor não achar nada
      // do que devolver a agenda de contatos inteira para "1".
      const curtaDemais = await repositorio.buscarContatos({ termo: '55' });
      assert.deepEqual(curtaDemais, []);
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

    await t.test('a ordenação por data e o filtro de intervalo funcionam', async () => {
      const contatoAntigo = await repositorio.encontrarOuCriarContato({ telefone: '5516900000014', nome: 'Teste N' });
      const conversaAntiga = await repositorio.encontrarOuCriarConversaAberta(contatoAntigo.id, 'whatsapp');
      await repositorio.registrarMensagem(conversaAntiga.id, { direcao: 'entrada', conteudo: 'oi', autor_tipo: 'contato' });

      // `ultima_msg_em` nasce de `now()` no Postgres — não há como carimbar uma
      // data passada direto. O intervalo real entre as duas gravações é o que
      // a ordenação e o filtro por data têm para diferenciar.
      await new Promise((resolver) => setTimeout(resolver, 20));

      const contatoRecente = await repositorio.encontrarOuCriarContato({ telefone: '5516900000015', nome: 'Teste O' });
      const conversaRecente = await repositorio.encontrarOuCriarConversaAberta(contatoRecente.id, 'whatsapp');
      await repositorio.registrarMensagem(conversaRecente.id, { direcao: 'entrada', conteudo: 'oi', autor_tipo: 'contato' });

      const decrescente = await repositorio.listarConversas({ ordenacao: 'desc', limite: 200 });
      const posicao = (lista, id) => lista.findIndex((item) => item.id === id);
      assert.ok(
        posicao(decrescente, conversaRecente.id) < posicao(decrescente, conversaAntiga.id),
        'decrescente: a conversa mais recente vem primeiro',
      );

      const crescente = await repositorio.listarConversas({ ordenacao: 'asc', limite: 200 });
      assert.ok(
        posicao(crescente, conversaAntiga.id) < posicao(crescente, conversaRecente.id),
        'crescente: a conversa mais antiga vem primeiro',
      );

      const umaHoraAtras = new Date(Date.now() - 3_600_000).toISOString();
      const umaHoraNoFuturo = new Date(Date.now() + 3_600_000).toISOString();

      const dentroDoIntervalo = await repositorio.listarConversas({
        dataInicio: umaHoraAtras, dataFim: umaHoraNoFuturo, limite: 200,
      });
      assert.ok(
        dentroDoIntervalo.some((item) => item.id === conversaRecente.id),
        'um intervalo largo o bastante inclui a conversa de agora',
      );

      const inicioNoFuturo = await repositorio.listarConversas({ dataInicio: umaHoraNoFuturo, limite: 200 });
      assert.ok(
        !inicioNoFuturo.some((item) => item.id === conversaRecente.id),
        'um início no futuro exclui a conversa de agora',
      );

      const fimNoPassado = await repositorio.listarConversas({ dataFim: umaHoraAtras, limite: 200 });
      assert.ok(
        !fimNoPassado.some((item) => item.id === conversaRecente.id),
        'um fim no passado também exclui a conversa de agora',
      );
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

    // ---------------------------------------------------------------- lembretes
    //
    // A fila é onde memória e PostgreSQL mais poderiam divergir: unicidade e
    // reivindicação exclusiva são garantias do banco que a implementação em
    // memória precisa imitar. Uma divergência aqui vira lembrete duplicado lá.

    await t.test('a fila de lembretes: unicidade, reivindicação e desfecho', async () => {
      const profissional = await repositorio.criarProfissional({ nome: 'Dra. Fila', duracaoMin: 30 });
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000001', nome: 'Paciente da Fila',
      });

      const inicio = new Date('2027-03-10T17:00:00.000Z');
      const agendamento = await repositorio.criarAgendamento({
        profissionalId: profissional.id,
        contatoId: contato.id,
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      });

      const pedido = {
        agendamentoId: agendamento.id,
        contatoId: contato.id,
        tipo: 'confirmacao_24h',
        janela: inicio.toISOString(),
        agendarPara: new Date(inicio.getTime() - 24 * 3_600_000).toISOString(),
      };

      const primeiro = await repositorio.enfileirarLembrete(pedido);
      assert.equal(primeiro.criado, true);
      assert.equal(primeiro.lembrete.estado, 'pendente');
      assert.equal(primeiro.lembrete.tentativas, 0);

      // Mesmo agendamento, mesmo tipo, mesma janela: não cria segunda linha.
      const segundo = await repositorio.enfileirarLembrete(pedido);
      assert.equal(segundo.criado, false);
      assert.equal(segundo.lembrete.id, primeiro.lembrete.id);

      // Janela diferente é outro lembrete: é assim que a remarcação funciona.
      // A hora de envio acompanha a janela nova, então ele ainda não vence junto.
      const remarcado = await repositorio.enfileirarLembrete({
        ...pedido,
        janela: new Date(inicio.getTime() + 3_600_000).toISOString(),
        agendarPara: new Date(inicio.getTime() + 3_600_000 - 24 * 3_600_000).toISOString(),
      });
      assert.equal(remarcado.criado, true);
      assert.notEqual(remarcado.lembrete.id, primeiro.lembrete.id);

      // A leitura traz o mundo que a decisão de envio precisa consultar.
      const lido = await repositorio.obterLembrete(primeiro.lembrete.id);
      assert.equal(lido.agendamento.status, 'agendado');
      assert.equal(lido.contato.telefone, '5516900000001');
      assert.equal(lido.contato.lembretes_optout, false);

      // Antes da hora, ninguém reivindica.
      const cedo = await repositorio.reivindicarLembretes({
        agora: new Date(inicio.getTime() - 48 * 3_600_000).toISOString(), limite: 10, worker: 'contrato',
      });
      assert.equal(cedo.length, 0);

      const naHora = new Date(inicio.getTime() - 24 * 3_600_000).toISOString();
      const reivindicados = await repositorio.reivindicarLembretes({ agora: naHora, limite: 10, worker: 'contrato' });
      assert.equal(reivindicados.length, 1);
      assert.equal(reivindicados[0].id, primeiro.lembrete.id);
      assert.equal(reivindicados[0].estado, 'processando');
      assert.equal(reivindicados[0].processando_por, 'contrato');

      // Reivindicado uma vez, não é servido de novo.
      const denovo = await repositorio.reivindicarLembretes({ agora: naHora, limite: 10, worker: 'outro' });
      assert.equal(denovo.length, 0);

      const enviado = await repositorio.concluirLembrete(primeiro.lembrete.id, {
        estado: 'enviado', modoEntrega: 'dry_run', entregaReferencia: 'dry-run:1', enviadoEm: naHora,
      });
      assert.equal(enviado.estado, 'enviado');
      assert.equal(enviado.modo_entrega, 'dry_run');
      // Sair de processando limpa o lease: senão a recuperação acharia trabalho onde não há.
      assert.equal(enviado.processando_desde, null);
      assert.equal(enviado.processando_por, null);

      // Fecha o da janela remarcada para não sobrar trabalho pendente na fila
      // compartilhada — os subtestes seguintes contam o que encontram nela.
      await repositorio.concluirLembrete(remarcado.lembrete.id, {
        estado: 'ignorado', ignoradoMotivo: 'remarcado',
      });
    });

    await t.test('lembrete preso volta à fila; esgotado, vai para falhou', async () => {
      const profissional = await repositorio.criarProfissional({ nome: 'Dra. Presa' });
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000002', nome: 'Paciente Preso',
      });
      const inicio = new Date('2027-04-10T17:00:00.000Z');
      const agendamento = await repositorio.criarAgendamento({
        profissionalId: profissional.id,
        contatoId: contato.id,
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      });

      const { lembrete } = await repositorio.enfileirarLembrete({
        agendamentoId: agendamento.id,
        contatoId: contato.id,
        tipo: 'confirmacao_2h',
        janela: inicio.toISOString(),
        agendarPara: new Date(inicio.getTime() - 2 * 3_600_000).toISOString(),
        maxTentativas: 2,
      });

      const naHora = new Date(inicio.getTime() - 2 * 3_600_000).toISOString();
      await repositorio.reivindicarLembretes({ agora: naHora, limite: 5, worker: 'worker-morto' });

      const depois = new Date(new Date(naHora).getTime() + 10 * 60_000).toISOString();
      const primeiraSoltura = await repositorio.liberarLembretesPresos({
        antesDe: depois, agora: depois,
      });
      assert.equal(primeiraSoltura.length, 1);
      assert.equal(primeiraSoltura[0].estado, 'pendente');
      assert.equal(primeiraSoltura[0].tentativas, 1);

      // Segunda vez: com max_tentativas 2, a linha termina em falhou.
      await repositorio.reivindicarLembretes({ agora: depois, limite: 5, worker: 'worker-morto' });
      const maisTarde = new Date(new Date(depois).getTime() + 10 * 60_000).toISOString();
      const segundaSoltura = await repositorio.liberarLembretesPresos({ antesDe: maisTarde, agora: maisTarde });

      assert.equal(segundaSoltura.length, 1);
      assert.equal(segundaSoltura[0].estado, 'falhou');
      assert.equal((await repositorio.obterLembrete(lembrete.id)).estado, 'falhou');
    });

    await t.test('opt-out do contato e cancelamento em massa da fila', async () => {
      const profissional = await repositorio.criarProfissional({ nome: 'Dra. Optout' });
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000003', nome: 'Paciente Optout',
      });
      const inicio = new Date('2027-05-10T17:00:00.000Z');
      const agendamento = await repositorio.criarAgendamento({
        profissionalId: profissional.id,
        contatoId: contato.id,
        inicio: inicio.toISOString(),
        fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      });

      for (const tipo of ['confirmacao_24h', 'confirmacao_2h']) {
        await repositorio.enfileirarLembrete({
          agendamentoId: agendamento.id,
          contatoId: contato.id,
          tipo,
          janela: inicio.toISOString(),
          agendarPara: new Date(inicio.getTime() - 3_600_000).toISOString(),
        });
      }

      const desligado = await repositorio.definirOptOutDeLembretes(contato.id, {
        optout: true, motivo: 'pediu no telefone',
      });
      assert.equal(desligado.lembretes_optout, true);
      assert.ok(desligado.lembretes_optout_em);
      assert.equal(desligado.lembretes_optout_motivo, 'pediu no telefone');

      const cancelados = await repositorio.cancelarLembretesDoContato(contato.id, { motivo: 'optout' });
      assert.equal(cancelados.length, 2);
      assert.ok(cancelados.every((item) => item.estado === 'ignorado'));

      // Ligar de volta apaga a data e o motivo: o registro do porquê fica na auditoria.
      const religado = await repositorio.definirOptOutDeLembretes(contato.id, { optout: false });
      assert.equal(religado.lembretes_optout, false);
      assert.equal(religado.lembretes_optout_em, null);

      assert.equal(await repositorio.definirOptOutDeLembretes(999999, { optout: true }), null);
    });

    await t.test('cancelar a fila de um agendamento preserva a janela indicada', async () => {
      const profissional = await repositorio.criarProfissional({ nome: 'Dra. Remarca' });
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000004', nome: 'Paciente Remarca',
      });
      const antiga = new Date('2027-06-10T17:00:00.000Z');
      const nova = new Date('2027-06-11T17:00:00.000Z');
      const agendamento = await repositorio.criarAgendamento({
        profissionalId: profissional.id,
        contatoId: contato.id,
        inicio: antiga.toISOString(),
        fim: new Date(antiga.getTime() + 30 * 60_000).toISOString(),
      });

      for (const janela of [antiga, nova]) {
        await repositorio.enfileirarLembrete({
          agendamentoId: agendamento.id,
          contatoId: contato.id,
          tipo: 'confirmacao_24h',
          janela: janela.toISOString(),
          agendarPara: new Date(janela.getTime() - 24 * 3_600_000).toISOString(),
        });
      }

      const cancelados = await repositorio.cancelarLembretesDoAgendamento(agendamento.id, {
        motivo: 'remarcado', exceto: nova.toISOString(),
      });

      assert.equal(cancelados.length, 1);
      assert.equal(cancelados[0].janela.toISOString?.() ?? cancelados[0].janela, antiga.toISOString());

      const naFila = await repositorio.listarLembretes({ agendamentoId: agendamento.id, estado: 'pendente' });
      assert.equal(naFila.length, 1);
    });

    await t.test('a contagem por estado separa dry-run de envio real', async () => {
      const contagem = await repositorio.contarLembretesPorEstado();

      assert.ok(Number.isInteger(contagem.por_estado.pendente));
      assert.ok(Number.isInteger(contagem.por_estado.ignorado));
      assert.ok(Number.isInteger(contagem.entregas.dry_run));
      assert.ok(Number.isInteger(contagem.entregas.real));
      // O que o resumo mostra precisa vir das duas implementações com a mesma forma.
      assert.deepEqual(
        Object.keys(contagem.por_estado).sort(),
        ['enviado', 'falhou', 'ignorado', 'pendente', 'processando'],
      );
    });

    // ---------------------------------------------------------------- Serena

    await t.test('o interruptor da Serena guarda quem mexeu e por quê', async () => {
      const inicial = await repositorio.obterConfiguracaoDaSerena();
      assert.equal(inicial.ativa, true, 'a Serena nasce ligada');

      const desligada = await repositorio.definirConfiguracaoDaSerena({
        ativa: false, motivo: 'respondendo errado', usuarioId: null,
      });
      assert.equal(desligada.ativa, false);
      assert.equal(desligada.motivo, 'respondendo errado');
      assert.ok(desligada.alterado_em);

      const religada = await repositorio.definirConfiguracaoDaSerena({ ativa: true, motivo: null });
      assert.equal(religada.ativa, true);
      assert.equal((await repositorio.obterConfiguracaoDaSerena()).ativa, true);
    });

    await t.test('prompt: versão sequencial, edição só de rascunho, uma publicada por vez', async () => {
      const primeira = await repositorio.criarPromptDaSerena({
        titulo: 'Política v1', conteudo: 'Você é Serena, assistente da clínica.',
      });
      const segunda = await repositorio.criarPromptDaSerena({
        titulo: 'Política v2', conteudo: 'Você é Serena, com política revista.',
      });

      // A numeração vem do banco: duas pessoas salvando ao mesmo tempo não
      // recebem o mesmo número.
      assert.equal(segunda.versao, primeira.versao + 1);

      // Rascunho se edita.
      const editada = await repositorio.atualizarPromptDaSerena(primeira.id, {
        titulo: 'Política v1 revista', conteudo: 'Texto revisado da política da clínica.',
      });
      assert.equal(editada.titulo, 'Política v1 revista');

      await repositorio.publicarPromptDaSerena(primeira.id, {});
      assert.equal((await repositorio.obterPromptPublicadoDaSerena()).id, primeira.id);

      // Publicada não se edita: o repositório devolve `null` e o serviço traduz.
      assert.equal(await repositorio.atualizarPromptDaSerena(primeira.id, {
        titulo: 'x', conteudo: 'tentativa de reescrever o que está no ar',
      }), null);

      // Publicar a segunda tira a primeira do ar — sem instante nenhum com duas.
      await repositorio.publicarPromptDaSerena(segunda.id, {});
      const publicado = await repositorio.obterPromptPublicadoDaSerena();
      assert.equal(publicado.id, segunda.id);

      const todas = await repositorio.listarPromptsDaSerena({ limite: 50 });
      assert.equal(todas.filter((prompt) => prompt.publicado).length, 1);
    });

    await t.test('regras: criar, ligar, desligar, apagar e nome único', async () => {
      const regra = await repositorio.criarRegraDaSerena({
        nome: 'contrato: sem diagnóstico', categoria: 'barreira', conteudo: 'Nunca diagnostique.', ordem: 10,
      });
      assert.equal(regra.ativa, true, 'regra nasce ligada');

      await assert.rejects(
        () => repositorio.criarRegraDaSerena({
          nome: 'contrato: sem diagnóstico', categoria: 'geral', conteudo: 'outra',
        }),
        (erro) => {
          // Mesmo sinal nas duas implementações, para o serviço tratar igual.
          assert.equal(erro.code, '23505');
          return true;
        },
      );

      const desligada = await repositorio.atualizarRegraDaSerena(regra.id, { ativa: false });
      assert.equal(desligada.ativa, false);

      const ativas = await repositorio.listarRegrasDaSerena({ apenasAtivas: true });
      assert.ok(!ativas.some((item) => item.id === regra.id), 'desligada some da lista de ativas');

      assert.equal(await repositorio.removerRegraDaSerena(regra.id), 1);
      assert.equal(await repositorio.obterRegraDaSerena(regra.id), null);
    });

    // ---------------------------------------------------------------- contatos

    await t.test('contato: criação, telefone único e soft delete', async () => {
      const contato = await repositorio.criarContato({
        nome: 'Contrato Paciente', telefone: '5516900000777',
      });
      assert.equal(contato.excluido_em, null);

      await assert.rejects(
        () => repositorio.criarContato({ nome: 'Outro', telefone: '5516900000777' }),
        (erro) => {
          assert.equal(erro.code, '23505');
          return true;
        },
      );

      // O telefone acha o contato mesmo depois de excluído — é o que impede a
      // segunda ficha para a mesma pessoa.
      const excluido = await repositorio.excluirContato(contato.id, { motivo: 'contrato' });
      assert.ok(excluido.excluido_em);
      assert.equal((await repositorio.obterContatoPorTelefone('5516900000777')).id, contato.id);

      // E some das listas de trabalho.
      const listados = await repositorio.listarContatos({});
      assert.ok(!listados.some((item) => item.id === contato.id));
      const comExcluidos = await repositorio.listarContatos({ incluirExcluidos: true });
      assert.ok(comExcluidos.some((item) => item.id === contato.id));

      // Excluir de novo não faz nada; restaurar traz de volta.
      assert.equal(await repositorio.excluirContato(contato.id, {}), null);
      const restaurado = await repositorio.restaurarContato(contato.id);
      assert.equal(restaurado.excluido_em, null);
    });

    await t.test('contato excluído que reescreve é reativado, não duplicado', async () => {
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000778', nome: 'Volta Sempre',
      });
      await repositorio.excluirContato(contato.id, { motivo: 'engano' });

      const reencontrado = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000778', nome: 'Volta Sempre',
      });

      assert.equal(reencontrado.id, contato.id);
      assert.equal(reencontrado.excluido_em, null);
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
