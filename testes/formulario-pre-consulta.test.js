'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarServicoDeFluxo } = require('../src/dominio/crm-fluxo');
const {
  URL_FORMULARIO_PRE_CONSULTA,
  linkDoFormularioPreConsulta,
  mensagemDeFormularioPreConsulta,
} = require('../src/dominio/formulario-pre-consulta');

// Provas de que existe UM formulário de pré-consulta, e um só.
//
// O defeito que estes testes existem para impedir: paciente adulto recebendo
// questionário infantil. A defesa é estrutural — não há caminho no código que
// escolha link por idade, faixa etária ou tipo de consulta — e estes testes
// fecham a porta por comportamento, situação por situação.

const OFICIAL = 'https://formulario.edsonbarrosojr.com.br/';

// ------------------------------------------------------------------ o módulo

test('a URL canônica é exatamente a oficial, sem caminho adicional', () => {
  assert.equal(URL_FORMULARIO_PRE_CONSULTA, OFICIAL);
  assert.equal(linkDoFormularioPreConsulta(), OFICIAL);
});

test('o link não muda para nenhuma situação de paciente', () => {
  // Adulto, adolescente, criança, primeira consulta, retorno: a função não
  // aceita nada disso — e é esse o ponto. Mesmo forçando os argumentos, o
  // resultado é sempre o mesmo endereço.
  const situacoes = [
    undefined,
    {},
    { idade: 8 },
    { idade: 15 },
    { idade: 42 },
    { faixa: 'infantil' },
    { faixa: 'adulto' },
    { tipo: 'primeira_consulta' },
    { tipo: 'retorno' },
    { crianca: true },
    { menorDeIdade: true },
  ];

  for (const situacao of situacoes) {
    assert.equal(
      linkDoFormularioPreConsulta(situacao), OFICIAL,
      `situação ${JSON.stringify(situacao)} não pode mudar o link`,
    );
  }
});

test('a mensagem carrega o link oficial e nenhum outro, com ou sem nome', () => {
  for (const argumento of [undefined, {}, { nome: null }, { nome: 'Ana' }]) {
    const texto = mensagemDeFormularioPreConsulta(argumento);
    const encontrados = texto.match(/https?:\/\/\S+/g) ?? [];
    assert.deepEqual(encontrados, [OFICIAL], 'a mensagem tem um link, e é o oficial');
  }
});

test('nome do paciente não vaza para dentro do link', () => {
  // Nome hostil: se ele terminasse concatenado na URL, o paciente receberia
  // um endereço que não existe — ou pior, um que existe e não é o nosso.
  const texto = mensagemDeFormularioPreConsulta({ nome: 'Ana https://formulario.exemplo.com/infantil' });
  const encontrados = texto.match(/https?:\/\/\S+/g) ?? [];
  assert.ok(encontrados.includes(OFICIAL), 'o link oficial continua presente');
  assert.equal(
    encontrados.filter((link) => link.startsWith(OFICIAL)).length, 1,
    'nada é anexado ao link oficial',
  );
});

// ------------------------------------------------------- o envio pelo serviço

function ambiente() {
  const relogio = { momento: new Date('2026-08-15T12:00:00.000Z') };
  const agora = () => new Date(relogio.momento);
  return { agora, repositorio: criarRepositorioEmMemoria({ agora }) };
}

async function agendamentoConfirmado(repositorio, { nome, telefone }) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome, canal: 'whatsapp' });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
  const lead = await repositorio.salvarLead(contato.id, { conversaId: conversa.id, origem: 'WHATSAPP' });
  const profissional = await repositorio.criarProfissional({ nome: 'Dr. Sintético' });
  const agendamento = await repositorio.criarAgendamento({
    profissionalId: profissional.id, contatoId: contato.id, leadId: lead.id, conversaId: conversa.id,
    inicio: '2026-08-20T14:00:00.000Z', fim: '2026-08-20T14:30:00.000Z',
  });
  await repositorio.atualizarAgendamento(agendamento.id, { status: 'confirmado' });
  return agendamento;
}

// Cada perfil é uma situação que, num sistema com formulário por idade,
// receberia um link diferente. Aqui todos recebem o mesmo.
const PERFIS = [
  { rotulo: 'adulto, primeira consulta', nome: 'Paciente Adulto', telefone: '5516900000101' },
  { rotulo: 'adulto, retorno', nome: 'Paciente Retorno', telefone: '5516900000102' },
  { rotulo: 'adolescente', nome: 'Paciente Adolescente', telefone: '5516900000103' },
  { rotulo: 'criança', nome: 'Paciente Criança', telefone: '5516900000104' },
  { rotulo: 'contato sem nome', nome: null, telefone: '5516900000105' },
];

for (const perfil of PERFIS) {
  test(`envio pelo CRM manda o link oficial — ${perfil.rotulo}`, async () => {
    const { agora, repositorio } = ambiente();
    const envios = [];
    const canal = { enviar: async (envelope) => { envios.push(envelope); return {}; } };
    const fluxo = criarServicoDeFluxo({ repositorio, canal, agora });

    const agendamento = await agendamentoConfirmado(repositorio, perfil);
    const resultado = await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });

    assert.equal(resultado.entrega.enviada, true);
    assert.equal(envios.length, 1);

    const links = envios[0].texto.match(/https?:\/\/\S+/g) ?? [];
    assert.deepEqual(links, [OFICIAL], `${perfil.rotulo} recebeu link diferente do oficial`);
  });
}

test('reenvio do mesmo formulário repete o link oficial, nunca um alternativo', async () => {
  const { agora, repositorio } = ambiente();
  const envios = [];
  const canal = { enviar: async (envelope) => { envios.push(envelope); return {}; } };
  const fluxo = criarServicoDeFluxo({ repositorio, canal, agora });

  const agendamento = await agendamentoConfirmado(repositorio, { nome: 'Paciente', telefone: '5516900000106' });
  await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });
  await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });

  assert.equal(envios.length, 2);
  const links = new Set(envios.flatMap((envio) => envio.texto.match(/https?:\/\/\S+/g) ?? []));
  assert.deepEqual([...links], [OFICIAL]);
});

test('o envio fica no livro de auditoria, com a URL e sem dado do paciente', async () => {
  const { agora, repositorio } = ambiente();
  const canal = { enviar: async () => ({}) };
  const fluxo = criarServicoDeFluxo({ repositorio, canal, agora });

  const agendamento = await agendamentoConfirmado(repositorio, { nome: 'Paciente Auditado', telefone: '5516900000107' });
  await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });

  const { itens } = await repositorio.listarAuditoria({ limite: 50 });
  const envio = itens.find((linha) => linha.acao === 'formulario_pre_consulta_enviado');
  assert.ok(envio, 'o envio do formulário é auditado');
  assert.equal(envio.detalhe.url, OFICIAL, 'a auditoria prova qual link saiu');

  // Nada identificável no detalhe: nem telefone, nem nome, nem texto.
  const serializado = JSON.stringify(envio.detalhe);
  assert.ok(!serializado.includes('5516900000107'), 'telefone não entra na auditoria');
  assert.ok(!serializado.includes('Paciente Auditado'), 'nome não entra na auditoria');
});

// -------------------------------------------------------------- caso de borda

test('sem canal configurado, nenhum link alternativo é inventado', async () => {
  const { agora, repositorio } = ambiente();
  const fluxo = criarServicoDeFluxo({ repositorio, agora }); // sem canal

  const agendamento = await agendamentoConfirmado(repositorio, { nome: 'Paciente', telefone: '5516900000108' });
  const resultado = await fluxo.enviarFormularioPreConsulta(agendamento.id, { usuarioId: 3 });

  assert.equal(resultado.entrega.enviada, false);
  assert.equal(resultado.entrega.motivo, 'canal_nao_configurado');
});
