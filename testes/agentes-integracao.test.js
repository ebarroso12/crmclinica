'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarMotorDeAgentes } = require('../src/dominio/agentes/motor');
const { validarAgente } = require('../src/dominio/agentes/regras');

// Integração do atendimento com agentes: repositório em memória REAL, motor
// REAL, atendimento REAL — só o modelo de IA (gateway), o canal de envio e o
// orquestrador da Serena são falsos. Prova que a conversa certa vai para o
// dono certo e sai pelo número certo. NÃO prova o SQL do PostgreSQL, a
// Evolution de verdade nem a qualidade da resposta de um modelo real.

const CLIENTE = '5516991112222';

function montar({ serena = null, instanciasDaClinica = [] } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const chamadasDeIA = [];
  const envios = [];
  const despachosDaSerena = [];
  const auditoria = [];

  // Espião sobre a auditoria real: registra o nome da ação e segue gravando.
  const registrarOriginal = repositorio.registrarAuditoria.bind(repositorio);
  repositorio.registrarAuditoria = async (entrada) => {
    auditoria.push(entrada);
    return registrarOriginal(entrada);
  };

  const gateway = {
    async gerar(argumentos) {
      chamadasDeIA.push(argumentos);
      if (argumentos.finalidade === 'agente_resumo') return { resposta: 'Resumo curto.' };
      return {
        resposta: JSON.stringify({ resposta: 'Temos do 34 ao 44. AHU!', transferir_para_humano: false, motivo: '' }),
        provedor: 'teste',
        modelo: 'teste',
      };
    },
    async catalogo() { return []; },
  };

  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: {
      disponivel: true,
      async despacharEvento(evento) {
        despachosDaSerena.push(evento);
        return { resposta: 'Aqui é a Serena, da clínica.' };
      },
    },
    serena,
    canal: {
      disponivel: true,
      async enviar(argumentos) {
        envios.push(argumentos);
        return { identificador: `wamid-${envios.length}` };
      },
    },
    agentes: criarMotorDeAgentes({ gateway }),
    instanciasDaClinica,
  });

  return { repositorio, atendimento, chamadasDeIA, envios, despachosDaSerena, auditoria };
}

async function criarAlpins(repositorio, { status = 'ativo', canalAtivo = true, configuracoes = {} } = {}) {
  const dados = validarAgente({
    slug: 'alpins',
    nome: 'Agente Alpins',
    status,
    finalidade: 'vendas',
    comportamento: 'Você é o Agente Alpins. Termine com AHU!',
    configuracoes: { tempo_resposta_segundos: 10, ...configuracoes },
  });
  const agente = await repositorio.criarAgente(dados, { usuarioId: null });
  await repositorio.definirCanaisDoAgente(agente.id, [{ canal: 'whatsapp', instancia: 'alpins', ativo: canalAtivo }]);
  await repositorio.criarTreinamento(agente.id, { tipo: 'texto', conteudo: 'Tênis New Story do 34 ao 44.' });
  return repositorio.obterAgente(agente.id);
}

function evento(idNativo, { instancia = null, texto = 'Tem tênis 42?', estrategia = 'crm_despacha' } = {}) {
  return {
    tipo: 'mensagem.recebida',
    canal: 'whatsapp',
    remetente: CLIENTE,
    nome: 'Cliente Teste',
    texto,
    id_externo: `whatsapp:${CLIENTE}:${idNativo}`,
    estrategia_ia: estrategia,
    instancia,
  };
}

test('mensagem para o número do agente: conversa do agente, resposta do motor, envio pela instância do agente', async () => {
  const { repositorio, atendimento, chamadasDeIA, envios, despachosDaSerena, auditoria } = montar();
  const alpins = await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(despachosDaSerena.length, 0, 'a Serena nunca responde conversa de agente');
  assert.equal(chamadasDeIA.length, 1);
  assert.equal(chamadasDeIA[0].finalidade, 'agente_resposta');
  assert.equal(envios.length, 1);
  assert.equal(envios[0].instancia, 'alpins', 'sai pelo número do agente, nunca pelo da clínica');
  assert.equal(envios[0].texto, 'Temos do 34 ao 44. AHU!');

  const conversa = await repositorio.obterConversa(resultado.conversa_id);
  assert.equal(conversa.agente_id, alpins.id);
  assert.equal(conversa.agente_nome, 'Agente Alpins');

  const contato = await repositorio.obterContato(conversa.contato_id);
  assert.equal(await repositorio.obterLeadPorContato(contato.id), null, 'cliente do agente não entra no funil da clínica');

  const acoes = auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('agente_respondida'));
  assert.equal(acoes.includes('respondida_pela_automacao'), false, 'métrica da Serena não conta resposta do agente');
});

test('o mesmo cliente escrevendo para a clínica abre outra conversa, respondida pelo caminho da Serena', async () => {
  const { repositorio, atendimento, envios, despachosDaSerena } = montar();
  await criarAlpins(repositorio);

  const doAgente = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));
  const daClinica = await atendimento.receberMensagem(evento('C1', { texto: 'Quero marcar consulta' }));

  assert.notEqual(doAgente.conversa_id, daClinica.conversa_id);
  assert.equal((await repositorio.obterConversa(daClinica.conversa_id)).agente_id, null);
  assert.equal(despachosDaSerena.length, 1);
  assert.equal(envios.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(envios[1], 'instancia'), false,
    'envio da clínica continua exatamente com a mesma forma de antes');
});

test('instância sem agente dono e SEM lista da clínica configurada segue o caminho da clínica, como antes', async () => {
  const { repositorio, atendimento, despachosDaSerena, envios } = montar();
  await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('X1', { instancia: 'clinica-nome-diferente' }));

  assert.equal((await repositorio.obterConversa(resultado.conversa_id)).agente_id, null);
  assert.equal(despachosDaSerena.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(envios[0], 'instancia'), false);
});

test('achado MÉDIO 4: com a lista da clínica configurada, instância sem dono grava e escala — ninguém responde', async () => {
  const { repositorio, atendimento, despachosDaSerena, envios, chamadasDeIA, auditoria } = montar({
    instanciasDaClinica: ['clinica'],
  });
  await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('X1', { instancia: 'loja-sem-cadastro' }));

  assert.equal(resultado.acao, 'instancia_sem_agente');
  assert.equal(despachosDaSerena.length, 0, 'a Serena não responde pelo número da clínica');
  assert.equal(chamadasDeIA.length, 0);
  assert.equal(envios.length, 0);
  const mensagens = await repositorio.listarMensagens(resultado.conversa_id);
  assert.ok(mensagens.some((item) => item.direcao === 'entrada'), 'a mensagem do cliente não se perde');
  const semDono = auditoria.find((item) => item.acao === 'instancia_sem_dono');
  assert.deepEqual(semDono.detalhe, { canal: 'whatsapp', instancia: 'loja-sem-cadastro' });
});

test('com a lista configurada, a instância da clínica (sem diferenciar maiúsculas) continua com a Serena', async () => {
  const { repositorio, atendimento, despachosDaSerena } = montar({ instanciasDaClinica: ['clinica'] });
  await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('C1', { instancia: 'CLINICA', texto: 'Oi clínica' }));

  assert.equal((await repositorio.obterConversa(resultado.conversa_id)).agente_id, null);
  assert.equal(despachosDaSerena.length, 1);
});

test('nome da instância do agente com maiúscula diferente continua sendo do agente', async () => {
  const { repositorio, atendimento, envios, despachosDaSerena } = montar();
  const alpins = await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('A1', { instancia: 'Alpins' }));

  assert.equal((await repositorio.obterConversa(resultado.conversa_id)).agente_id, alpins.id);
  assert.equal(despachosDaSerena.length, 0);
  assert.equal(envios[0].instancia, 'alpins', 'o envio usa o nome cadastrado');
});

test('evento de importação ("o agente do canal já respondeu") nunca vira resposta de agente', async () => {
  const { repositorio, atendimento, chamadasDeIA, envios } = montar();
  await criarAlpins(repositorio);

  const resultado = await atendimento.receberMensagem(evento('I1', { instancia: 'alpins', estrategia: 'openclaw_gerencia' }));

  assert.equal(resultado.acao, 'importada_do_canal');
  assert.equal((await repositorio.obterConversa(resultado.conversa_id)).agente_id, null);
  assert.equal(chamadasDeIA.length, 0);
  assert.equal(envios.length, 0);
});

test('Serena desligada não cala o agente — e continua calando a clínica', async () => {
  const serena = { async podeResponder() { return { responder: false, motivo: 'serena_desligada', escopo: 'global' }; } };
  const { repositorio, atendimento, envios, despachosDaSerena } = montar({ serena });
  await criarAlpins(repositorio);

  const doAgente = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));
  const daClinica = await atendimento.receberMensagem(evento('C1', { texto: 'Oi clínica' }));

  assert.equal(doAgente.acao, 'respondida_pela_automacao');
  assert.equal(daClinica.acao, 'aguardando_equipe');
  assert.equal(despachosDaSerena.length, 0);
  assert.deepEqual(envios.map((envio) => envio.instancia), ['alpins']);
});

test('agente desativado grava a mensagem e não gera nem envia nada', async () => {
  const { repositorio, atendimento, chamadasDeIA, envios } = montar();
  await criarAlpins(repositorio, { status: 'desativado' });

  const resultado = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'agente_desativado');
  assert.equal(chamadasDeIA.length, 0);
  assert.equal(envios.length, 0);
  const mensagens = await repositorio.listarMensagens(resultado.conversa_id);
  assert.ok(mensagens.some((item) => item.direcao === 'entrada' && item.conteudo === 'Tem tênis 42?'));
});

test('canal do agente desligado: a conversa continua do agente e nada sai por número nenhum', async () => {
  const { repositorio, atendimento, envios, despachosDaSerena, auditoria } = montar();
  const alpins = await criarAlpins(repositorio, { canalAtivo: false });

  const resultado = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  assert.equal((await repositorio.obterConversa(resultado.conversa_id)).agente_id, alpins.id);
  assert.equal(despachosDaSerena.length, 0, 'não cai na Serena só porque o canal está desligado');
  assert.equal(envios.length, 0, 'não sai pela instância padrão (número da clínica)');
  assert.equal(resultado.entregue, false);
  const acoes = auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('agente_escalonada'));
  assert.equal(acoes.includes('escalonada'), false, 'escalonamento do agente não entra na métrica da clínica');
  assert.equal(acoes.includes('resposta_nao_entregue'), false, 'nem no alerta crítico da Serena');
});

test('pela porta de ingresso, o trabalho da outbox espera o tempo de resposta do agente', async () => {
  const { repositorio, atendimento, chamadasDeIA } = montar();
  await criarAlpins(repositorio, { configuracoes: { tempo_resposta_segundos: 10 } });

  const antes = Date.now();
  const resultado = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }), { despachoEmSegundoPlano: true });

  assert.equal(resultado.acao, 'aceita_para_despacho');
  assert.equal(chamadasDeIA.length, 0, 'na porta de ingresso ninguém chama IA dentro da requisição');
  const trabalho = await repositorio.obterTrabalhoDeOutbox(resultado.trabalho_id);
  const atraso = new Date(trabalho.disponivel_em).getTime() - antes;
  assert.ok(atraso >= 9000 && atraso <= 12000, `disponível ~10s depois (foi ${atraso}ms)`);
});

test('resposta da equipe numa conversa de agente também sai pelo número do agente', async () => {
  const { repositorio, atendimento, envios } = montar();
  await criarAlpins(repositorio, { status: 'desativado' });
  const { conversa_id: conversaId } = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  await atendimento.responderComoEquipe(conversaId, 'Oi, aqui é a equipe da loja.', { autorNome: 'Equipe' });

  assert.equal(envios.length, 1);
  assert.equal(envios[0].instancia, 'alpins');
});

test('eco de envio feito por fora no número do agente vai para a conversa do agente', async () => {
  const { repositorio, atendimento } = montar();
  const alpins = await criarAlpins(repositorio, { status: 'desativado' });
  const { conversa_id: conversaDoAgente } = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  const eco = await atendimento.registrarEnvioExternoDoWhatsapp({
    telefone: CLIENTE, texto: 'Mandei pelo celular', idProvedor: `whatsapp:${CLIENTE}:ECO1`, instancia: 'alpins',
  });

  assert.equal(eco.conversa_id, conversaDoAgente);
  assert.equal((await repositorio.obterConversa(eco.conversa_id)).agente_id, alpins.id);
});

test('equipe numa conversa de agente: assumir e falha de entrega auditam com nome do agente — alerta e métricas da clínica intactos', async () => {
  const { repositorio, atendimento, auditoria } = montar();
  await criarAlpins(repositorio, { status: 'desativado', canalAtivo: false });
  const { conversa_id: conversaId } = await atendimento.receberMensagem(evento('A1', { instancia: 'alpins' }));

  const resposta = await atendimento.responderComoEquipe(conversaId, 'Oi, aqui é a equipe da loja.', { autorNome: 'Equipe' });

  assert.equal(resposta.enviada, false, 'canal do agente desligado: nada sai');
  const acoes = auditoria.map((item) => item.acao);
  assert.ok(acoes.includes('agente_assumida_por_humano'));
  assert.ok(acoes.includes('agente_resposta_nao_entregue'));
  assert.equal(acoes.includes('assumida_por_humano'), false, 'não conta nos handoffs da Serena');
  assert.equal(acoes.includes('resposta_nao_entregue'), false, 'não acende o alerta crítico da Serena');
});

test('na clínica, assumir continua auditando exatamente como antes', async () => {
  const { atendimento, auditoria } = montar();

  const { conversa_id: conversaId } = await atendimento.receberMensagem(evento('C1', { texto: 'Oi clínica' }));
  await atendimento.assumir(conversaId, null);

  assert.ok(auditoria.map((item) => item.acao).includes('assumida_por_humano'));
});
