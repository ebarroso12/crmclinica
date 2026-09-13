'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { criarAvisos } = require('../src/dominio/avisos');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// Aviso no celular, a parte de decidir QUANDO tocar e PARA QUEM.
//
// O risco aqui não é o aviso falhar — é ele acontecer demais, ou chegar em
// quem não devia ver aquela conversa. Um CRM que avisa a cada mensagem vira um
// CRM que ninguém olha, e aí o aviso que importava passa junto com o resto.

function webpushFalso({ status = 'entregue' } = {}) {
  const empurrados = [];
  return {
    empurrados,
    configurado: true,
    chavePublica: 'chave-de-teste',
    async empurrar(endpoint) {
      empurrados.push(endpoint);
      if (status === 'morto') return { entregue: false, remover: true, motivo: 'inscricao_expirada' };
      if (status === 'erro') return { entregue: false, remover: false, motivo: 'push respondeu 500' };
      return { entregue: true, remover: false };
    },
  };
}

async function comUmInscrito(repositorio, { papel = 'admin', veClinica = true } = {}) {
  const usuario = await repositorio.criarUsuario({
    nome: 'Quem recebe', email: `${papel}-${Math.random()}@exemplo`, senhaHash: 'x', papel, situacao: 'ativo',
  });
  if (repositorio.atualizarUsuario) await repositorio.atualizarUsuario(usuario.id, { ve_clinica: veClinica });
  await repositorio.salvarInscricaoDeNotificacao({
    usuarioId: usuario.id,
    endpoint: `https://push.exemplo/${usuario.id}`,
    p256dh: 'p',
    auth: 'a',
  });
  return usuario;
}

test('avisa quem tem aparelho inscrito, uma vez por conversa', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const usuario = await comUmInscrito(repositorio);
  const webpush = webpushFalso();
  const avisos = criarAvisos({ repositorio, webpush });

  const primeiro = await avisos.avisar({ conversaId: 10 });
  assert.equal(primeiro.enviados, 1);
  assert.deepEqual(webpush.empurrados, [`https://push.exemplo/${usuario.id}`]);

  // Três mensagens seguidas do mesmo paciente não podem fazer o celular tocar
  // três vezes em dez segundos.
  const segundo = await avisos.avisar({ conversaId: 10 });
  assert.equal(segundo.enviados, 0);
  assert.equal(segundo.motivo, 'dentro_da_janela_de_silencio');
  assert.equal(webpush.empurrados.length, 1);

  // Outra conversa é outro assunto: essa toca.
  const outra = await avisos.avisar({ conversaId: 11 });
  assert.equal(outra.enviados, 1);
});

test('passada a janela de silêncio, a mesma conversa volta a avisar', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comUmInscrito(repositorio);
  const webpush = webpushFalso();

  let instante = new Date('2026-09-12T10:00:00Z');
  const avisos = criarAvisos({ repositorio, webpush, agora: () => instante });

  await avisos.avisar({ conversaId: 7 });
  instante = new Date('2026-09-12T10:09:00Z'); // ainda dentro
  assert.equal((await avisos.avisar({ conversaId: 7 })).enviados, 0);
  instante = new Date('2026-09-12T10:11:00Z'); // passou
  assert.equal((await avisos.avisar({ conversaId: 7 })).enviados, 1);
});

test('inscrição morta é apagada; erro do serviço não apaga a de ninguém', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const usuario = await comUmInscrito(repositorio);

  const morto = criarAvisos({ repositorio, webpush: webpushFalso({ status: 'morto' }) });
  await morto.avisar({ conversaId: 1 });
  assert.equal((await repositorio.listarInscricoesDeNotificacao(usuario.id)).length, 0,
    'aparelho que desinstalou o app sai da lista — insistir é gastar requisição para sempre');

  await repositorio.salvarInscricaoDeNotificacao({
    usuarioId: usuario.id, endpoint: 'https://push.exemplo/de-novo', p256dh: 'p', auth: 'a',
  });
  const comErro = criarAvisos({ repositorio, webpush: webpushFalso({ status: 'erro' }) });
  await comErro.avisar({ conversaId: 2 });
  assert.equal((await repositorio.listarInscricoesDeNotificacao(usuario.id)).length, 1,
    'serviço de push com erro não pode apagar inscrição boa');
});

test('sem VAPID configurado, nada é enviado e nada quebra', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comUmInscrito(repositorio);
  const avisos = criarAvisos({ repositorio, webpush: { configurado: false } });

  const resultado = await avisos.avisar({ conversaId: 3 });
  assert.equal(resultado.enviados, 0);
  assert.equal(resultado.motivo, 'vapid_nao_configurado');
});

test('o aviso nunca derruba o atendimento que o gerou', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await comUmInscrito(repositorio);
  const explode = {
    configurado: true,
    empurrar: async () => { throw new Error('serviço de push fora do ar'); },
  };
  const registrados = [];
  const avisos = criarAvisos({ repositorio, webpush: explode, registrador: { aviso: (d) => registrados.push(d) } });

  // Não lança: quando isto roda, o paciente já foi escalonado. Perder o aviso é
  // ruim; perder o escalonamento é muito pior.
  const resultado = await avisos.avisar({ conversaId: 4 });
  assert.equal(resultado.enviados, 0);
  assert.equal(resultado.motivo, 'falhou');
  assert.equal(registrados.length, 1, 'a falha tem de aparecer no log, não sumir');
});

test('a tela não oferece o botão quando o servidor não sabe empurrar', () => {
  const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Botão que não faz nada é pior que botão nenhum.
  assert.match(APP_JS, /if \(!avisosDisponiveis\?\.disponivel\) \{[\s\S]{0,80}card\.hidden = true;/);
  // E `userVisibleOnly` é obrigatório: receber push sem mostrar notificação faz
  // o Chrome revogar a permissão depois de algumas vezes.
  assert.match(APP_JS, /userVisibleOnly: true/);
});

test('o service worker mostra o aviso sem conteúdo de paciente', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(SW, /showNotification/);
  // A notificação aparece na tela de bloqueio: nada de `event.data` virando
  // texto visível.
  assert.ok(!/evento\.data\.(text|json)\(\)/.test(SW), 'o aviso não pode exibir conteúdo vindo do push');
  assert.match(SW, /notificationclick/);
  assert.match(SW, /pushsubscriptionchange/, 'o endereço de entrega muda sozinho; sem isto o celular para de tocar');
});

// ---------------------------------------------------------------------------
// As rotas, contra o servidor de verdade.

const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');

const JSON_H = { 'content-type': 'application/json' };
const INSCRICAO = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  chaves: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkQ', auth: 'tBHItJI5svbpez7KI4CC' },
};

async function servidorComVapid(t, { comVapid = true } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'oi' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
  const servicoDaSerena = criarServicoDaSerena({ repositorio });
  const atendimento = criarAtendimento({ repositorio, orquestrador, serena: servicoDaSerena });

  // A configuração do teste é montada por configuracaoDeTeste (não lê o
  // ambiente do processo): as chaves VAPID entram por ali.
  const { gerarChavesVapid } = require('../src/seguranca/webpush');
  const chaves = comVapid ? gerarChavesVapid() : { publica: '', privada: '' };
  const configuracao = configuracaoDeTeste({
    VAPID_PUBLIC_KEY: chaves.publica,
    VAPID_PRIVATE_KEY: chaves.privada,
    VAPID_SUBJECT: 'mailto:teste@exemplo',
  });

  const ambiente = await subirServidor({ repositorio, orquestrador, atendimento, servicoDaSerena, configuracao });
  t.after(() => ambiente.encerrar());
  return { ambiente, repositorio };
}

test('a rota devolve a chave pública e aceita a inscrição do aparelho', async (t) => {
  const { ambiente } = await servidorComVapid(t);

  const estado = await (await ambiente.pedir('/api/aparelhos')).json();
  assert.equal(estado.disponivel, true);
  assert.ok(estado.chave_publica, 'a tela precisa da chave pública para inscrever');
  assert.equal(estado.aparelhos, 0);

  const criada = await ambiente.pedir('/api/aparelhos', {
    method: 'POST', headers: JSON_H, body: JSON.stringify(INSCRICAO),
  });
  assert.equal(criada.status, 201, await criada.text());

  const depois = await (await ambiente.pedir('/api/aparelhos')).json();
  assert.equal(depois.aparelhos, 1);

  // O mesmo aparelho reinscrevendo não vira linha nova: o navegador troca o
  // endereço de tempos em tempos e reinscreve sozinho.
  await ambiente.pedir('/api/aparelhos', {
    method: 'POST', headers: JSON_H, body: JSON.stringify(INSCRICAO),
  });
  assert.equal((await (await ambiente.pedir('/api/aparelhos')).json()).aparelhos, 1);
});

test('endpoint que não é https é recusado', async (t) => {
  const { ambiente } = await servidorComVapid(t);

  for (const endpoint of ['http://push.exemplo/abc', 'javascript:alert(1)', 'nem-url', '']) {
    const resposta = await ambiente.pedir('/api/aparelhos', {
      method: 'POST', headers: JSON_H, body: JSON.stringify({ ...INSCRICAO, endpoint }),
    });
    assert.equal(resposta.status, 400, `${endpoint || '(vazio)'} deveria ser recusado`);
  }
});

test('sem a chave PRIVADA, a inscrição continua funcionando — é o papel da Vercel', async (t) => {
  // Este processo (o HTTP) inscreve aparelhos e não empurra nada: quem empurra
  // é o worker no VPS, que tem a privada. Exigir as duas aqui obrigaria a
  // espalhar o segredo por mais um lugar, sem necessidade.
  const { ambiente } = await servidorComVapid(t, { comVapid: false });

  const estado = await (await ambiente.pedir('/api/aparelhos')).json();
  assert.equal(estado.disponivel, true, 'a chave pública tem padrão no código — ela não é segredo');
  assert.ok(estado.chave_publica, 'a tela precisa da chave para inscrever');

  const aceita = await ambiente.pedir('/api/aparelhos', {
    method: 'POST', headers: JSON_H, body: JSON.stringify(INSCRICAO),
  });
  assert.equal(aceita.status, 201, 'inscrever não depende da chave privada');
});

test('desinscrever tira o aparelho, e o aparelho de outra pessoa não é alcançável', async (t) => {
  const { ambiente, repositorio } = await servidorComVapid(t);

  await ambiente.pedir('/api/aparelhos', {
    method: 'POST', headers: JSON_H, body: JSON.stringify(INSCRICAO),
  });

  // Inscrição de OUTRA pessoa, que a sessão atual não pode apagar.
  const outro = await repositorio.criarUsuario({
    nome: 'Outra', email: 'outra@exemplo', senhaHash: 'x', papel: 'atendente', situacao: 'ativo',
  });
  await repositorio.salvarInscricaoDeNotificacao({
    usuarioId: outro.id, endpoint: 'https://fcm.googleapis.com/fcm/send/da-outra', p256dh: 'p', auth: 'a',
  });

  const alheia = await ambiente.pedir('/api/aparelhos', {
    method: 'DELETE', headers: JSON_H,
    body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/da-outra' }),
  });
  assert.equal((await alheia.json()).removidas, 0, 'endpoint de outra pessoa não é apagável por aqui');
  assert.equal((await repositorio.listarInscricoesDeNotificacao(outro.id)).length, 1);

  const propria = await ambiente.pedir('/api/aparelhos', {
    method: 'DELETE', headers: JSON_H, body: JSON.stringify({ endpoint: INSCRICAO.endpoint }),
  });
  assert.equal((await propria.json()).removidas, 1);
});

test('o sino e o aviso no celular não se confundem de rota', () => {
  // Erro real desta implementação: uma substituição global trocou também as
  // chamadas do sino, e a central de notificações da tela parou de carregar.
  // São duas coisas diferentes com nomes parecidos — aqui elas ficam separadas.
  const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const HTTP_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');

  // O sino (notificações dentro da tela).
  assert.match(APP_JS, /const \{ total \} = await pedirJson\('\/api\/notificacoes'\)/);
  assert.match(APP_JS, /const \{ notificacoes \} = await pedirJson\('\/api\/notificacoes'\)/);
  assert.match(HTTP_JS, /\/\/ --- Central de notificações \(o sino do topo\) ---\s*\n\s*if \(rota === '\/api\/notificacoes'/);

  // O aviso no celular (aparelhos inscritos para push).
  assert.match(APP_JS, /pedirJson\('\/api\/aparelhos'\)/);
  assert.match(HTTP_JS, /if \(!rota\.startsWith\('\/api\/aparelhos'\)\) return false;/);
});

test('a chave pública tem padrão no código: a Vercel inscreve sem variável de ambiente', () => {
  // Ela é entregue a todo navegador que se inscreve — não é segredo. É isso que
  // permite a inscrição funcionar sem uma variável a mais no painel.
  const { carregarConfiguracao } = require('../src/config');
  const semNada = carregarConfiguracao({
    NODE_ENV: 'test',
    CRMCLINICA_JWT_SECRET: 'segredo-sintetico-de-teste-com-mais-de-32-caracteres',
  });

  assert.ok(semNada.avisos.vapidPublica, 'a pública precisa ter padrão');
  assert.equal(semNada.avisos.vapidPrivada, '', 'a privada NÃO pode ter padrão: ela assina o empurrão');

  // E a variável de ambiente continua ganhando, para trocar a chave sem mexer
  // no código.
  const comEnv = carregarConfiguracao({
    NODE_ENV: 'test',
    CRMCLINICA_JWT_SECRET: 'segredo-sintetico-de-teste-com-mais-de-32-caracteres',
    VAPID_PUBLIC_KEY: 'outra-chave-qualquer',
  });
  assert.equal(comEnv.avisos.vapidPublica, 'outra-chave-qualquer');
});
