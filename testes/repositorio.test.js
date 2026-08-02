'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// Estes testes descrevem o contrato do repositório — o mesmo que a implementação
// PostgreSQL precisa cumprir. Rodam em memória para não exigir banco no CI.

async function comConversa(repositorio, { telefone = '5516999999999', nome = 'Marina Souza' } = {}) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  return { contato, conversa };
}

test('encontrarOuCriarContato não duplica pelo telefone', async () => {
  const repositorio = criarRepositorioEmMemoria();

  const primeiro = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina' });
  const segundo = await repositorio.encontrarOuCriarContato({ telefone: '5516999999999', nome: 'Marina Souza' });

  assert.equal(primeiro.id, segundo.id, 'o mesmo telefone é a mesma pessoa');
});

test('o nome já registrado não é sobrescrito por um vazio', async () => {
  const repositorio = criarRepositorioEmMemoria();

  await repositorio.encontrarOuCriarContato({ telefone: '551188887777', nome: 'João Lima' });
  const novamente = await repositorio.encontrarOuCriarContato({ telefone: '551188887777', nome: null });

  assert.equal(novamente.nome, 'João Lima');
});

test('mensagem nova reaproveita a conversa aberta em vez de abrir outra', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato, conversa } = await comConversa(repositorio);

  const mesma = await repositorio.encontrarOuCriarConversaAberta(contato.id);
  assert.equal(mesma.id, conversa.id);

  // Resolvida a conversa, a próxima mensagem merece uma nova.
  await repositorio.atualizarConversa(conversa.id, { status: 'resolvida' });
  const nova = await repositorio.encontrarOuCriarConversaAberta(contato.id);
  assert.notEqual(nova.id, conversa.id);
});

test('registrar mensagem move o relógio da conversa', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  assert.equal(conversa.ultima_msg_em, null);

  await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'Olá' });
  const atualizada = await repositorio.obterConversa(conversa.id);

  assert.ok(atualizada.ultima_msg_em, 'a conversa precisa subir na lista');
  assert.equal(atualizada.previa, 'Olá');
});

test('nota interna não conta como atividade do atendimento', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'Olá' });
  const depoisDaMensagem = await repositorio.obterConversa(conversa.id);

  await repositorio.registrarMensagem(conversa.id, {
    direcao: 'saida', conteudo: 'nota da equipe', privada: true,
  });
  const depoisDaNota = await repositorio.obterConversa(conversa.id);

  assert.equal(depoisDaNota.ultima_msg_em, depoisDaMensagem.ultima_msg_em);
  assert.equal(depoisDaNota.previa, 'Olá', 'a prévia mostra o que o paciente vê');
});

test('mensagem reentregue pelo canal não vira duas linhas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  const primeira = await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Olá', id_externo: 'wa:9821',
  });
  const reentrega = await repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'Olá', id_externo: 'wa:9821',
  });

  assert.equal(primeira.duplicada, false);
  assert.equal(reentrega.duplicada, true);
  assert.equal(reentrega.mensagem.id, primeira.mensagem.id);
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 1);
});

test('a thread sai em ordem cronológica e pode omitir notas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'primeira' });
  await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'nota', privada: true });
  await repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'segunda' });

  const todas = await repositorio.listarMensagens(conversa.id);
  assert.deepEqual(todas.map((m) => m.conteudo), ['primeira', 'nota', 'segunda']);

  const publicas = await repositorio.listarMensagens(conversa.id, { incluirPrivadas: false });
  assert.deepEqual(publicas.map((m) => m.conteudo), ['primeira', 'segunda']);
});

test('etiquetas desconhecidas são ignoradas em vez de criadas', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  const aplicadas = await repositorio.definirEtiquetasDaConversa(conversa.id, [
    'pagou_sinal', 'etiqueta_que_nao_existe', 'lead_quente',
  ]);

  assert.deepEqual(aplicadas, ['lead_quente', 'pagou_sinal']);
});

test('definir etiquetas substitui o conjunto inteiro', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { conversa } = await comConversa(repositorio);

  await repositorio.definirEtiquetasDaConversa(conversa.id, ['pagou_sinal', 'avaliacao']);
  await repositorio.definirEtiquetasDaConversa(conversa.id, ['em_protocolo']);

  assert.deepEqual(await repositorio.listarEtiquetasDaConversa(conversa.id), ['em_protocolo']);
});

test('a ficha do contato guarda atributos livres', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato } = await comConversa(repositorio);

  await repositorio.atualizarContato(contato.id, {
    email: 'marina@exemplo.com',
    atributos: { convenio: 'particular', indicado_por: 'Instagram' },
  });

  const atualizado = await repositorio.obterContato(contato.id);
  assert.equal(atualizado.email, 'marina@exemplo.com');
  assert.equal(atualizado.atributos.convenio, 'particular');
});

test('campos fora da lista permitida são ignorados na atualização', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato } = await comConversa(repositorio);

  await repositorio.atualizarContato(contato.id, { id: 999, criado_em: '1900-01-01' });
  const atualizado = await repositorio.obterContato(contato.id);

  assert.equal(atualizado.id, contato.id, 'o identificador não pode ser reescrito');
});

test('o lead guarda o vínculo com a conversa que o originou', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato, conversa } = await comConversa(repositorio);

  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id, temperatura: 'quente' });

  assert.equal(lead.conversa_id, conversa.id, 'é o que faz o card do kanban abrir a conversa certa');
  assert.equal(lead.temperatura, 'quente');
});

test('salvar lead duas vezes atualiza em vez de duplicar', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato, conversa } = await comConversa(repositorio);

  await repositorio.salvarLead(contato.id, { conversaId: conversa.id, temperatura: 'frio' });
  await repositorio.salvarLead(contato.id, { temperatura: 'quente', estagio: 'agendado' });

  const leads = await repositorio.listarLeads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].temperatura, 'quente');
  assert.equal(leads[0].estagio, 'agendado');
  assert.equal(leads[0].conversa_id, conversa.id, 'o vínculo não se perde na atualização');
});

test('a busca encontra por nome e por telefone', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comConversa(repositorio, { telefone: '5516999999999', nome: 'Marina Souza' });
  await comConversa(repositorio, { telefone: '5516988887777', nome: 'João Lima' });

  assert.equal((await repositorio.listarConversas({ busca: 'marina' })).length, 1);
  assert.equal((await repositorio.listarConversas({ busca: '98888' })).length, 1);
  assert.equal((await repositorio.listarConversas({})).length, 2);
});

test('a lista traz as conversas mais recentes primeiro', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const primeira = await comConversa(repositorio, { telefone: '5516999999999', nome: 'Marina' });
  const segunda = await comConversa(repositorio, { telefone: '5516988887777', nome: 'João' });

  await repositorio.registrarMensagem(primeira.conversa.id, { direcao: 'entrada', conteudo: 'antiga' });
  await new Promise((resolver) => setTimeout(resolver, 5));
  await repositorio.registrarMensagem(segunda.conversa.id, { direcao: 'entrada', conteudo: 'recente' });

  const lista = await repositorio.listarConversas({});
  assert.equal(lista[0].id, segunda.conversa.id);
});

test('o registro de evento é idempotente e sobrevive à corrida', async () => {
  const repositorio = criarRepositorioEmMemoria();

  assert.equal(await repositorio.consultarEvento('chave-a'), null);
  await repositorio.registrarEvento('chave-a', { ordem: 'primeiro' });
  const segundo = await repositorio.registrarEvento('chave-a', { ordem: 'segundo' });

  assert.deepEqual(segundo, { ordem: 'primeiro' }, 'o primeiro recibo é o que vale');
  assert.deepEqual(await repositorio.consultarEvento('chave-a'), { ordem: 'primeiro' });
});

test('notas ficam na ficha do contato, da mais recente para a mais antiga', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const { contato } = await comConversa(repositorio);

  await repositorio.criarNota(contato.id, 'primeira nota');
  await new Promise((resolver) => setTimeout(resolver, 5));
  await repositorio.criarNota(contato.id, 'segunda nota');

  const notas = await repositorio.listarNotas(contato.id);
  assert.equal(notas.length, 2);
  assert.equal(notas[0].texto, 'segunda nota');
});
