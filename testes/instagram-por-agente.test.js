'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizarComentariosInstagram } = require('../src/integracoes/instagram-webhook');
const { criarRoteadorDeInstagram } = require('../src/integracoes/instagram-envio');
const { criarServicoDeGatilhos } = require('../src/dominio/instagram-gatilhos');

// Instagram por agente (migration 049): a loja Alpins tem perfil próprio.
//
// A clínica e a loja chegam na MESMA URL de webhook — a Meta não separa por
// URL, só diz em `entry[].id` qual conta recebeu. O que estes testes protegem,
// em ordem de gravidade:
//
//   1. responder pela conta CERTA. Publicar a resposta da clínica no post da
//      loja (ou o contrário) é erro visível para o público;
//   2. a regra de um perfil não dispara no outro;
//   3. perfil desconhecido não é atendido pela conta da clínica "por
//      aproximação" — fica sem resposta, com rastro.

const CLINICA = '17841400000000001';
const ALPINS = '17841400000000002';

function eventoDeComentario(contaComercialId, texto, id = 'c1') {
  return {
    object: 'instagram',
    entry: [{
      id: contaComercialId,
      time: 1757000000,
      changes: [{
        field: 'comments',
        value: { id, text: texto, from: { id: '99887766', username: 'cliente.teste' }, media: { id: 'post1' } },
      }],
    }],
  };
}

const CONFIG = {
  accessToken: 'token-da-clinica',
  contaComercialId: CLINICA,
  apiVersion: 'v23.0',
  contas: [{ apelido: 'alpins', accessToken: 'token-da-loja', contaComercialId: ALPINS }],
};

// ---------------------------------------------------------------- webhook

test('o comentário carrega a conta que o recebeu', () => {
  const daClinica = normalizarComentariosInstagram(eventoDeComentario(CLINICA, 'quero agendar'), {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(daClinica.length, 1);
  assert.equal(daClinica[0].conta_comercial_id, CLINICA);

  const daLoja = normalizarComentariosInstagram(eventoDeComentario(ALPINS, 'qual o preço?'), {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(daLoja[0].conta_comercial_id, ALPINS,
    'sem isto, o comentário da loja seria tratado como se fosse da clínica');
});

test('cada perfil ignora o próprio comentário, não o do outro', () => {
  // A resposta pública que a automação da LOJA publica chega de volta como
  // comentário da loja. Antes, o corte comparava sempre com a conta da
  // clínica: a loja reagiria ao próprio comentário, em cadeia.
  const proprioDaLoja = {
    object: 'instagram',
    entry: [{
      id: ALPINS,
      time: 1757000000,
      changes: [{
        field: 'comments',
        value: { id: 'c9', text: 'oi, te chamei no direct!', from: { id: ALPINS }, media: { id: 'post1' } },
      }],
    }],
  };
  const saida = normalizarComentariosInstagram(proprioDaLoja, {
    contaComercialId: CLINICA, contas: CONFIG.contas,
  });
  assert.equal(saida.length, 0, 'o comentário da própria loja não pode reacionar a automação dela');
});

// ---------------------------------------------------------------- roteador

test('cada conta responde pelo próprio cliente', () => {
  const roteador = criarRoteadorDeInstagram(CONFIG, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });

  assert.equal(roteador.total, 2, 'clínica e loja');
  assert.ok(roteador.paraConta(CLINICA));
  assert.ok(roteador.paraConta(ALPINS));
  assert.notEqual(roteador.paraConta(CLINICA), roteador.paraConta(ALPINS), 'são clientes distintos');
  assert.equal(roteador.apelidoDaConta(ALPINS), 'alpins');
  assert.equal(roteador.apelidoDaConta(CLINICA), null, 'a clínica não tem apelido: é o perfil padrão');
});

test('conta desconhecida não cai na da clínica', () => {
  const roteador = criarRoteadorDeInstagram(CONFIG, {});
  assert.equal(roteador.paraConta('17841400000000999'), null,
    'responder pela conta errada publicaria a resposta da clínica no post de outro perfil');
  assert.equal(roteador.paraConta(null), null);
});

test('sem perfis extras, o comportamento é o de antes', () => {
  const roteador = criarRoteadorDeInstagram({ accessToken: 't', contaComercialId: CLINICA }, {});
  assert.equal(roteador.total, 1);
  assert.ok(roteador.paraConta(CLINICA));
});

// ---------------------------------------------------------------- gatilho

function repositorioFalso({ regras }) {
  const registros = [];
  const mensagens = [];
  return {
    registros,
    mensagens,
    async obterComentarioProcessado() { return null; },
    async listarRegrasDeGatilho({ agenteId }) {
      // Espelha a 049: `undefined` = todas; senão, só as do dono pedido.
      if (agenteId === undefined) return regras;
      return regras.filter((regra) => (regra.agente_id ?? null) === (agenteId ?? null));
    },
    async registrarComentarioProcessado(dados) { registros.push(dados); return { id: 1 }; },
    async encontrarOuCriarContato() { return { id: 10 }; },
    async encontrarOuCriarConversaAberta(contatoId, canal, opcoes) {
      mensagens.push({ tipo: 'conversa', agenteId: opcoes?.agenteId ?? null });
      return { id: 20 };
    },
    async registrarMensagem(conversaId, mensagem) { mensagens.push({ tipo: 'mensagem', ...mensagem }); },
    async salvarLead() { return { id: 30 }; },
    async obterAgente(id) { return { id, nome: 'Agente Alpins' }; },
    async registrarAuditoria() {},
  };
}

function envioFalso(nome) {
  const enviados = [];
  return {
    enviados,
    nome,
    async responderComentarioPublicamente(dados) { enviados.push({ tipo: 'publica', ...dados }); },
    async responderComentarioPrivadamente(dados) { enviados.push({ tipo: 'dm', ...dados }); },
  };
}

const REGRA_CLINICA = {
  id: 1, nome: 'Agendamento', palavra_gatilho: 'agendar', ativa: true, agente_id: null,
  mensagem_publica: 'Te chamamos no direct!', mensagem_dm: 'Olá! Vamos agendar sua consulta?', cta_whatsapp: false,
};
const REGRA_LOJA = {
  id: 2, nome: 'Preço', palavra_gatilho: 'preço, preco, valor', ativa: true, agente_id: 7,
  mensagem_publica: 'Respondemos no direct!', mensagem_dm: 'Oi! Sobre os valores da loja...', cta_whatsapp: false,
};

test('a regra da loja não dispara no post da clínica', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daClinica = envioFalso('clinica');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: daClinica });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c1', autorIgId: '99887766', texto: 'qual o preço?',
    agenteId: null, contaComercialId: CLINICA, envio: daClinica,
  });

  assert.equal(resultado.regra, null, 'a regra "Preço" é da loja: no perfil da clínica ela não existe');
  assert.equal(daClinica.enviados.length, 0, 'e nada foi publicado');
});

test('o comentário na loja é respondido pela loja, e a conversa nasce do agente', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daLoja = envioFalso('loja');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: envioFalso('clinica') });

  const resultado = await servico.processarComentario({
    comentarioIdExterno: 'c2', autorIgId: '99887766', texto: 'qual o preço?',
    agenteId: 7, contaComercialId: ALPINS, envio: daLoja,
  });

  assert.equal(resultado.regra.id, REGRA_LOJA.id);
  assert.equal(resultado.resposta_publica_enviada, true);
  assert.equal(resultado.dm_enviada, true);
  assert.equal(daLoja.enviados.length, 2, 'as duas ações saíram pela conta da loja');

  const conversa = repositorio.mensagens.find((m) => m.tipo === 'conversa');
  assert.equal(conversa.agenteId, 7, 'a conversa pertence ao agente da loja, não à clínica');

  const dm = repositorio.mensagens.find((m) => m.tipo === 'mensagem');
  assert.equal(dm.autor_nome, 'Agente Alpins', '"Serena" numa DM da loja confundiria cliente e equipe');

  const registro = repositorio.registros[0];
  assert.equal(registro.agenteId, 7);
  assert.equal(registro.contaComercialId, ALPINS);
});

test('o perfil da clínica segue assinando como Serena', async () => {
  const repositorio = repositorioFalso({ regras: [REGRA_CLINICA, REGRA_LOJA] });
  const daClinica = envioFalso('clinica');
  const servico = criarServicoDeGatilhos({ repositorio, instagramEnvio: daClinica });

  await servico.processarComentario({
    comentarioIdExterno: 'c3', autorIgId: '99887766', texto: 'quero agendar',
    agenteId: null, contaComercialId: CLINICA, envio: daClinica,
  });

  const dm = repositorio.mensagens.find((m) => m.tipo === 'mensagem');
  assert.equal(dm.autor_nome, 'Serena');
  const conversa = repositorio.mensagens.find((m) => m.tipo === 'conversa');
  assert.equal(conversa.agenteId, null, 'a conversa da clínica não ganha dono de agente');
});

// ---------------------------------------------------------------- sem perfil extra, nada muda

test('com um perfil só, o id que a Meta manda é ignorado', () => {
  // `entry[].id` e o INSTAGRAM_BUSINESS_ACCOUNT_ID configurado NÃO são
  // comprovadamente o mesmo identificador na API da Meta (o payload bruto não
  // fica guardado, então não dá para conferir no histórico). Rotear por ele
  // com um perfil só faria o comentário da clínica — que HOJE é respondido —
  // cair em "conta desconhecida" e ficar mudo. Por isso o roteamento só entra
  // quando alguém configura um segundo perfil.
  const soClinica = criarRoteadorDeInstagram({ accessToken: 't', contaComercialId: CLINICA }, {});
  assert.equal(soClinica.temPerfisExtras, false, 'sem contas extras, não há o que rotear');

  const comLoja = criarRoteadorDeInstagram(CONFIG, {});
  assert.equal(comLoja.temPerfisExtras, true, 'com a loja configurada, o roteamento passa a valer');
});

test('o filtro de auto-comentário sem perfis extras é o de antes', () => {
  // Mesmo evento, com e sem `contas`: o comportamento tem de ser idêntico.
  const eventoProprio = {
    object: 'instagram',
    entry: [{
      id: 'algum-id-que-a-meta-manda',
      time: 1757000000,
      changes: [{
        field: 'comments',
        value: { id: 'c7', text: 'resposta automática', from: { id: CLINICA }, media: { id: 'post1' } },
      }],
    }],
  };

  const antes = normalizarComentariosInstagram(eventoProprio, { contaComercialId: CLINICA });
  const depois = normalizarComentariosInstagram(eventoProprio, { contaComercialId: CLINICA, contas: [] });
  assert.equal(antes.length, 0, 'o comentário da própria clínica continua sendo ignorado');
  assert.equal(depois.length, antes.length, 'passar `contas: []` não muda nada');
});

// ---------------------------------------------------------------- achados da revisão

test('perfil conhecido pelo ambiente mas sem agente no CRM não é atendido', () => {
  // Achado A1: cair para `agenteId: null` publicaria as regras da CLÍNICA no
  // post da loja, assinadas pela loja. É a janela entre configurar as
  // variáveis (passo 4 do guia) e cadastrar o canal (passo 5).
  const http = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8',
  );
  assert.match(http, /if \(apelido && !agenteDoPerfil\) \{/,
    'perfil sem agente tem de ser recusado, não tratado como clínica');
  assert.match(http, /perfil_sem_agente/);
  assert.match(http, /obterAgentePorCanal\?\.\('instagram', comentario\.conta_comercial_id, \{ incluirInativos: true \}\)/,
    'canal desligado ainda diz de quem é o perfil');
});

test('a assinatura aceita o segredo de qualquer app configurado', () => {
  // Achado M2: `INSTAGRAM_<X>_APP_SECRET` era lido e nunca usado — um perfil
  // em outro app da Meta levaria 401 em todo evento.
  const http = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8',
  );
  assert.match(http, /const segredos = \[segredo, \.\.\.\(configuracao\.instagram\.contas \?\? \[\]\)\.map\(\(conta\) => conta\.appSecret\)\]/);
  assert.match(http, /\.some\(\(candidato\) => assinaturaValida\(\{/, 'basta um app assinar');
  assert.match(http, /responderJson\(res, 401, \{ erro: 'assinatura inválida' \}\)/,
    'e sem nenhum assinar, continua 401');
});

test('a regra pode nascer de um perfil, e o dono é conferido', async () => {
  // Achado A3: a 049 criou a coluna e nada sabia preenchê-la — a loja ficaria
  // muda, e cada comentário queimaria a idempotência com regra_id nulo.
  const criadas = [];
  const repositorio = {
    async obterAgente(id) { return id === 7 ? { id: 7, nome: 'Agente Alpins' } : null; },
    async criarRegraDeGatilho(dados) { criadas.push(dados); return { id: 1, ...dados }; },
  };
  const servico = criarServicoDeGatilhos({ repositorio });

  await servico.criarRegra({
    nome: 'Preço', palavraGatilho: 'preco', mensagemDm: 'Oi! Sobre os valores da loja...',
    mensagemPublica: 'Respondemos no direct!', agenteId: 7,
  });
  assert.equal(criadas[0].agenteId, 7, 'a regra nasce do perfil escolhido');

  await servico.criarRegra({
    nome: 'Agendar', palavraGatilho: 'agendar', mensagemDm: 'Vamos agendar sua consulta?',
    mensagemPublica: 'Te chamamos no direct!',
  });
  assert.equal(criadas[1].agenteId, null, 'sem perfil escolhido, a regra é da clínica');

  await assert.rejects(
    () => servico.criarRegra({
      nome: 'Orfa', palavraGatilho: 'teste', mensagemDm: 'Uma mensagem de teste aqui.',
      mensagemPublica: 'Outra mensagem.', agenteId: 999,
    }),
    (erro) => erro.codigo === 'agente_nao_encontrado',
    'regra apontando para agente inexistente nunca dispararia: recusa antes de gravar',
  );
});

test('a tela oferece o perfil e manda o dono junto', () => {
  const fsLocal = require('node:fs');
  const pathLocal = require('node:path');
  const html = fsLocal.readFileSync(pathLocal.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fsLocal.readFileSync(pathLocal.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.ok(html.includes('id="gatilho-perfil"'), 'o seletor de perfil precisa existir');
  assert.ok(html.includes('id="gatilho-perfil-campo" hidden'), 'e nascer escondido: com um perfil só, não se pergunta');
  assert.match(app, /campo\.hidden = comInstagram\.length === 0/,
    'só aparece quando há agente com canal de Instagram');
  assert.match(app, /agente_id: seletor\('#gatilho-perfil'\)\?\.value/,
    'e o dono vai junto ao salvar');
});
