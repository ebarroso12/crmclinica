'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarMotorDeAgentes } = require('../src/dominio/agentes/motor');
const { validarAgente } = require('../src/dominio/agentes/regras');
const { criarNumerosInternosDoCadastro } = require('../src/dominio/numeros-internos');

// Resumo por equipe (docs/RESUMOS.md): o resumo vai para o WhatsApp autorizado
// de cada pessoa. A resposta dela — e o eco do próprio resumo, que a Evolution
// devolve como `fromMe` — chegam pelos webhooks como qualquer mensagem. Antes,
// só a lista do ambiente protegia isso, e só no caminho da clínica.
//
// Repositório em memória REAL, atendimento REAL, motor de agentes REAL; só a IA,
// o canal e a Serena são dublês.

const FUNCIONARIA = '5516991230047';
const CLIENTE = '5516988887777';

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const envios = [];
  const chamadasDeIA = [];
  const despachosDaSerena = [];

  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: {
      disponivel: true,
      async despacharEvento(evento) { despachosDaSerena.push(evento); return { resposta: 'Aqui é a Serena, da clínica.' }; },
    },
    canal: {
      disponivel: true,
      async enviar(argumentos) { envios.push(argumentos); return { identificador: `wamid-${envios.length}` }; },
    },
    agentes: criarMotorDeAgentes({
      gateway: {
        async gerar(argumentos) {
          chamadasDeIA.push(argumentos);
          return { resposta: JSON.stringify({ resposta: 'Temos sim! AHU!', transferir_para_humano: false, motivo: '' }), provedor: 't', modelo: 't' };
        },
        async catalogo() { return []; },
      },
    }),
  });

  const alpins = await repositorio.criarAgente(validarAgente({
    slug: 'alpins', nome: 'Agente Alpins', status: 'ativo', finalidade: 'vendas',
    comportamento: 'Você é o Agente Alpins.', configuracoes: { tempo_resposta_segundos: 10 },
  }), { usuarioId: null });
  await repositorio.definirCanaisDoAgente(alpins.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }]);

  // Funcionária da loja: na equipe do Alpins, WhatsApp autorizado — recebe os resumos do agente.
  const funcionaria = await repositorio.criarUsuario({ nome: 'Funcionária Loja', email: 'funcionaria@teste.local', papel: 'atendente', situacao: 'ativo' });
  await repositorio.atualizarUsuario(funcionaria.id, {
    acessoClinica: false, whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: '991230047', whatsappParticularAutorizado: true,
  });
  await repositorio.adicionarMembroDaEquipe(alpins.id, funcionaria.id);

  return { repositorio, atendimento, envios, chamadasDeIA, despachosDaSerena };
}

function evento(remetente, { instancia = null, id = 'A1', texto = 'ok, recebi o resumo' } = {}) {
  return {
    tipo: 'mensagem.recebida', canal: 'whatsapp', remetente, nome: 'Quem escreveu', texto,
    id_externo: `whatsapp:${remetente}:${id}`, estrategia_ia: 'crm_despacha', instancia,
  };
}

async function nadaGravado(repositorio, digitos) {
  assert.deepEqual(await repositorio.listarConversas({}), [], 'nenhuma conversa');
  assert.deepEqual(await repositorio.buscarContatos({ termo: digitos }), [], 'nenhum contato');
}

test('quem recebe resumo respondendo ao número da CLÍNICA não vira contato, conversa nem despacho da Serena', async () => {
  const { repositorio, atendimento, despachosDaSerena } = await montar();

  const resultado = await atendimento.receberMensagem(evento(FUNCIONARIA));

  assert.equal(resultado.acao, 'mensagem_interna_ignorada');
  assert.equal(resultado.conversa_id, null);
  assert.equal(despachosDaSerena.length, 0);
  await nadaGravado(repositorio, '991230047');
});

test('funcionária escrevendo ao número do ALPINS não é atendida pelo agente — e o cliente continua sendo', async () => {
  const { repositorio, atendimento, envios, chamadasDeIA } = await montar();

  const daFuncionaria = await atendimento.receberMensagem(evento(FUNCIONARIA, { instancia: 'alpins' }));
  assert.equal(daFuncionaria.acao, 'mensagem_interna_ignorada');
  assert.equal(envios.length, 0, 'o agente não responde');
  assert.equal(chamadasDeIA.length, 0, 'nem chama a IA');
  await nadaGravado(repositorio, '991230047');

  const doCliente = await atendimento.receberMensagem(evento(CLIENTE, { instancia: 'alpins', id: 'C1', texto: 'tem o 42?' }));
  assert.equal(doCliente.acao, 'respondida_pela_automacao', 'cliente de verdade segue atendido');
  assert.equal(envios.length, 1);
  assert.equal(envios[0].instancia, 'alpins');
});

test('eco do resumo pelo número da clínica (fromMe) não cria contato nem conversa', async () => {
  const { repositorio, atendimento } = await montar();

  const resultado = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: FUNCIONARIA, texto: 'RESUMO DA CLÍNICA — 2 atendimento(s)', idProvedor: `whatsapp:${FUNCIONARIA}:ECO1`,
  });

  assert.equal(resultado.acao, 'eco_interno_ignorado');
  assert.equal(resultado.conversa_id, null);
  await nadaGravado(repositorio, '991230047');
});

test('eco do resumo pelo número do agente também não', async () => {
  const { repositorio, atendimento } = await montar();

  const resultado = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: FUNCIONARIA, texto: 'RESUMO — Agente Alpins', idProvedor: `whatsapp:${FUNCIONARIA}:ECO2`, instancia: 'alpins',
  });

  assert.equal(resultado.acao, 'eco_interno_ignorado');
  await nadaGravado(repositorio, '991230047');
});

test('o mesmo número sem o nono dígito continua sendo da equipe', async () => {
  const { repositorio, atendimento } = await montar();
  const resultado = await atendimento.receberMensagem(evento('551691230047', { instancia: 'alpins' }));
  assert.equal(resultado.acao, 'mensagem_interna_ignorada');
  await nadaGravado(repositorio, '91230047');
});

test('número do cadastro comparado em E.164: cliente de outro DDD com o mesmo final é atendido (auditoria B2)', async () => {
  // Auditoria de 7f8275b (B2): o sufixo de 8 dígitos tratava 551191230047
  // (cliente de SP) como a funcionária 5516991230047 (Franca).
  const { repositorio, atendimento, envios } = await montar();

  const doCliente = await atendimento.receberMensagem(evento('551191230047', { instancia: 'alpins', id: 'B2', texto: 'tem o 42?' }));
  assert.equal(doCliente.acao, 'respondida_pela_automacao', 'o cliente de outro DDD não é confundido com a funcionária');
  assert.equal(envios.length, 1);
  assert.equal((await repositorio.buscarContatos({ termo: '91230047' })).length, 1, 'o contato do cliente existe');

  const semNonoDigito = await atendimento.receberMensagem(evento('551691230047', { instancia: 'alpins', id: 'B2-f', texto: 'ok' }));
  assert.equal(semNonoDigito.acao, 'mensagem_interna_ignorada', 'a funcionária, sem o nono dígito, continua interna');
});

test('forma de comparação: cadastro em E.164 com o nono dígito; lista antiga do ambiente mantém o sufixo (auditoria B2)', () => {
  const { criarNumerosInternos } = require('../src/dominio/numeros-internos');
  const doCadastro = criarNumerosInternos(['+5516991230047'], { porSufixo: false });
  assert.equal(doCadastro.ehInterno('5516991230047'), true);
  assert.equal(doCadastro.ehInterno('551691230047'), true, 'sem o nono dígito');
  assert.equal(doCadastro.ehInterno('16991230047'), true, 'sem o 55');
  assert.equal(doCadastro.ehInterno('551191230047'), false, 'outro DDD, mesmo final');
  assert.equal(doCadastro.ehInterno('5511991230047'), false);

  const doAmbiente = criarNumerosInternos(['+5516991230047']);
  assert.equal(doAmbiente.ehInterno('551691230047'), true);
  assert.equal(doAmbiente.ehInterno('551191230047'), true, 'a lista do ambiente segue a regra antiga, sem mudança');
});

test('WhatsApp cadastrado SEM autorização não é número interno: sem consentimento, o sistema não usa nem filtra', async () => {
  const { repositorio, atendimento } = await montar();
  const semAutorizacao = await repositorio.criarUsuario({ nome: 'Sem Autorização', email: 'sem-autorizacao@teste.local', papel: 'gestor', situacao: 'ativo' });
  await repositorio.atualizarUsuario(semAutorizacao.id, { whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: '997770001' });

  const resultado = await atendimento.receberMensagem(evento('5516997770001', { texto: 'oi, quero marcar' }));

  assert.notEqual(resultado.acao, 'mensagem_interna_ignorada');
  assert.equal((await repositorio.listarConversas({})).length, 1);
});

test('cache velho + autorização recente: eco e número novo conferem no banco antes de criar contato; contato existente não relê (auditoria M1)', async () => {
  // Auditoria de 7f8275b (M1): o cache de 60 s valia também para o NÃO. Autorizar
  // o WhatsApp e o resumo sair no minuto seguinte deixava uma instância quente
  // criar contato com o texto do resumo.
  const { repositorio, atendimento } = await montar();
  let leituras = 0;
  const lerOriginal = repositorio.listarDestinatariosDeResumo.bind(repositorio);
  repositorio.listarDestinatariosDeResumo = async () => { leituras += 1; return lerOriginal(); };

  // Aquece o cache: um cliente escreve, o cadastro é lido (sem a pessoa nova).
  await atendimento.receberMensagem(evento(CLIENTE, { id: 'C1', texto: 'oi, quero marcar' }));

  const recente = await repositorio.criarUsuario({ nome: 'Recém Autorizada', email: 'recem@teste.local', papel: 'gestor', situacao: 'ativo' });
  await repositorio.atualizarUsuario(recente.id, {
    whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: '997770002', whatsappParticularAutorizado: true,
  });

  const eco = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: '5516997770002', texto: 'RESUMO DA CLÍNICA — 1 atendimento(s)', idProvedor: 'whatsapp:5516997770002:ECO-M1',
  });
  assert.equal(eco.acao, 'eco_interno_ignorado', 'o eco do resumo não vira contato com o cache velho');
  const resposta = await atendimento.receberMensagem(evento('5516997770002', { id: 'R-M1', texto: 'ok, obrigada' }));
  assert.equal(resposta.acao, 'mensagem_interna_ignorada', 'a resposta dela também não');
  assert.deepEqual(await repositorio.buscarContatos({ termo: '997770002' }), [], 'nenhum contato criado');

  // Contato que já existe: sem leitura extra do cadastro dentro da validade.
  const antes = leituras;
  await atendimento.receberMensagem(evento(CLIENTE, { id: 'C2', texto: 'e sábado?' }));
  assert.equal(leituras, antes, 'contato existente não pesa o webhook');
});

test('o cadastro é lido no máximo uma vez por minuto, e falha de banco mantém a última lista', async () => {
  let leituras = 0;
  let quebrado = false;
  let instante = 0;
  const repositorio = {
    async listarDestinatariosDeResumo() {
      leituras += 1;
      if (quebrado) throw new Error('banco fora');
      return [{
        id: 1, whatsapp_ddi: '55', whatsapp_ddd: '16', whatsapp_numero: '991230047', whatsapp_particular_autorizado: true,
      }];
    },
  };
  const internos = criarNumerosInternosDoCadastro({ repositorio, relogio: () => instante });

  assert.equal(await internos.ehInterno(FUNCIONARIA), true);
  assert.equal(await internos.ehInterno(CLIENTE), false);
  assert.equal(leituras, 1, 'duas perguntas no mesmo minuto, uma leitura');

  instante += 61_000;
  quebrado = true;
  assert.equal(await internos.ehInterno(FUNCIONARIA), true, 'banco fora: segue a última lista conhecida');
  assert.equal(leituras, 2);
  assert.equal(await internos.ehInterno(null), false);
});
