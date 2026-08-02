'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  criarClienteChatwoot,
  webhookAutentico,
  normalizarConversa,
  normalizarMensagem,
} = require('../src/integracoes/chatwoot');
const { ETIQUETAS_TEMPERATURA } = require('../src/dominio/conversas');

// Configuração sintética: nenhum token real, nenhuma requisição de rede.
const CONFIGURACAO = Object.freeze({
  baseUrl: 'https://chatwoot.invalido',
  contaId: '1',
  token: 'token-sintetico-de-teste',
  inboxId: '3',
  timeId: '2',
  tempoLimiteMs: 1000,
});

function fetchFalso(respostas = {}) {
  const chamadas = [];
  const fake = async (url, opcoes) => {
    chamadas.push({ url, opcoes, corpo: opcoes?.body ? JSON.parse(opcoes.body) : null });
    const chave = Object.keys(respostas).find((padrao) => url.includes(padrao));
    const resposta = chave ? respostas[chave] : { ok: true, corpo: {} };
    return {
      ok: resposta.ok !== false,
      status: resposta.status || 200,
      text: async () => JSON.stringify(resposta.corpo ?? {}),
    };
  };
  fake.chamadas = chamadas;
  return fake;
}

test('sem base, conta ou token o cliente se declara indisponível', () => {
  assert.equal(criarClienteChatwoot({}).disponivel, false);
  assert.equal(criarClienteChatwoot({ baseUrl: 'https://x', contaId: '1' }).disponivel, false);
  assert.equal(criarClienteChatwoot({ baseUrl: 'https://x', token: 't' }).disponivel, false);
  assert.equal(criarClienteChatwoot(CONFIGURACAO).disponivel, true);
});

test('cliente indisponível recusa a operação sem tocar a rede', async () => {
  const fetch = fetchFalso();
  const cliente = criarClienteChatwoot({}, { fetch });

  await assert.rejects(
    () => cliente.listarConversas({ fila: 'todos' }),
    (erro) => erro.codigo === 'chatwoot_nao_configurado',
  );
  assert.equal(fetch.chamadas.length, 0);
});

test('lista conversas da fila usando a API oficial da conta', async () => {
  const fetch = fetchFalso({
    '/conversations?': {
      corpo: {
        data: {
          meta: { all_count: 2 },
          payload: [
            {
              id: 4678,
              status: 'open',
              priority: 'high',
              labels: ['avaliacao'],
              inbox_id: 3,
              last_activity_at: 1_785_000_000,
              meta: {
                sender: { id: 55, name: 'Marina Souza', phone_number: '+5516999999999' },
                assignee: { id: 7, name: 'Recepção' },
              },
            },
          ],
        },
      },
    },
  });

  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });
  const resultado = await cliente.listarConversas({ fila: 'nao_atribuidas' });

  const [chamada] = fetch.chamadas;
  assert.ok(chamada.url.startsWith('https://chatwoot.invalido/api/v1/accounts/1/conversations'));
  assert.ok(chamada.url.includes('assignee_type=unassigned'));
  assert.ok(chamada.url.includes('inbox_id=3'), 'deve filtrar pelo canal configurado');
  assert.equal(chamada.opcoes.headers.api_access_token, 'token-sintetico-de-teste');

  assert.equal(resultado.rotulo, 'Não atribuídas');
  assert.equal(resultado.total, 2);
  assert.equal(resultado.conversas[0].id, 4678);
  assert.equal(resultado.conversas[0].contato.nome, 'Marina Souza');
  assert.equal(resultado.conversas[0].responsavel.nome, 'Recepção');
});

test('fila desconhecida é recusada antes da requisição', async () => {
  const fetch = fetchFalso();
  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });

  await assert.rejects(() => cliente.listarConversas({ fila: 'inventada' }), /fila desconhecida/);
  assert.equal(fetch.chamadas.length, 0);
});

test('responder envia mensagem de saída para a conversa', async () => {
  const fetch = fetchFalso({ '/messages': { corpo: { id: 9, content: 'Olá', message_type: 1 } } });
  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });

  const mensagem = await cliente.responder(4678, 'Olá');

  assert.equal(fetch.chamadas[0].opcoes.method, 'POST');
  assert.deepEqual(fetch.chamadas[0].corpo, { content: 'Olá', message_type: 'outgoing', private: false });
  assert.equal(mensagem.autor, 'equipe');
});

test('nota interna é marcada como privada', async () => {
  const fetch = fetchFalso({ '/messages': { corpo: { id: 10, content: 'nota', private: true } } });
  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });

  await cliente.responder(4678, 'nota', { privada: true });
  assert.equal(fetch.chamadas[0].corpo.private, true);
});

test('ações da equipe usam os endpoints oficiais', async () => {
  const fetch = fetchFalso();
  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });

  await cliente.atribuirAgente(4678, 7);
  await cliente.atribuirTime(4678);
  await cliente.definirPrioridade(4678, 'urgent');
  await cliente.definirEstado(4678, 'resolved');
  await cliente.definirEstado(4678, 'open');

  const urls = fetch.chamadas.map((chamada) => chamada.url.replace('https://chatwoot.invalido/api/v1/accounts/1', ''));
  assert.deepEqual(urls, [
    '/conversations/4678/assignments',
    '/conversations/4678/assignments',
    '/conversations/4678/toggle_priority',
    '/conversations/4678/toggle_status',
    '/conversations/4678/toggle_status',
  ]);

  assert.deepEqual(fetch.chamadas[0].corpo, { assignee_id: 7 });
  assert.deepEqual(fetch.chamadas[1].corpo, { team_id: '2' }, 'usa o time configurado por padrão');
  assert.deepEqual(fetch.chamadas[2].corpo, { priority: 'urgent' });
  assert.deepEqual(fetch.chamadas[3].corpo, { status: 'resolved' });
  assert.deepEqual(fetch.chamadas[4].corpo, { status: 'open' }, 'reabrir é voltar para open');
});

test('garantirEtiquetasDeTemperatura cria só o que falta e preserva o resto', async () => {
  const existentes = ['avaliacao', 'positiva', 'negativa', 'atendimento_humano', 'lead_quente'];
  const fetch = fetchFalso({
    '/labels': { corpo: { payload: existentes.map((title) => ({ title })) } },
  });

  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });
  const resultado = await cliente.garantirEtiquetasDeTemperatura();

  assert.deepEqual(resultado.criadas, ['lead_morno', 'lead_frio']);
  assert.deepEqual(resultado.preservadas, existentes);

  // Nenhuma chamada apaga etiqueta: só GET de listagem e POST de criação.
  const metodos = fetch.chamadas.map((chamada) => chamada.opcoes.method || 'GET');
  assert.ok(!metodos.includes('DELETE'));
  assert.equal(metodos.filter((metodo) => metodo === 'POST').length, 2);
});

test('as três etiquetas de temperatura são exatamente as esperadas', () => {
  assert.deepEqual(ETIQUETAS_TEMPERATURA, ['lead_quente', 'lead_morno', 'lead_frio']);
});

test('erro HTTP do Chatwoot vira erro identificável', async () => {
  const fetch = fetchFalso({ '/conversations': { ok: false, status: 403 } });
  const cliente = criarClienteChatwoot(CONFIGURACAO, { fetch });

  await assert.rejects(
    () => cliente.obterConversa(4678),
    (erro) => erro.codigo === 'chatwoot_resposta_invalida' && erro.status === 403,
  );
});

test('verificarSaude traduz os estados sem derrubar o CRM', async () => {
  assert.deepEqual(await criarClienteChatwoot({}).verificarSaude(), { estado: 'nao_configurado' });

  const saudavel = criarClienteChatwoot(CONFIGURACAO, { fetch: fetchFalso({ '/labels': { corpo: { payload: [] } } }) });
  assert.deepEqual(await saudavel.verificarSaude(), { estado: 'operacional' });

  const degradado = criarClienteChatwoot(CONFIGURACAO, { fetch: fetchFalso({ '/labels': { ok: false, status: 500 } }) });
  assert.deepEqual(await degradado.verificarSaude(), { estado: 'degradado' });

  const foraDoAr = criarClienteChatwoot(CONFIGURACAO, {
    fetch: async () => { throw new Error('conexão recusada'); },
  });
  assert.deepEqual(await foraDoAr.verificarSaude(), { estado: 'indisponivel' });
});

test('normalização traduz o formato do Chatwoot para o do CRM', () => {
  const conversa = normalizarConversa({
    id: 1,
    status: 'pending',
    priority: 'low',
    labels: ['positiva'],
    meta: { sender: { id: 2, name: 'Ana', phone_number: '+5516988887777', identifier: 'wa:2' } },
  });

  assert.equal(conversa.estado, 'pending');
  assert.equal(conversa.contato.telefone, '+5516988887777');
  assert.equal(conversa.contato.identificador, 'wa:2');

  assert.equal(normalizarMensagem({ message_type: 0 }).autor, 'contato');
  assert.equal(normalizarMensagem({ message_type: 1 }).autor, 'equipe');
  assert.equal(normalizarMensagem({ message_type: 2 }).autor, 'sistema');
});

test('autenticidade do webhook: HMAC correto passa, o resto não', () => {
  const segredo = 'segredo-sintetico-de-webhook-do-chatwoot';
  const corpo = '{"event":"message_created"}';
  const assinatura = crypto.createHmac('sha256', segredo).update(corpo).digest('hex');

  assert.equal(webhookAutentico({ corpoBruto: corpo, assinaturaRecebida: assinatura, segredo }), true);
  assert.equal(webhookAutentico({ corpoBruto: corpo, assinaturaRecebida: `sha256=${assinatura}`, segredo }), true);

  assert.equal(webhookAutentico({ corpoBruto: corpo, assinaturaRecebida: assinatura, segredo: 'outro' }), false);
  assert.equal(webhookAutentico({ corpoBruto: '{"event":"outro"}', assinaturaRecebida: assinatura, segredo }), false);
  assert.equal(webhookAutentico({ corpoBruto: corpo, segredo }), false, 'sem prova nenhuma deve recusar');
  assert.equal(webhookAutentico({ corpoBruto: corpo, tokenRecebido: segredo, segredo: '' }), false);
});

test('autenticidade do webhook aceita token compartilhado exato', () => {
  const segredo = 'segredo-sintetico-de-webhook-do-chatwoot';

  assert.equal(webhookAutentico({ corpoBruto: '{}', tokenRecebido: segredo, segredo }), true);
  assert.equal(webhookAutentico({ corpoBruto: '{}', tokenRecebido: 'errado', segredo }), false);
  assert.equal(webhookAutentico({ corpoBruto: '{}', tokenRecebido: `${segredo}x`, segredo }), false);
});
