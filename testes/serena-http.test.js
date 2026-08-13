'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

// O painel da Serena e o CRUD de contatos, pela porta de entrada.
//
// O teste que mais importa é o do desligamento: com a Serena desligada, a
// mensagem do paciente **continua sendo gravada** e a resposta não sai. Se
// desligar calasse o inbox junto, a clínica perderia o contato de quem escreveu
// durante o incidente — e ninguém saberia que perdeu.

function orquestradorFalso() {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'Olá! Sou a Serena.' }; },
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  // O interruptor da Serena governa o fluxo em que o CRM aciona a IA; é esse
  // caminho que estes testes percorrem, daí o carimbo crm_despacha.
  estrategia_ia: 'crm_despacha',
  remetente: '5516993120938',
  nome: 'Marina Souza',
  texto: 'Gostaria de marcar uma consulta',
});

/** Sobe o servidor com a Serena ligada ao atendimento, como em produção. */
async function montar(t, opcoes = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });

  const ambiente = await subirServidor({
    repositorio, orquestrador, atendimento, servicoDaSerena, ...opcoes,
  });
  t.after(() => ambiente.encerrar());

  return { ambiente, repositorio, orquestrador, servicoDaSerena, atendimento };
}

// ---------------------------------------------------------------- status

test('o status separa OpenClaw, WhatsApp, Serena, entrega e horário', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await ambiente.pedir('/api/serena/status');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  // Cinco coisas distintas: cada uma pede uma ação diferente da equipe.
  assert.deepEqual(Object.keys(corpo).sort(), ['entrega', 'horario', 'openclaw', 'serena', 'whatsapp']);
  assert.equal(corpo.serena.estado, 'ligada');
  assert.equal(corpo.serena.ativa, true);

  // "O interruptor está ligado" e "ela está atendendo agora" são perguntas
  // diferentes, e a tela precisa da segunda. Sem grade configurada, as duas
  // coincidem — e é justamente por isso que o campo tem de existir separado,
  // antes que alguém configure horário e a tela passe a mentir.
  assert.equal(corpo.horario.atendendo, true);
  assert.equal(corpo.horario.agenda, null);
  assert.equal(corpo.horario.pausada, false);
  // Sem gateway configurado no teste, o estado é "não configurado" — e não
  // "offline", que faria alguém procurar um serviço fora do ar que não existe.
  assert.equal(corpo.openclaw.estado, 'nao_configurado');
  assert.equal(corpo.whatsapp.estado, 'desconectado');
});

// Comando 5, frente 12 — desejado (o que a configuração manda agora) ao lado
// do efetivo (o que o canal do OpenClaw está de fato aplicando). Antes só
// existia no centro operacional (`GET /api/diagnostico`); agora também no
// status principal, reaproveitando `sondaDaSerena` — não recalculado.

test('sem política de canal configurada (Arquitetura B), desejado_vs_efetivo vem null — não inventa divergência', async (t) => {
  const { ambiente } = await montar(t); // sem politicaDoCanal injetada

  const corpo = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(corpo.serena.desejado_vs_efetivo, null);
});

test('com política de canal e os dois lados concordando, desejado e efetivo aparecem iguais', async (t) => {
  const politicaFalsa = { async ler() { return { atendendo: true }; } };
  const { ambiente } = await montar(t, { politicaDoCanal: politicaFalsa });

  const corpo = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(corpo.serena.desejado_vs_efetivo.desejado, true, 'Serena ligada, sem horário: desejado é atender');
  assert.equal(corpo.serena.desejado_vs_efetivo.aplicado, true);
});

test('com política de canal discordando do desejado, a divergência aparece — o defeito que motivou este comando', async (t) => {
  // O painel manda atender (Serena ligada), mas o canal está calado — é
  // exatamente o cenário que a auditoria original descreveu: "o painel dizia
  // desligada e a Serena respondia" (ou o inverso). Agora dá para ver os
  // dois lados no mesmo lugar onde o status já aparece.
  const politicaFalsa = { async ler() { return { atendendo: false }; } };
  const { ambiente } = await montar(t, { politicaDoCanal: politicaFalsa });

  const corpo = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(corpo.serena.desejado_vs_efetivo.desejado, true);
  assert.equal(corpo.serena.desejado_vs_efetivo.aplicado, false);
});

test('o painel entrega estado, prompt e regras de uma vez', async (t) => {
  const { ambiente, servicoDaSerena } = await montar(t);

  const prompt = await servicoDaSerena.criarPrompt({ titulo: 'Política', conteudo: 'Você é Serena, da clínica.' });
  await servicoDaSerena.publicarPrompt(prompt.id, {});
  await servicoDaSerena.criarRegra({ nome: 'sem diagnóstico', categoria: 'barreira', conteudo: 'Nunca diagnostique.' });

  const corpo = await (await ambiente.pedir('/api/serena')).json();

  assert.equal(corpo.prompt_ativo.versao, 1);
  assert.match(corpo.prompt_efetivo, /Nunca diagnostique/);
  assert.equal(corpo.regras.length, 1);
  assert.equal(corpo.versoes.length, 1);
  assert.equal(corpo.pode_gerenciar, true, 'o usuário do teste é admin');
});

// ---------------------------------------------------------------- interruptor

test('desligar exige motivo; ligar não', async (t) => {
  const { ambiente } = await montar(t);

  const semMotivo = await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false }),
  });
  assert.equal(semMotivo.status, 400);
  assert.equal((await semMotivo.json()).codigo, 'motivo_obrigatorio');

  const comMotivo = await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'respondendo errado sobre convênio' }),
  });
  assert.equal(comMotivo.status, 200);
  assert.equal((await comMotivo.json()).serena.estado, 'desligada');

  // Voltar ao normal não precisa de justificativa.
  const religar = await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: true }),
  });
  assert.equal(religar.status, 200);
});

test('o interruptor leve serve o botão de emergência sem tocar o gateway', async (t) => {
  const { ambiente, orquestrador } = await montar(t);

  const chamadasAntes = orquestrador.chamadas?.length ?? null;

  const ligada = await ambiente.pedir('/api/serena/interruptor');
  assert.equal(ligada.status, 200);
  assert.equal((await ligada.json()).ativa, true);

  // Emergência de verdade: o botão manda parar com o motivo carimbado.
  await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'PARADA DE EMERGÊNCIA — botão do painel' }),
  });

  const parada = await (await ambiente.pedir('/api/serena/interruptor')).json();
  assert.equal(parada.ativa, false);
  assert.match(parada.motivo ?? '', /EMERGÊNCIA/);

  // Leve de verdade: nenhuma chamada nova ao gateway do canal.
  if (chamadasAntes !== null) {
    assert.equal(orquestrador.chamadas.length, chamadasAntes,
      'o botão de emergência não pode depender do gateway para saber o próprio estado');
  }

  // O atendente pode VER o estado (serena:ler) — agir é outra permissão.
  const atendente = await ambiente.entrarComo('atendente');
  const doAtendente = await ambiente.pedirSemAuth('/api/serena/interruptor', {
    headers: { authorization: `Bearer ${atendente.access_token}` },
  });
  assert.equal(doAtendente.status, 200);
});

test('só admin liga e desliga; atendente apenas consulta', async (t) => {
  const { ambiente } = await montar(t);

  const atendente = await ambiente.entrarComo('atendente');
  const comAtendente = (caminho, opcoes = {}) => ambiente.pedirSemAuth(caminho, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), authorization: `Bearer ${atendente.access_token}` },
  });

  assert.equal((await comAtendente('/api/serena/status')).status, 200);

  const tentativa = await comAtendente('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'quero desligar' }),
  });
  assert.equal(tentativa.status, 403);

  // E o painel diz à interface para não mostrar os botões.
  const painel = await (await comAtendente('/api/serena')).json();
  assert.equal(painel.pode_gerenciar, false);
});

test('gestor também não desliga a Serena', async (t) => {
  const { ambiente } = await montar(t);
  const gestor = await ambiente.entrarComo('gestor');

  const tentativa = await ambiente.pedirSemAuth('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gestor.access_token}` },
    body: JSON.stringify({ ativa: false, motivo: 'teste' }),
  });
  assert.equal(tentativa.status, 403);
});

test('a mudança de estado fica auditada com autor e motivo', async (t) => {
  const { ambiente, repositorio } = await montar(t);

  await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'manutenção do prompt' }),
  });

  const registro = repositorio._auditoria.find((item) => item.acao === 'serena_desligada');
  assert.ok(registro, 'desligar precisa deixar rastro');
  assert.equal(registro.detalhe.motivo, 'manutenção do prompt');
  assert.ok(registro.usuarioId, 'o autor precisa estar registrado');
});

// ---------------------------------------------------------------- o efeito real

test('desligada, a mensagem é gravada e a Serena não responde', async (t) => {
  const { ambiente, repositorio, orquestrador, atendimento } = await montar(t);

  // Ligada: responde.
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:1' });
  assert.equal(orquestrador.despachos.length, 1);

  await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'incidente' }),
  });

  const resultado = await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:2', texto: 'Continuo aqui' });

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'serena_desligada');
  assert.equal(resultado.escopo, 'global');
  assert.equal(orquestrador.despachos.length, 1, 'nenhum despacho novo');

  // E o que importa: a mensagem do paciente está no inbox.
  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);
  assert.ok(
    mensagens.some((mensagem) => mensagem.conteudo === 'Continuo aqui'),
    'desligar a Serena não pode calar o inbox',
  );
});

test('religada, volta a responder sem intervenção nenhuma', async (t) => {
  const { ambiente, orquestrador, atendimento } = await montar(t);

  await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false, motivo: 'pausa' }),
  });
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:3' });
  assert.equal(orquestrador.despachos.length, 0);

  await ambiente.pedir('/api/serena/estado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: true }),
  });
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:4', texto: 'Oi de novo' });
  assert.equal(orquestrador.despachos.length, 1);
});

test('a pausa individual continua valendo com a Serena ligada', async (t) => {
  const { ambiente, repositorio, orquestrador, atendimento } = await montar(t);

  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:5' });
  const [conversa] = await repositorio.listarConversas({});
  const despachosAntes = orquestrador.despachos.length;

  // A equipe assume: só esta conversa cala.
  await ambiente.pedir(`/api/conversas/${conversa.id}/assumir`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  const resultado = await atendimento.responderSePossivel(conversa.id);
  assert.equal(resultado.motivo, 'assumida_por_humano');
  assert.equal(resultado.escopo, 'conversa');
  assert.equal(orquestrador.despachos.length, despachosAntes);

  // E o estado global segue ligado — a pausa foi de uma conversa só.
  const status = await (await ambiente.pedir('/api/serena/status')).json();
  assert.equal(status.serena.estado, 'ligada');
});

// ---------------------------------------------------------------- prompt

test('o prompt publicado não pode ser editado — cria-se uma versão nova', async (t) => {
  const { ambiente } = await montar(t);

  const criado = await (await ambiente.pedir('/api/serena/prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titulo: 'v1', conteudo: 'Você é Serena, da clínica.' }),
  })).json();

  await ambiente.pedir(`/api/serena/prompts/${criado.prompt.id}/publicar`, { method: 'POST' });

  const tentativa = await ambiente.pedir(`/api/serena/prompts/${criado.prompt.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titulo: 'v1 alterada', conteudo: 'Texto novo por cima do publicado.' }),
  });

  assert.equal(tentativa.status, 409);
  assert.equal((await tentativa.json()).codigo, 'prompt_publicado');
});

test('publicar uma versão tira a anterior do ar', async (t) => {
  const { ambiente } = await montar(t);

  const primeira = await (await ambiente.pedir('/api/serena/prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titulo: 'v1', conteudo: 'Primeira política da clínica.' }),
  })).json();
  await ambiente.pedir(`/api/serena/prompts/${primeira.prompt.id}/publicar`, { method: 'POST' });

  const segunda = await (await ambiente.pedir('/api/serena/prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titulo: 'v2', conteudo: 'Segunda política da clínica.' }),
  })).json();
  await ambiente.pedir(`/api/serena/prompts/${segunda.prompt.id}/publicar`, { method: 'POST' });

  const painel = await (await ambiente.pedir('/api/serena')).json();
  assert.equal(painel.prompt_ativo.versao, 2);
  // Uma publicada por vez, sempre.
  assert.equal(painel.versoes.filter((versao) => versao.publicado).length, 1);
});

test('a versão nasce numerada pelo banco, em sequência', async (t) => {
  const { ambiente } = await montar(t);

  for (const titulo of ['a', 'b', 'c']) {
    await ambiente.pedir('/api/serena/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ titulo, conteudo: `Conteúdo da política ${titulo}.` }),
    });
  }

  const { versoes } = await (await ambiente.pedir('/api/serena/prompts')).json();
  assert.deepEqual(versoes.map((v) => v.versao), [3, 2, 1]);
});

// ---------------------------------------------------------------- regras

test('regra criada entra no prompt efetivo; desligada, sai', async (t) => {
  const { ambiente, servicoDaSerena } = await montar(t);

  const prompt = await servicoDaSerena.criarPrompt({ titulo: 'base', conteudo: 'Você é Serena, da clínica.' });
  await servicoDaSerena.publicarPrompt(prompt.id, {});

  const criada = await (await ambiente.pedir('/api/serena/regras', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'samu', categoria: 'encaminhamento', conteudo: 'Emergência: oriente o SAMU 192.' }),
  })).json();

  let painel = await (await ambiente.pedir('/api/serena')).json();
  assert.match(painel.prompt_efetivo, /SAMU 192/);

  await ambiente.pedir(`/api/serena/regras/${criada.regra.id}/ativa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ativa: false }),
  });

  painel = await (await ambiente.pedir('/api/serena')).json();
  assert.doesNotMatch(painel.prompt_efetivo, /SAMU 192/, 'regra desligada sai do prompt na hora');
});

test('nome de regra repetido é conflito, não falha interna', async (t) => {
  const { ambiente } = await montar(t);

  const corpo = JSON.stringify({ nome: 'única', categoria: 'geral', conteudo: 'Alguma regra.' });
  await ambiente.pedir('/api/serena/regras', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo,
  });

  const repetida = await ambiente.pedir('/api/serena/regras', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo,
  });

  assert.equal(repetida.status, 409);
  assert.equal((await repetida.json()).codigo, 'nome_duplicado');
});

test('apagar uma regra guarda o conteúdo na auditoria', async (t) => {
  const { ambiente, repositorio } = await montar(t);

  const criada = await (await ambiente.pedir('/api/serena/regras', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nome: 'temporária', categoria: 'geral', conteudo: 'Texto que será apagado.' }),
  })).json();

  await ambiente.pedir(`/api/serena/regras/${criada.regra.id}`, { method: 'DELETE' });

  const registro = repositorio._auditoria.find((item) => item.acao === 'serena_regra_removida');
  assert.ok(registro);
  // Apagar sem rastro impediria explicar depois por que a Serena mudou.
  assert.equal(registro.detalhe.conteudo, 'Texto que será apagado.');
});

// ---------------------------------------------------------------- teste do prompt
//
// Estes testes existem porque a rota foi publicada quebrada: ela passava `corpo`,
// uma variável que não existe naquele ponto do servidor, e toda chamada devolvia
// 500. Chamar a função do módulo direto não pegava — o defeito estava no fio
// entre a porta HTTP e a função, que é justamente o que só a porta exercita.

function conversaFalsa() {
  const enviadas = [];
  return {
    enviadas,
    async abrir({ modelo = null } = {}) { return { sessao: 'agent:serena:dashboard:teste', modelo }; },
    async enviar({ sessao, texto }) { enviadas.push({ sessao, texto }); return { enviado: true }; },
    async historico() { return { mensagens: [{ de: 'paciente', texto: 'oi', modelo: null }] }; },
  };
}

test('POST /api/serena/teste abre a conversa de ensaio', async (t) => {
  const conversa = conversaFalsa();
  const { ambiente } = await montar(t, { conversaDeTeste: conversa });

  const resposta = await ambiente.pedir('/api/serena/teste', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.ok(corpo.sessao);
  assert.ok(Array.isArray(corpo.modelos) && corpo.modelos.length > 0);
});

test('POST /api/serena/teste/mensagem entrega o texto do paciente', async (t) => {
  const conversa = conversaFalsa();
  const { ambiente } = await montar(t, { conversaDeTeste: conversa });

  const resposta = await ambiente.pedir('/api/serena/teste/mensagem', {
    method: 'POST',
    body: JSON.stringify({ sessao: 'agent:serena:dashboard:teste', texto: 'OI' }),
  });

  assert.equal(resposta.status, 200);
  assert.equal(conversa.enviadas.length, 1);
  assert.equal(conversa.enviadas[0].texto, 'OI');
});

test('o modelo escolhido chega ao gateway', async (t) => {
  // Sem isto, o seletor da tela seria enfeite: a escolha morreria no corpo da
  // requisição e toda conversa rodaria no modelo padrão.
  const escolhidos = [];
  const conversa = { ...conversaFalsa(), async abrir({ modelo }) { escolhidos.push(modelo); return { sessao: 's', modelo }; } };
  const { ambiente } = await montar(t, { conversaDeTeste: conversa });

  await ambiente.pedir('/api/serena/teste', {
    method: 'POST', body: JSON.stringify({ modelo: 'anthropic/claude-sonnet-4-6' }),
  });

  assert.deepEqual(escolhidos, ['anthropic/claude-sonnet-4-6']);
});

test('mensagem sem texto é recusada com 400, não com 500', async (t) => {
  const { ambiente } = await montar(t, { conversaDeTeste: conversaFalsa() });

  const resposta = await ambiente.pedir('/api/serena/teste/mensagem', {
    method: 'POST', body: JSON.stringify({ sessao: 's', texto: '   ' }),
  });

  assert.equal(resposta.status, 400);
});

// Comando 5, frente 10 — sem NENHUM gateway de sessão configurado (nem
// clínica, nem comando), o laboratório continua fechado por padrão: 503,
// não uma tentativa de conexão que teria que estourar por timeout. Este é
// o único cenário de disponibilidade do laboratório testável sem depender
// de rede de verdade — os outros (só clínica, só comando, os dois) estão
// cobertos em testes/laboratorio-serena-gateway.test.js, na função pura que
// decide qual gateway usar (`escolherConfiguracaoDoLaboratorio`).
test('sem gateway de sessão nenhum configurado, o laboratório responde 503 canal_nao_configurado — sem tentar rede', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });
  const configuracao = configuracaoDeTeste(); // OPENCLAW_*_GATEWAY_URL vazios por padrão

  const ambiente = await subirServidor({ repositorio, orquestrador, atendimento, servicoDaSerena, configuracao });
  t.after(() => ambiente.encerrar());

  const abrir = await ambiente.pedir('/api/serena/teste', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(abrir.status, 503);
  assert.equal((await abrir.json()).codigo, 'canal_nao_configurado');

  const enviar = await ambiente.pedir('/api/serena/teste/mensagem', {
    method: 'POST', body: JSON.stringify({ sessao: 's', texto: 'oi' }),
  });
  assert.equal(enviar.status, 503);
  assert.equal((await enviar.json()).codigo, 'canal_nao_configurado');
});
