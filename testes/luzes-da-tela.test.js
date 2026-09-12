'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { subirServidor } = require('./auxiliar');

// As luzes dos botões, contra a resposta REAL das rotas.
//
// Por que este arquivo existe: a primeira versão das luzes foi escrita contra
// campos que a API não devolve — `dados.canal`, `prompt_publicado`,
// `horario.atendendo_agora`, `agente.comportamento_publicado`. Nada quebrava:
// `undefined` cai no ramo do "else" e a luz acende vermelha. Resultado: WhatsApp
// conectado, prompt publicado e Serena atendendo, e a tela mostrando três
// pontos vermelhos — um erro que só aparece olhando, e que teste de regex sobre
// o texto do app.js nunca pegaria (o código está sintaticamente perfeito).
//
// Aqui a função da tela é EXTRAÍDA do public/app.js e executada contra o JSON
// que a rota devolve de verdade. Se alguém renomear um campo na rota, ou
// escrever o nome errado na tela, um destes testes fica vermelho.

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/**
 * Extrai uma função de nível superior do app.js pelo nome, fechando nas
 * chaves — parar "na próxima função" levava junto o que estivesse no meio
 * (no caso, o laço que registra os listeners dos botões, que precisa de
 * `document`).
 */
function fonteDaFuncao(nome) {
  const inicio = APP_JS.search(new RegExp(`^function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `public/app.js precisa declarar ${nome}`);
  // O corpo começa depois do parêntese que fecha os parâmetros — começar no
  // primeiro `{` pegaria o do valor padrão (`dados = {}`) e fecharia ali.
  let parenteses = 0;
  let corpo = -1;
  for (let i = APP_JS.indexOf('(', inicio); i < APP_JS.length; i += 1) {
    if (APP_JS[i] === '(') parenteses += 1;
    else if (APP_JS[i] === ')') {
      parenteses -= 1;
      if (parenteses === 0) { corpo = APP_JS.indexOf('{', i); break; }
    }
  }
  assert.ok(corpo > 0, `não achei o corpo de ${nome}`);

  let profundidade = 0;
  for (let i = corpo; i < APP_JS.length; i += 1) {
    if (APP_JS[i] === '{') profundidade += 1;
    else if (APP_JS[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return APP_JS.slice(inicio, i + 1);
    }
  }
  throw new Error(`não consegui fechar a função ${nome}`);
}

/** Extrai uma constante de nível superior (de uma linha) do app.js. */
function fonteDaConstante(nome) {
  const achado = APP_JS.match(new RegExp(`^const ${nome} = .*$`, 'm'));
  assert.ok(achado, `public/app.js precisa declarar ${nome}`);
  return achado[0];
}

/**
 * DOM mínimo: só o que as funções de luz tocam — um elemento por `data-luz`,
 * cada um dentro de um "botão" com o rótulo da seção.
 */
function telaFalsa(atributo, nomes) {
  const luzes = new Map();
  for (const nome of nomes) {
    const botao = { textContent: `Seção ${nome}`, title: '' };
    luzes.set(nome, { dataset: {}, closest: (alvo) => (alvo === `[${atributo}]` ? botao : null), botao });
  }
  return {
    luzes,
    seletor: (consulta) => {
      const achado = consulta.match(new RegExp(`\\[${atributo}="([^"]+)"\\]`));
      return achado ? luzes.get(achado[1]) ?? null : null;
    },
    estadoDe: (nome) => luzes.get(nome)?.dataset?.estado,
  };
}

/** Compara conteúdo, não identidade de protótipo (o vm tem os seus). */
function mesmoConteudo(recebido, esperado, mensagem) {
  assert.equal(JSON.stringify(recebido), JSON.stringify(esperado), mensagem);
}

function executar(fontes, contexto) {
  const ambiente = vm.createContext(contexto);
  vm.runInContext(fontes.join('\n'), ambiente);
  return ambiente;
}

async function montar(t) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'oi' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });
  const ambiente = await subirServidor({ repositorio, orquestrador, atendimento, servicoDaSerena });
  t.after(() => ambiente.encerrar());
  return { ambiente, repositorio, servicoDaSerena };
}

test('as luzes da Serena leem os campos que GET /api/serena realmente devolve', async (t) => {
  const { ambiente } = await montar(t);

  const resposta = await ambiente.pedir('/api/serena');
  assert.equal(resposta.status, 200);
  const painel = await resposta.json();

  // Os nomes que a tela procura precisam existir na resposta. Estes três foram
  // exatamente os que a primeira versão errou.
  assert.ok('whatsapp' in painel, 'a resposta traz o canal em `whatsapp`');
  assert.ok('horario' in painel && 'atendendo' in painel.horario, 'o horário responde `atendendo`');
  assert.ok('prompt_ativo' in painel, 'a versão publicada vem em `prompt_ativo`');
  assert.ok(Array.isArray(painel.regras), 'as regras vêm em `regras`');

  const tela = telaFalsa('data-luz', ['whatsapp', 'diagnostico', 'teste', 'voz', 'horario', 'prompt', 'regras']);
  const ambienteJs = executar([fonteDaFuncao('desenharLuzesDaSerena')], { seletor: tela.seletor });

  ambienteJs.desenharLuzesDaSerena(painel);

  // Com o WhatsApp desconectado (é o estado do repositório em memória), a luz
  // precisa ser vermelha — e ficar verde quando conectar.
  assert.equal(tela.estadoDe('whatsapp'), painel.whatsapp.estado === 'conectado' ? 'ok' : 'parado');
  ambienteJs.desenharLuzesDaSerena({ ...painel, whatsapp: { estado: 'conectado' } });
  assert.equal(tela.estadoDe('whatsapp'), 'ok', 'WhatsApp conectado tem de acender verde');

  ambienteJs.desenharLuzesDaSerena({ ...painel, horario: { ...painel.horario, atendendo: true } });
  assert.equal(tela.estadoDe('horario'), 'ok', 'atendendo agora é verde');
  ambienteJs.desenharLuzesDaSerena({ ...painel, horario: { agenda: { ativa: true }, atendendo: false } });
  assert.equal(tela.estadoDe('horario'), 'parado', 'grade ativa e fora do horário é vermelho');

  ambienteJs.desenharLuzesDaSerena({ ...painel, prompt_ativo: { id: 1, versao: 3 } });
  assert.equal(tela.estadoDe('prompt'), 'ok', 'com versão publicada a luz do prompt é verde');
  ambienteJs.desenharLuzesDaSerena({ ...painel, prompt_ativo: null });
  assert.equal(tela.estadoDe('prompt'), 'parado');

  ambienteJs.desenharLuzesDaSerena({ ...painel, regras: [{ ativa: true }, { ativa: false }] });
  assert.equal(tela.estadoDe('regras'), 'ok');
  ambienteJs.desenharLuzesDaSerena({ ...painel, regras: [{ ativa: false }] });
  assert.equal(tela.estadoDe('regras'), 'neutro');
});

test('as luzes do agente leem os campos que GET /api/agentes/:id realmente devolve', async (t) => {
  const { ambiente } = await montar(t);

  const criado = await ambiente.pedir('/api/agentes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nome: 'Agente de Teste',
      slug: 'agente-de-teste',
      finalidade: 'suporte',
      comportamento: 'Atende com clareza e encaminha para a equipe.',
    }),
  });
  // Lê o corpo uma vez só: `criado.text()` dentro do assert já consumiria o
  // stream, e o `.json()` seguinte falharia com "Body is unusable".
  const corpo = await criado.json().catch(() => null);
  assert.equal(criado.status, 201, JSON.stringify(corpo));
  const novo = corpo.agente;

  const resposta = await ambiente.pedir(`/api/agentes/${novo.id}`);
  assert.equal(resposta.status, 200);
  const dados = await resposta.json();

  // Os nomes reais — cada um destes foi escrito errado na primeira versão.
  assert.ok('comportamento' in dados.agente, 'o comportamento vem em `agente.comportamento`');
  assert.ok('configuracoes' in dados.agente, 'o horário mora em `agente.configuracoes.horario`');
  assert.ok(Array.isArray(dados.agente.acoes_inatividade), 'inatividade é `agente.acoes_inatividade`');
  assert.ok(!('equipe' in dados), 'a equipe NÃO vem nesta resposta — vem de /api/agentes/:id/equipe');

  const abas = ['teste', 'horario', 'perfil', 'treinamentos', 'trabalho', 'configuracoes', 'inatividade', 'canais', 'equipe'];
  const tela = telaFalsa('data-luz-agente', abas);
  const ambienteJs = executar(
    [fonteDaFuncao('acenderLuzDoAgente'), fonteDaFuncao('desenharLuzesDoAgente')],
    { seletor: tela.seletor },
  );

  ambienteJs.desenharLuzesDoAgente(dados);

  assert.equal(tela.estadoDe('perfil'), 'ok', 'agente com comportamento gravado não pode dizer "falta configurar"');
  // A equipe chega em outra requisição: até lá a luz fica neutra, não vermelha.
  assert.equal(tela.estadoDe('equipe'), 'neutro');

  ambienteJs.desenharLuzesDoAgente({ agente: { ...dados.agente, comportamento: '   ' } });
  assert.equal(tela.estadoDe('perfil'), 'parado', 'sem comportamento o agente não tem identidade');

  ambienteJs.desenharLuzesDoAgente({
    agente: { ...dados.agente, configuracoes: { horario: { ativa: true } }, acoes_inatividade: [{ ativa: true }] },
  });
  assert.equal(tela.estadoDe('horario'), 'ok');
  assert.equal(tela.estadoDe('inatividade'), 'ok');
});

test('o funil desenha na ordem do funil, não na alfabética, e "perdido" sai da descida', () => {
  const ambienteJs = executar([
    fonteDaConstante('ORDEM_DO_FUNIL'),
    fonteDaConstante('ESTAGIOS_TERMINAIS'),
    fonteDaFuncao('ordenarFunil'),
  ], {});

  // É assim que a consulta devolve: ORDER BY estagio (alfabético).
  const doBanco = [
    { estagio: 'agendado', total: 23 },
    { estagio: 'convertido', total: 14 },
    { estagio: 'novo', total: 247 },
    { estagio: 'perdido', total: 40 },
    { estagio: 'qualificando', total: 61 },
  ];

  const { descida, fora } = ambienteJs.ordenarFunil(doBanco, { rotulo: 'estagio' });

  mesmoConteudo(descida.map((e) => e.estagio), ['novo', 'qualificando', 'agendado', 'convertido']);
  mesmoConteudo(fora.map((e) => e.estagio), ['perdido'], '"perdido" é terminal: não é degrau da descida');
  // Na ordem alfabética, "novo" (247) vinha depois de "convertido" (14) e o
  // gráfico anunciava "1764% de quem estava em convertido".
  assert.ok(descida[0].total >= descida[3].total, 'o topo do funil não pode ser menor que o fim');

  // Etapa sem lead nenhum não vem da consulta; o funil não pode pular o degrau.
  const semQualificando = ambienteJs.ordenarFunil(
    [{ estagio: 'novo', total: 5 }, { estagio: 'agendado', total: 1 }],
    { rotulo: 'estagio' },
  );
  mesmoConteudo(semQualificando.descida.map((e) => e.estagio), ['novo', 'qualificando', 'agendado', 'convertido']);
  assert.equal(semQualificando.descida[1].total, 0);
});

test('"Leads por dia" soma as origens do mesmo dia', () => {
  const ambienteJs = executar([fonteDaFuncao('totalPorDia')], {});

  // vw_leads_por_dia devolve uma linha por dia E POR ORIGEM.
  const doBanco = [
    { dia: '2026-09-10', origem: 'WHATSAPP', total: 4 },
    { dia: '2026-09-10', origem: 'INSTAGRAM', total: 3 },
    { dia: '2026-09-11', origem: 'WHATSAPP', total: 5 },
    { dia: '2026-09-11', origem: 'SITE', total: 1 },
    { dia: '2026-09-11', origem: 'INSTAGRAM', total: 2 },
  ];

  mesmoConteudo(ambienteJs.totalPorDia(doBanco), [
    { dia: '2026-09-10', total: 7 },
    { dia: '2026-09-11', total: 8 },
  ], 'dois dias, com as origens somadas — não cinco pontos serrilhados');

  mesmoConteudo(ambienteJs.totalPorDia([]), []);
  mesmoConteudo(ambienteJs.totalPorDia(undefined), []);
});
