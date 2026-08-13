'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// Quem agiu vem do token, nunca do corpo da requisição.
//
// O servidor monta o corpo das ações como `{ ...corpo, usuario_id: usuario.id }`
// — o valor do token entra depois e sobrescreve. Funciona, mas a garantia mora
// três arquivos longe de quem a consome: as rotas leem `corpo.usuario_id` e não
// têm como saber de onde ele veio.
//
// Estes testes são o que segura isso. Sem eles, alguém "simplifica" a ordem do
// spread um dia e passa a aceitar identidade forjada — sem erro, sem log, e com
// a auditoria registrando outra pessoa.

function orquestradorFalso() {
  return {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
}

async function subir() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador });

  // `estrategia_ia: 'openclaw_gerencia'` grava a conversa e a mensagem de
  // entrada sem decidir automação nenhuma — o orquestrador falso aqui existe
  // só para o resto da suíte, não para este setup. Com `crm_despacha`, desde
  // o Comando 7 / achado A-2, um orquestrador indisponível escalona de
  // verdade (`assumida_por_humano: true`) — o que faria os testes deste
  // arquivo (identidade de quem RESPONDE, não da mensagem de entrada) achar a
  // conversa já "assumida" pelo sistema antes mesmo do atendente postar nada,
  // e `responderComoEquipe` só chama `assumir` (que grava `atribuido_a`)
  // quando a conversa ainda não estava assumida.
  await atendimento.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'openclaw_gerencia',
    id_externo: 'id:1', remetente: '5516999999999',
    nome: 'Marina', texto: 'Olá',
  });

  const app = await subirServidor({
    repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste(),
  });

  const [conversa] = await repositorio.listarConversas({});
  return { app, repositorio, conversa };
}

function postarComo(app, sessao) {
  return (caminho, corpo) => app.pedirSemAuth(caminho, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessao.access_token}`,
    },
    body: JSON.stringify(corpo),
  });
}

test('mensagem enviada com usuario_id forjado grava quem está no token', async (t) => {
  const { app, repositorio, conversa } = await subir();
  t.after(() => app.encerrar());

  const atendente = await app.entrarComo('atendente', { email: 'recepcao@teste.local' });
  const postar = postarComo(app, atendente);

  // O corpo tenta se passar por outra pessoa, nos dois campos que carregam
  // identidade: o nome que aparece no balão e o id que assume a conversa.
  const resposta = await postar(`/api/conversas/${conversa.id}/mensagens`, {
    texto: 'Bom dia!',
    usuario_id: 999999,
    autor: 'Diretor Clínico',
  });
  assert.equal(resposta.status, 200);

  // Não é a última: responder assume a conversa, e assumir grava uma mensagem
  // de sistema logo depois.
  const mensagens = await repositorio.listarMensagens(conversa.id);
  const enviada = mensagens.filter((item) => item.autor_tipo === 'equipe').at(-1);
  assert.ok(enviada, 'a mensagem da equipe precisa existir');

  assert.equal(enviada.autor_nome, atendente.usuario.nome, 'o nome no balão é o de quem tem o token');
  assert.notEqual(enviada.autor_nome, 'Diretor Clínico', 'o corpo não escolhe de quem é a fala');

  // Responder assume a conversa, e é aí que o id entra: se o corpo mandasse,
  // a conversa ficaria atribuída a outra pessoa.
  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.atribuido_a, atendente.usuario.id);
  assert.notEqual(depois.atribuido_a, 999999);
});

test('nota interna também ignora o autor enviado pelo cliente', async (t) => {
  const { app, repositorio, conversa } = await subir();
  t.after(() => app.encerrar());

  const atendente = await app.entrarComo('atendente', { email: 'nota@teste.local' });
  const postar = postarComo(app, atendente);

  await postar(`/api/conversas/${conversa.id}/notas`, {
    texto: 'Paciente pediu retorno',
    usuario_id: 424242,
  });

  const notas = await repositorio.listarNotas(conversa.contato_id);
  assert.equal(notas.at(-1).usuario_id, atendente.usuario.id);
});

test('assumir conversa registra quem tem o token, não quem o corpo diz', async (t) => {
  const { app, repositorio, conversa } = await subir();
  t.after(() => app.encerrar());

  const atendente = await app.entrarComo('atendente', { email: 'assume@teste.local' });
  const postar = postarComo(app, atendente);

  await postar(`/api/conversas/${conversa.id}/assumir`, { usuario_id: 777777 });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.atribuido_a, atendente.usuario.id);
  assert.notEqual(depois.atribuido_a, 777777);
});

test('sem token nenhuma identidade é aceita, nem a inventada', async (t) => {
  const { app, conversa } = await subir();
  t.after(() => app.encerrar());

  const resposta = await app.pedirSemAuth(`/api/conversas/${conversa.id}/mensagens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texto: 'oi', usuario_id: 1 }),
  });

  assert.equal(resposta.status, 401);
});

test('token adulterado não vira identidade', async (t) => {
  const { app, conversa } = await subir();
  t.after(() => app.encerrar());

  const atendente = await app.entrarComo('atendente', { email: 'adultera@teste.local' });

  // Troca um caractere do payload: a assinatura deixa de conferir.
  const partes = atendente.access_token.split('.');
  const adulterado = `${partes[0]}.${partes[1].slice(0, -1)}X.${partes[2]}`;

  const resposta = await app.pedirSemAuth(`/api/conversas/${conversa.id}/mensagens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adulterado}` },
    body: JSON.stringify({ texto: 'oi' }),
  });

  assert.equal(resposta.status, 401);
});

test('a agenda também grava o usuário do token', async (t) => {
  const { app, repositorio, conversa } = await subir();
  t.after(() => app.encerrar());

  const gestor = await app.entrarComo('gestor', { email: 'gestor-ag@teste.local' });
  const postar = postarComo(app, gestor);

  const profissional = await repositorio.criarProfissional({ nome: 'Dra. Helena', duracaoMin: 30 });
  await repositorio.definirDisponibilidades(profissional.id, [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
    dia_semana: dia, hora_inicio: '08:00', hora_fim: '18:00',
  })));

  // Amanhã às 10h NO FUSO DA CLÍNICA, seja qual for o TZ do processo:
  // `setHours(10)` em CI UTC produziria 7h em São Paulo — fora da janela — e o
  // teste falharia pelo relógio da máquina, não pelo que ele testa.
  const referencia = new Date();
  referencia.setUTCDate(referencia.getUTCDate() + 1);
  referencia.setUTCHours(12, 0, 0, 0);
  const desvioHoras = 12 - Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', timeZone: 'America/Sao_Paulo', hour12: false,
  }).format(referencia));
  const inicio = new Date();
  inicio.setUTCDate(inicio.getUTCDate() + 1);
  inicio.setUTCHours(10 + desvioHoras, 0, 0, 0);
  const fim = new Date(inicio);
  fim.setUTCHours(11 + desvioHoras, 0, 0, 0);

  const { token } = await (await postar('/api/agenda/propor', {
    profissional_id: profissional.id,
    contato_id: conversa.contato_id,
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
    usuario_id: 555555,
  })).json();

  await postar('/api/agenda/confirmar', { token, usuario_id: 555555 });

  const registro = repositorio._auditoria.find((linha) => linha.acao === 'agendamento_criado');
  assert.equal(registro.usuarioId, gestor.usuario.id, 'a auditoria da agenda segue o token');
  assert.notEqual(registro.usuarioId, 555555);
});
