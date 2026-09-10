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
                 agente_canais, agente_acoes_inatividade, agente_treinamentos, agente_comportamentos, agentes,
                 automacao_outbox,
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

    await t.test('contato sem telefone (Instagram) não duplica pelo identificador', async () => {
      const primeiro = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-1', nome: 'Ana', canal: 'instagram',
      });
      const segundo = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-1', nome: 'Ana Paula', canal: 'instagram',
      });

      assert.equal(primeiro.id, segundo.id);
      assert.equal(segundo.nome, 'Ana', 'nome já registrado não é sobrescrito');
    });

    await t.test('dois PSIDs diferentes do Instagram nunca colidem no mesmo contato', async () => {
      const a = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-a', nome: 'Pessoa A', canal: 'instagram',
      });
      const b = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-b', nome: 'Pessoa B', canal: 'instagram',
      });

      assert.notEqual(a.id, b.id);
    });

    await t.test('telefone adicionado depois a um contato do Instagram não quebra o reconhecimento pelo identificador', async () => {
      // Achado da revisão de banco de 23/08: a Serena vai perguntar telefone
      // durante a qualificação de um lead do Instagram — se isso "promover" o
      // contato (ganhar telefone além do identificador) fizer a PRÓXIMA
      // mensagem da mesma pessoa criar um contato novo, é exatamente a
      // duplicação que a correção original devia evitar, só que por outra porta.
      const criado = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-promovido', nome: 'Beatriz', canal: 'instagram',
      });
      await repositorio.atualizarContato(criado.id, { telefone: '5516999998888' });

      const depoisDePromovido = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-psid-contrato-promovido', nome: 'Beatriz', canal: 'instagram',
      });

      assert.equal(depoisDePromovido.id, criado.id, 'segunda mensagem do mesmo PSID precisa achar o MESMO contato');
      assert.equal(depoisDePromovido.telefone, '5516999998888', 'o telefone gravado manualmente não pode ser apagado');
    });

    await t.test('dois contatos incompletos (sem telefone nem identificador) nunca colidem entre si', async () => {
      // Cadastro manual parcial (ex.: a feature de qualidade cadastral) — sem
      // NENHUMA chave, cada chamada tem que criar um contato novo, nunca casar
      // com um incompleto anterior de outra pessoa.
      const um = await repositorio.encontrarOuCriarContato({ telefone: null, nome: 'Incompleto Um' });
      const dois = await repositorio.encontrarOuCriarContato({ telefone: null, nome: 'Incompleto Dois' });

      assert.notEqual(um.id, dois.id);
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

    await t.test('origemDetalhe é gravado na criação e sobrevive a atualizações posteriores', async () => {
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: null, identificador: 'ig-origem-detalhe-1', nome: 'Teste Origem Detalhe', canal: 'instagram',
      });

      const criado = await repositorio.salvarLead(contato.id, {
        origem: 'INSTAGRAM', origemDetalhe: 'Comentário-gatilho: preço',
      });
      assert.equal(criado.origem_detalhe, 'Comentário-gatilho: preço');

      // Mesmo raciocínio de `origem`: não é sobrescrito numa atualização
      // posterior da mesma conversa (descreve de onde o lead nasceu).
      const atualizado = await repositorio.salvarLead(contato.id, { temperatura: 'quente' });
      assert.equal(atualizado.origem_detalhe, 'Comentário-gatilho: preço');

      const obtido = await repositorio.obterLead(criado.id);
      assert.equal(obtido.origem_detalhe, 'Comentário-gatilho: preço');
    });

    await t.test('metricasInstagram soma comentários processados, com/sem gatilho, e agrupa por regra', async () => {
      const regraA = await repositorio.criarRegraDeGatilho({
        nome: 'Métrica - regra A', palavraGatilho: 'preço', mensagemDm: 'DM de teste bem detalhada aqui.',
        mensagemPublica: 'Resposta pública de teste.',
      });
      const regraB = await repositorio.criarRegraDeGatilho({
        nome: 'Métrica - regra B', palavraGatilho: 'agendar', mensagemDm: 'Outra DM de teste bem detalhada.',
        mensagemPublica: 'Outra resposta pública.',
      });

      await repositorio.registrarComentarioProcessado({
        comentarioIdExterno: 'metrica-c1', autorIgId: 'ig1', regraId: regraA.id,
        respostaPublicaEnviada: true, dmEnviada: true,
      });
      await repositorio.registrarComentarioProcessado({
        comentarioIdExterno: 'metrica-c2', autorIgId: 'ig2', regraId: regraA.id,
        respostaPublicaEnviada: true, dmEnviada: false,
      });
      await repositorio.registrarComentarioProcessado({
        comentarioIdExterno: 'metrica-c3', autorIgId: 'ig3', regraId: null,
        respostaPublicaEnviada: false, dmEnviada: false,
      });

      const metricas = await repositorio.metricasInstagram();
      assert.ok(metricas.total_comentarios >= 3);
      assert.ok(metricas.com_gatilho >= 2);
      assert.ok(metricas.resposta_publica_enviada >= 2);
      assert.ok(metricas.dm_enviada >= 1);

      const linhaA = metricas.por_regra.find((r) => r.id === regraA.id);
      const linhaB = metricas.por_regra.find((r) => r.id === regraB.id);
      assert.ok(linhaA, 'regra A aparece no agrupamento mesmo sem ter recebido comentário nenhum ainda seria ok, mas aqui recebeu 2');
      assert.equal(linhaA.total, 2);
      assert.ok(linhaB, 'regra B aparece no agrupamento mesmo com 0 comentários — LEFT JOIN, não INNER');
      assert.equal(linhaB.total, 0);
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

    await t.test('ativação gradual: o que é gravado é o que a decisão real relê depois', async () => {
      // Achado da auditoria de 22/08: `obterConfiguracaoDaSerena` no PostgreSQL
      // não trazia `modo_ativacao`/`ativacao_percentual` no SELECT — um rollout
      // parcial gravado por `definirAtivacaoGradual` sobrevivia no banco, mas a
      // decisão de resposta (que só chama `obterConfiguracaoDaSerena`, nunca
      // `definirAtivacaoGradual`) nunca via a restrição e caía no `?? 'todos'`,
      // respondendo a 100% dos contatos mesmo com um percentual configurado.
      const gravado = await repositorio.definirAtivacaoGradual({ modo: 'percentual', percentual: 30 });
      assert.equal(gravado.modo_ativacao, 'percentual');
      assert.equal(gravado.ativacao_percentual, 30);

      const relido = await repositorio.obterConfiguracaoDaSerena();
      assert.equal(relido.modo_ativacao, 'percentual', 'a decisão real relê por aqui — precisa bater com o que foi gravado');
      assert.equal(relido.ativacao_percentual, 30);

      // Devolve ao padrão para não vazar estado para os testes seguintes.
      const restaurado = await repositorio.definirAtivacaoGradual({ modo: 'todos', percentual: 100 });
      assert.equal(restaurado.modo_ativacao, 'todos');
      assert.equal((await repositorio.obterConfiguracaoDaSerena()).modo_ativacao, 'todos');
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

    await t.test('conversa reaberta depois de resumida volta para a fila do resumo', async () => {
      // Achado de 05/09: o filtro era `resumo_enviado_em IS NULL` e nada nunca
      // devolvia a coluna a nulo. Um lead que escreve, some e volta dois dias
      // depois gerava UM aviso à equipe na vida inteira dele — a conversa 875
      // ficou exatamente assim: resumida em 04/09, ativa de novo em 05/09 e
      // nenhum aviso novo.
      //
      // As esperas curtas existem só para os instantes não caírem no mesmo
      // milissegundo: o que se testa é a ordem entre eles, não a duração.
      const respirar = () => new Promise((seguir) => { setTimeout(seguir, 5); });
      const contato = await repositorio.encontrarOuCriarContato({
        telefone: '5516900000900', nome: 'Rita Resumo',
      });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id);
      const ehEsta = async () => (await repositorio.listarConversasSemResumo({ silencioMin: 0, limite: 100 }))
        .some((item) => Number(item.id) === Number(conversa.id));

      await repositorio.registrarMensagem(conversa.id, {
        direcao: 'entrada', conteudo: 'bom dia, queria marcar', autor_tipo: 'contato',
      });
      await respirar();
      assert.equal(await ehEsta(), true, 'conversa esfriada precisa entrar na varredura');

      await repositorio.marcarResumoEnviado(conversa.id);
      await respirar();
      assert.equal(await ehEsta(), false, 'resumo já enviado não sai de novo pelo mesmo assunto');

      await repositorio.registrarMensagem(conversa.id, {
        direcao: 'entrada', conteudo: 'voltei, ainda da tempo?', autor_tipo: 'contato',
      });
      await respirar();
      assert.equal(await ehEsta(), true, 'mensagem nova depois do resumo devolve a conversa à varredura');
    });

    // ---------------------------------------------------------- agentes (046)
    //
    // Contrato dos agentes configuráveis (docs/AGENTES.md). Em memória isto
    // roda sempre. Contra PostgreSQL só roda com CRMCLINICA_TEST_DATABASE_URL
    // apontando para um banco de teste COM a migration 046 aplicada — sem
    // isso, o SQL de agentes em repositorio.js não foi executado por esta
    // suíte, e passar aqui não prova nada sobre ele.

    const { normalizarConfiguracoes } = require('../src/dominio/agentes/regras');
    const criarAgenteDeTeste = (slug, extras = {}) => repositorio.criarAgente(
      { slug, nome: `Agente ${slug}`, ...extras },
      { usuarioId: null },
    );
    const conversaDoAgente = async (agenteId, telefone) => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone, nome: `Contato ${telefone}` });
      return repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId });
    };

    await t.test('agente: criar, obter por id e slug, listar — com padrões e listas vazias', async () => {
      const criado = await criarAgenteDeTeste('contrato-a', { descricao: 'Vendedor', comportamento: 'Seja cordial.' });

      assert.equal(typeof criado.id, 'number');
      assert.equal(criado.slug, 'contrato-a');
      assert.equal(criado.nome, 'Agente contrato-a');
      assert.equal(criado.descricao, 'Vendedor');
      assert.equal(criado.status, 'desativado', 'agente novo nunca nasce respondendo');
      assert.equal(criado.comunicacao, 'normal');
      assert.equal(criado.finalidade, 'suporte');
      assert.equal(criado.comportamento, 'Seja cordial.');
      assert.equal(criado.empresa_nome, null);
      assert.equal(criado.provedor, null);
      assert.equal(criado.modelo, null);
      assert.deepEqual(criado.configuracoes, normalizarConfiguracoes({}));
      assert.deepEqual(criado.canais, []);
      assert.deepEqual(criado.acoes_inatividade, []);
      assert.ok(criado.criado_em);
      assert.ok(criado.atualizado_em);

      assert.deepEqual(await repositorio.obterAgente(criado.id), criado);
      assert.equal((await repositorio.obterAgentePorSlug('contrato-a')).id, criado.id);
      assert.equal(await repositorio.obterAgente(999999), null);
      assert.equal(await repositorio.obterAgentePorSlug('nao-existe'), null);
      assert.ok((await repositorio.listarAgentes()).some((agente) => agente.id === criado.id));
    });

    await t.test('agente: slug duplicado é 409 agente_slug_duplicado, na criação e na edição', async () => {
      const primeiro = await criarAgenteDeTeste('contrato-dup');
      await assert.rejects(() => criarAgenteDeTeste('contrato-dup'),
        (erro) => erro.status === 409 && erro.codigo === 'agente_slug_duplicado');

      const segundo = await criarAgenteDeTeste('contrato-dup-2');
      await assert.rejects(() => repositorio.atualizarAgente(segundo.id, { slug: 'contrato-dup' }),
        (erro) => erro.status === 409 && erro.codigo === 'agente_slug_duplicado');
      assert.equal((await repositorio.obterAgente(segundo.id)).slug, 'contrato-dup-2', 'recusa não grava nada');
      assert.equal((await repositorio.obterAgente(primeiro.id)).slug, 'contrato-dup');
    });

    await t.test('agente: edição mescla configurações parciais e só grava histórico quando o comportamento muda', async () => {
      const agente = await criarAgenteDeTeste('contrato-edicao', {
        comportamento: 'v1', configuracoes: { usar_emojis: true },
      });
      assert.equal(agente.configuracoes.usar_emojis, true);
      assert.deepEqual((await repositorio.listarHistoricoDeComportamento(agente.id)).map((h) => h.comportamento), ['v1'],
        'o comportamento inicial já é um ponto de restauração');

      const mesmo = await repositorio.atualizarAgente(agente.id, { comportamento: 'v1', status: 'ativo' });
      assert.equal(mesmo.status, 'ativo');
      assert.equal((await repositorio.listarHistoricoDeComportamento(agente.id)).length, 1, 'comportamento igual não gera histórico');

      const editado = await repositorio.atualizarAgente(agente.id, {
        comportamento: 'v2', configuracoes: { assinar_nome: true }, nome: 'Agente Editado',
      }, { usuarioId: null });
      assert.equal(editado.comportamento, 'v2');
      assert.equal(editado.nome, 'Agente Editado');
      assert.equal(editado.configuracoes.usar_emojis, true, 'configuração não informada é preservada');
      assert.equal(editado.configuracoes.assinar_nome, true);
      assert.ok(new Date(editado.atualizado_em).getTime() >= new Date(agente.atualizado_em).getTime());

      const historico = await repositorio.listarHistoricoDeComportamento(agente.id);
      assert.deepEqual(historico.map((h) => h.comportamento), ['v2', 'v1'], 'mais recente primeiro');
      assert.equal(typeof historico[0].id, 'number');
      assert.equal(historico[0].criado_por, null);
      assert.ok(historico[0].criado_em);
      assert.equal((await repositorio.listarHistoricoDeComportamento(agente.id, { limite: 1 })).length, 1);

      const ignorado = await repositorio.atualizarAgente(agente.id, { id: 424242, criado_em: '2000-01-01T00:00:00Z' });
      assert.equal(ignorado.id, agente.id, 'coluna fora da lista não é gravada');
      assert.equal(await repositorio.atualizarAgente(999999, { nome: 'Fantasma' }), null);
    });

    await t.test('agente: treinamentos em ordem de cadastro, escopados pelo agente', async () => {
      const agente = await criarAgenteDeTeste('contrato-treino');
      const outro = await criarAgenteDeTeste('contrato-treino-outro');

      const primeiro = await repositorio.criarTreinamento(agente.id, { tipo: 'texto', conteudo: 'Frete grátis.' });
      const segundo = await repositorio.criarTreinamento(agente.id, {
        tipo: 'website', titulo: 'Site', conteudo: 'Texto do site', origem: 'https://exemplo.com',
      });
      assert.equal(typeof primeiro.id, 'number');
      assert.equal(primeiro.tipo, 'texto');
      assert.equal(primeiro.status, 'treinado');
      assert.equal(primeiro.titulo, null);
      assert.equal(primeiro.origem, null);
      assert.equal(segundo.origem, 'https://exemplo.com');

      assert.deepEqual((await repositorio.listarTreinamentos(agente.id)).map((item) => item.id), [primeiro.id, segundo.id]);
      assert.deepEqual(await repositorio.listarTreinamentos(outro.id), []);

      assert.equal(await repositorio.removerTreinamento(outro.id, primeiro.id), false, 'não remove treinamento de outro agente');
      assert.equal(await repositorio.removerTreinamento(agente.id, primeiro.id), true);
      assert.equal(await repositorio.removerTreinamento(agente.id, primeiro.id), false);
      assert.deepEqual((await repositorio.listarTreinamentos(agente.id)).map((item) => item.id), [segundo.id]);
      assert.equal(await repositorio.criarTreinamento(999999, { tipo: 'texto', conteudo: 'x' }), null);
    });

    await t.test('agente: ações de inatividade substituem todas as anteriores', async () => {
      const agente = await criarAgenteDeTeste('contrato-inatividade');

      const primeiras = await repositorio.definirAcoesDeInatividade(agente.id, [
        { apos_minutos: 5, acao: 'interagir', instrucao: 'Ainda tem interesse?', ordem: 0 },
        { apos_minutos: 30, acao: 'finalizar', instrucao: null, ordem: 1 },
      ]);
      assert.deepEqual(primeiras.map((a) => [a.apos_minutos, a.acao, a.instrucao, a.ordem]), [
        [5, 'interagir', 'Ainda tem interesse?', 0], [30, 'finalizar', null, 1],
      ]);
      assert.equal(typeof primeiras[0].id, 'number');

      const trocadas = await repositorio.definirAcoesDeInatividade(agente.id, [
        { apos_minutos: 10, acao: 'finalizar', instrucao: null, ordem: 0 },
      ]);
      assert.deepEqual(trocadas.map((a) => a.apos_minutos), [10]);
      assert.deepEqual((await repositorio.obterAgente(agente.id)).acoes_inatividade.map((a) => a.apos_minutos), [10]);

      assert.deepEqual(await repositorio.definirAcoesDeInatividade(agente.id, []), []);
      assert.equal(await repositorio.definirAcoesDeInatividade(999999, []), null);
    });

    await t.test('agente: canais substituem; só canal ativo roteia; canal de outro agente é 409 sem gravar nada', async () => {
      const dono = await criarAgenteDeTeste('contrato-canal-dono');
      const intruso = await criarAgenteDeTeste('contrato-canal-intruso');

      const canais = await repositorio.definirCanaisDoAgente(dono.id, [
        { canal: 'whatsapp', instancia: 'contrato-inst-1', ativo: true },
        { canal: 'whatsapp', instancia: 'contrato-inst-2', ativo: false },
      ]);
      assert.deepEqual(canais.map((c) => [c.canal, c.instancia, c.ativo]), [
        ['whatsapp', 'contrato-inst-1', true], ['whatsapp', 'contrato-inst-2', false],
      ]);
      assert.equal(typeof canais[0].id, 'number');
      assert.equal((await repositorio.obterAgentePorCanal('whatsapp', 'contrato-inst-1')).id, dono.id);
      assert.equal(await repositorio.obterAgentePorCanal('whatsapp', 'contrato-inst-2'), null,
        'canal desligado não tem dono para o roteamento');
      // Na recepção a instância desligada continua sendo do agente: cair no
      // fluxo da clínica faria o número da clínica responder por ela.
      assert.equal(
        (await repositorio.obterAgentePorCanal('whatsapp', 'contrato-inst-2', { incluirInativos: true })).id,
        dono.id,
      );
      assert.equal(
        (await repositorio.obterAgentePorCanal('whatsapp', 'contrato-inst-1', { incluirInativos: true })).id,
        dono.id,
      );
      assert.equal(await repositorio.obterAgentePorCanal('whatsapp', 'inst-sem-dono', { incluirInativos: true }), null);
      assert.equal(await repositorio.obterAgentePorCanal('instagram', 'contrato-inst-1'), null);

      await assert.rejects(
        () => repositorio.definirCanaisDoAgente(intruso.id, [{ canal: 'whatsapp', instancia: 'contrato-inst-2', ativo: true }]),
        (erro) => erro.status === 409 && erro.codigo === 'canal_de_outro_agente',
      );
      assert.deepEqual((await repositorio.obterAgente(intruso.id)).canais, [], 'a recusa não grava nada');
      assert.equal((await repositorio.obterAgente(dono.id)).canais.length, 2, 'a recusa não apaga os do dono');

      // O que o dono deixa de ter fica livre para outro agente.
      await repositorio.definirCanaisDoAgente(dono.id, [{ canal: 'whatsapp', instancia: 'contrato-inst-1', ativo: true }]);
      const liberado = await repositorio.definirCanaisDoAgente(intruso.id, [
        { canal: 'whatsapp', instancia: 'contrato-inst-2', ativo: true },
      ]);
      assert.equal(liberado.length, 1);
      assert.equal((await repositorio.obterAgentePorCanal('whatsapp', 'contrato-inst-2')).id, intruso.id);
      assert.equal(await repositorio.definirCanaisDoAgente(999999, []), null);
    });

    await t.test('conversa escopada por agente: clínica e agente separadas para o mesmo contato', async () => {
      const agente = await criarAgenteDeTeste('contrato-escopo');
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900001001', nome: 'Duplo Contato' });

      const daClinica = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      const doAgente = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId: agente.id });
      assert.notEqual(doAgente.id, daClinica.id);
      assert.equal(daClinica.agente_id, null);
      assert.equal(daClinica.agente_nome, null);
      assert.equal(doAgente.agente_id, agente.id);
      assert.equal(doAgente.agente_nome, agente.nome);

      assert.equal((await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp')).id, daClinica.id,
        'a chamada antiga, sem agente, continua achando a conversa da clínica');
      assert.equal(
        (await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId: agente.id })).id,
        doAgente.id,
      );

      const obtida = await repositorio.obterConversa(doAgente.id);
      const listada = (await repositorio.listarConversas({ limite: 1000 })).find((item) => item.id === doAgente.id);
      for (const campo of ['agente_id', 'agente_nome']) {
        assert.deepEqual(obtida[campo], listada[campo], `campo "${campo}" difere entre obter e listar`);
      }

      const soDoAgente = await repositorio.listarConversas({ agenteId: agente.id, limite: 1000 });
      assert.deepEqual(soDoAgente.map((c) => c.id), [doAgente.id]);
      const soDaClinica = await repositorio.listarConversas({ agenteId: null, limite: 1000 });
      assert.ok(soDaClinica.some((c) => c.id === daClinica.id));
      assert.ok(!soDaClinica.some((c) => c.id === doAgente.id), 'agenteId null filtra só a clínica');
    });

    await t.test('contarRespostasDaAutomacao conta só a automação visível', async () => {
      const agente = await criarAgenteDeTeste('contrato-contagem');
      const conversa = await conversaDoAgente(agente.id, '5516900001002');

      await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'oi', autor_tipo: 'contato' });
      await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'olá', autor_tipo: 'automacao' });
      await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'posso ajudar?', autor_tipo: 'automacao' });
      await repositorio.registrarMensagem(conversa.id, {
        direcao: 'saida', conteudo: 'nota', autor_tipo: 'automacao', privada: true,
      });
      await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'sou da equipe', autor_tipo: 'equipe' });

      assert.equal(await repositorio.contarRespostasDaAutomacao(conversa.id), 2);
    });

    await t.test('inatividade: só conversa de agente aberta, sem humano, cuja última mensagem visível é da automação', async () => {
      const agente = await criarAgenteDeTeste('contrato-ocioso');
      const saida = (conversaId) => repositorio.registrarMensagem(conversaId, {
        direcao: 'saida', conteudo: 'alguma dúvida?', autor_tipo: 'automacao',
      });
      const entrada = (conversaId) => repositorio.registrarMensagem(conversaId, {
        direcao: 'entrada', conteudo: 'oi', autor_tipo: 'contato',
      });

      const esperandoCliente = await conversaDoAgente(agente.id, '5516900001011');
      await entrada(esperandoCliente.id);
      await saida(esperandoCliente.id);

      const clienteFalouPorUltimo = await conversaDoAgente(agente.id, '5516900001012');
      await saida(clienteFalouPorUltimo.id);
      await entrada(clienteFalouPorUltimo.id);

      const assumida = await conversaDoAgente(agente.id, '5516900001013');
      await saida(assumida.id);
      await repositorio.atualizarConversa(assumida.id, { assumida_por_humano: true });

      const resolvida = await conversaDoAgente(agente.id, '5516900001014');
      await saida(resolvida.id);
      await repositorio.atualizarConversa(resolvida.id, { status: 'resolvida' });

      const notaPorUltimo = await conversaDoAgente(agente.id, '5516900001015');
      await saida(notaPorUltimo.id);
      await repositorio.registrarMensagem(notaPorUltimo.id, {
        direcao: 'saida', tipo: 'sistema', conteudo: 'nota interna', autor_tipo: 'sistema', privada: true,
      });

      const daClinica = await conversaDoAgente(null, '5516900001016');
      await saida(daClinica.id);

      const lista = await repositorio.listarConversasDeAgenteParaInatividade({ limite: 1000 });
      const ids = lista.map((item) => item.conversa_id);
      assert.ok(ids.includes(esperandoCliente.id));
      assert.ok(ids.includes(notaPorUltimo.id), 'nota privada não conta como última mensagem');
      for (const fora of [clienteFalouPorUltimo, assumida, resolvida, daClinica]) {
        assert.ok(!ids.includes(fora.id), `conversa ${fora.id} não deveria entrar na varredura`);
      }

      const item = lista.find((registro) => registro.conversa_id === esperandoCliente.id);
      assert.equal(item.agente_id, agente.id);
      assert.equal(typeof item.ultima_mensagem_id, 'number');
      assert.equal(item.ultima_mensagem_autor, 'automacao');
      assert.ok(item.ultima_mensagem_em);
    });

    await t.test('resumo da equipe e liberação em massa ignoram conversas de agente', async () => {
      const respirar = () => new Promise((seguir) => { setTimeout(seguir, 5); });
      const agente = await criarAgenteDeTeste('contrato-sem-resumo');
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900001021', nome: 'Resumo Duplo' });
      const doAgente = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId: agente.id });
      const daClinica = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

      for (const conversa of [doAgente, daClinica]) {
        await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'olá', autor_tipo: 'contato' });
      }
      await respirar();

      const semResumo = (await repositorio.listarConversasSemResumo({ silencioMin: 0, limite: 1000 }))
        .map((item) => Number(item.id));
      assert.ok(semResumo.includes(daClinica.id));
      assert.ok(!semResumo.includes(doAgente.id), 'conversa de agente não gera resumo para a equipe da clínica');

      await repositorio.atualizarConversa(doAgente.id, { assumida_por_humano: true });
      await repositorio.atualizarConversa(daClinica.id, { assumida_por_humano: true });
      const escalonadas = await repositorio.listarConversasEscalonadasSemDono();
      assert.ok(escalonadas.includes(daClinica.id));
      assert.ok(!escalonadas.includes(doAgente.id), 'transferência do agente para humano não é liberada em massa');
    });

    await t.test('outbox: disponivelEm agenda o trabalho; sem ele, fica disponível já', async () => {
      const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900001031', nome: 'Fila Agendada' });
      const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
      const base = Date.now();
      const futuro = new Date(base + 60 * 60 * 1000).toISOString();

      const { trabalho: agendado } = await repositorio.enfileirarTrabalhoDeOutbox({
        conversaId: conversa.id, chaveIdempotencia: `contrato:agendado:${conversa.id}`, disponivelEm: futuro,
      });
      const { trabalho: imediato } = await repositorio.enfileirarTrabalhoDeOutbox({
        conversaId: conversa.id, chaveIdempotencia: `contrato:imediato:${conversa.id}`,
      });
      assert.equal(new Date(agendado.disponivel_em).getTime(), new Date(futuro).getTime());
      assert.ok(new Date(imediato.disponivel_em).getTime() <= Date.now() + 1000);

      const logo = await repositorio.reivindicarTrabalhosDeOutbox({
        agora: new Date(base + 5000).toISOString(), limite: 1000, worker: 'contrato',
      });
      assert.ok(logo.some((trabalho) => trabalho.id === imediato.id));
      assert.ok(!logo.some((trabalho) => trabalho.id === agendado.id), 'trabalho agendado não sai antes da hora');

      const depois = await repositorio.reivindicarTrabalhosDeOutbox({
        agora: new Date(base + 2 * 60 * 60 * 1000).toISOString(), limite: 1000, worker: 'contrato',
      });
      assert.ok(depois.some((trabalho) => trabalho.id === agendado.id));
    });
  });
}
