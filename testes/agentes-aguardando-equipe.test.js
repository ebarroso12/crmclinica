'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarFluxoDeAgentes } = require('../src/dominio/agentes/fluxo');
const { validarAgente, normalizarConfiguracoes } = require('../src/dominio/agentes/regras');

// "Aguardando você" (docs/AGENTES.md, Painel de operação): conversa que o agente
// transferiu fica com `assumida_por_humano = true` e SEM responsável. Achado M1
// da auditoria: quando a equipe respondia, a conversa continuava sem dono — e
// ficava para sempre no painel e no selo do menu, porque `responderComoEquipe`
// só assumia conversa que ainda NÃO estava assumida.
//
// Prova, no repositório em memória (o SQL do PostgreSQL é o mesmo recorte, com
// teste de contrato próprio): transferir → equipe responde → sai do recorte. E
// que a conversa da clínica segue exatamente como antes (bca39e9).

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({ repositorio });
  const fluxo = criarFluxoDeAgentes({
    repositorio,
    entregar: async () => ({ enviada: true }),
    escalonar: async () => {},
  });

  const criado = await repositorio.criarAgente(validarAgente({ slug: 'alpins', nome: 'Agente Alpins' }), { usuarioId: null });
  await repositorio.atualizarAgente(criado.id, { status: 'ativo' });
  const agente = await repositorio.obterAgente(criado.id);
  const atendente = await repositorio.criarUsuario({
    nome: 'Atendente da Loja', email: 'atendente-loja@teste.local', senhaHash: 'x', papel: 'atendente', situacao: 'ativo',
  });
  return { repositorio, atendimento, fluxo, agente, atendente };
}

async function conversaTransferida({ repositorio, fluxo, agente }, telefone) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome: 'Cliente Pediu Gente' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId: agente.id });
  await repositorio.registrarMensagem(conversa.id, { direcao: 'entrada', conteudo: 'quero falar com uma pessoa', autor_tipo: 'contato' });
  const transferiu = await fluxo.transferir(conversa, agente, normalizarConfiguracoes({ resumo_ao_transferir: false }), 'pedido_do_agente');
  assert.equal(transferiu, true);
  return repositorio.obterConversa(conversa.id);
}

test('transferida pelo agente → equipe responde → sai de "Aguardando você" e do selo, com dono e auditoria de agente', async () => {
  const ambiente = await montar();
  const { repositorio, atendimento, agente, atendente } = ambiente;
  const conversa = await conversaTransferida(ambiente, '5516900004001');

  assert.equal(conversa.assumida_por_humano, true);
  assert.equal(conversa.atribuido_a, null);
  assert.deepEqual((await repositorio.listarConversasDoAgenteAguardandoEquipe(agente.id)).map((item) => item.id), [conversa.id]);

  await atendimento.responderComoEquipe(conversa.id, 'Oi! Sou da equipe da loja.', {
    usuarioId: atendente.id, autorNome: atendente.nome,
  });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.atribuido_a, atendente.id, 'quem respondeu virou o responsável');
  assert.equal(depois.assumida_por_humano, true);
  assert.deepEqual(await repositorio.listarConversasDoAgenteAguardandoEquipe(agente.id), [], 'saiu de "Aguardando você"');
  assert.ok(!(await repositorio.contarConversasAguardandoEquipePorAgente()).some((item) => item.agente_id === agente.id),
    'saiu da contagem do selo');

  const auditoria = await repositorio.listarAuditoria({ entidade: 'conversa', acao: 'agente_assumida_por_humano' });
  assert.equal(auditoria.itens.length, 1, 'a tomada de posse audita com o nome de agente');
  assert.equal((await repositorio.listarAuditoria({ entidade: 'conversa', acao: 'assumida_por_humano' })).itens.length, 0,
    'nada entra nas métricas de handoff da Serena');

  // Responder de novo não repete o aviso nem a auditoria.
  await atendimento.responderComoEquipe(conversa.id, 'Mais uma coisa.', { usuarioId: atendente.id, autorNome: atendente.nome });
  assert.equal((await repositorio.listarAuditoria({ entidade: 'conversa', acao: 'agente_assumida_por_humano' })).itens.length, 1);
});

test('nota interna numa conversa de agente transferida não assume nem tira da espera', async () => {
  const ambiente = await montar();
  const { repositorio, atendimento, agente, atendente } = ambiente;
  const conversa = await conversaTransferida(ambiente, '5516900004002');

  await atendimento.responderComoEquipe(conversa.id, 'anotação da equipe', { usuarioId: atendente.id, privada: true });
  assert.equal((await repositorio.obterConversa(conversa.id)).atribuido_a, null);
  assert.equal((await repositorio.listarConversasDoAgenteAguardandoEquipe(agente.id)).length, 1);
});

test('clínica inalterada: conversa sem agente, já assumida sem responsável, continua sem responsável ao responder (como em bca39e9)', async () => {
  const { repositorio, atendimento, atendente } = await montar();
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900004003', nome: 'Paciente' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  await repositorio.atualizarConversa(conversa.id, { assumida_por_humano: true, atribuido_a: null });

  await atendimento.responderComoEquipe(conversa.id, 'Olá, aqui é a clínica.', { usuarioId: atendente.id, autorNome: atendente.nome });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.atribuido_a, null, 'na clínica, responder não muda o dono de conversa já assumida');
  assert.equal(depois.assumida_por_humano, true);
  assert.equal((await repositorio.listarAuditoria({ entidade: 'conversa', acao: 'assumida_por_humano' })).itens.length, 0);
  assert.deepEqual(await repositorio.listarConversasEscalonadasSemDono(), [conversa.id],
    'continua liberável em massa, como antes');
});

test('clínica inalterada: conversa sem agente e não assumida é assumida por quem responde, como antes', async () => {
  const { repositorio, atendimento, atendente } = await montar();
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516900004004', nome: 'Paciente Novo' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

  await atendimento.responderComoEquipe(conversa.id, 'Bom dia!', { usuarioId: atendente.id, autorNome: atendente.nome });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true);
  assert.equal(depois.atribuido_a, atendente.id);
  assert.equal((await repositorio.listarAuditoria({ entidade: 'conversa', acao: 'assumida_por_humano' })).itens.length, 1);
});
