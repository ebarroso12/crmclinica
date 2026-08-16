'use strict';

// Anexo de arquivo no chat, de ponta a ponta via HTTP: POST /anexos (prepara
// upload) e POST /mensagens com anexo (envia). Storage e canal são mocks —
// nenhuma chamada de rede real —, mas o contrato exercido (rotas, RBAC,
// validação, o que chega em atendimento/repositório) é o real.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

function orquestradorFalso() {
  return {
    disponivel: true,
    despacharEvento: async () => ({ resposta: 'Olá! Posso ajudar?' }),
    verificarSaude: async () => ({ estado: 'operacional' }),
  };
}

function storageFalso({ disponivel = true } = {}) {
  const chamadas = { upload: [], leitura: [] };
  return {
    disponivel,
    bucket: 'anexos-conversas',
    async gerarUploadAssinado(caminho) {
      chamadas.upload.push(caminho);
      return { urlDeUpload: `https://storage.falso/upload/${caminho}` };
    },
    async gerarLeituraAssinada(caminho) {
      chamadas.leitura.push(caminho);
      return `https://storage.falso/leitura/${caminho}`;
    },
    chamadas,
  };
}

function canalFalso() {
  const chamadas = { midia: [], texto: [] };
  return {
    disponivel: true,
    async enviar({ telefone, texto }) {
      chamadas.texto.push({ telefone, texto });
      return { identificador: 'evo-texto-1' };
    },
    async enviarMidia({ telefone, mediaUrl, tipo, legenda }) {
      chamadas.midia.push({ telefone, mediaUrl, tipo, legenda });
      return { identificador: 'evo-midia-1' };
    },
    chamadas,
  };
}

/** Sobe o servidor com uma conversa já existente e mocks controláveis de storage/canal. */
async function subirComConversa({ storage = storageFalso(), canal = canalFalso() } = {}) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, storage });

  await atendimento.receberMensagem({
    canal: 'whatsapp',
    estrategia_ia: 'crm_despacha',
    id_externo: 'wa:anexo-1',
    remetente: '5516999999999',
    nome: 'Marina Souza',
    texto: 'Oi, bom dia',
  });

  const app = await subirServidor({
    repositorio, atendimento, orquestrador, clienteStorage: storage,
    configuracao: configuracaoDeTeste(),
  });

  const [conversaId] = (await repositorio.listarConversas({})).map((c) => c.id);

  return { app, repositorio, storage, canal, conversaId };
}

test('POST /anexos: MIME fora da allowlist é recusado com 400, sem chamar o Storage', async (t) => {
  const { app, storage, conversaId } = await subirComConversa();
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversaId}/anexos`, {
    method: 'POST',
    body: JSON.stringify({ nome_arquivo: 'malware.exe', tipo_mime: 'application/x-msdownload', tamanho_bytes: 1000 }),
  });
  assert.equal(resposta.status, 400);
  assert.equal(storage.chamadas.upload.length, 0);
});

test('POST /anexos: tamanho acima do limite é recusado com 400', async (t) => {
  const { app, conversaId } = await subirComConversa();
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversaId}/anexos`, {
    method: 'POST',
    body: JSON.stringify({ nome_arquivo: 'foto.png', tipo_mime: 'image/png', tamanho_bytes: 999_999_999 }),
  });
  assert.equal(resposta.status, 400);
});

test('POST /anexos: sucesso devolve caminho prefixado pela conversa e URL de upload', async (t) => {
  const { app, storage, conversaId } = await subirComConversa();
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversaId}/anexos`, {
    method: 'POST',
    body: JSON.stringify({ nome_arquivo: 'exame ../../etc/passwd.png', tipo_mime: 'image/png', tamanho_bytes: 2048 }),
  });
  assert.equal(resposta.status, 200);
  const dados = await resposta.json();
  assert.equal(dados.tipo, 'imagem');
  assert.ok(dados.caminho.startsWith(`conversas/${conversaId}/`), `caminho deveria começar com conversas/${conversaId}/, veio: ${dados.caminho}`);
  // A sanitização do nome não deixa o path atravessar diretório mesmo que o
  // nome original tente (defesa em profundidade — MIME allowlist já barra a
  // extensão perigosa antes disso, mas o path traversal é um vetor separado).
  assert.ok(!dados.caminho.includes('..'), `caminho não pode conter "..": ${dados.caminho}`);
  assert.ok(!dados.caminho.includes('/etc/'), `caminho não pode ter atravessado diretório: ${dados.caminho}`);
  assert.equal(dados.upload_url, `https://storage.falso/upload/${dados.caminho}`);
  assert.equal(storage.chamadas.upload.length, 1);
});

test('POST /anexos: sem Storage configurado, devolve 503 (não 500, não sucesso falso)', async (t) => {
  const { app, conversaId } = await subirComConversa({ storage: storageFalso({ disponivel: false }) });
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversaId}/anexos`, {
    method: 'POST',
    body: JSON.stringify({ nome_arquivo: 'foto.png', tipo_mime: 'image/png', tamanho_bytes: 2048 }),
  });
  assert.equal(resposta.status, 503);
});

test('POST /mensagens: anexo com caminho de OUTRA conversa é recusado — não vira mensagem', async (t) => {
  const { app, repositorio, storage, canal } = await subirComConversa();

  // Uma segunda conversa, para gerar um caminho "legítimo" que pertence a ELA.
  const orquestrador = orquestradorFalso();
  const atendimento2 = criarAtendimento({ repositorio, orquestrador, canal, storage });
  await atendimento2.receberMensagem({
    canal: 'whatsapp', estrategia_ia: 'crm_despacha', id_externo: 'wa:anexo-2',
    remetente: '5516988888888', nome: 'Outro Paciente', texto: 'Oi',
  });
  const [conversaA, conversaB] = (await repositorio.listarConversas({})).map((c) => c.id).sort((a, b) => a - b);
  t.after(() => app.encerrar());

  // Caminho pertence à conversaB, mas a tentativa de responder é na conversaA.
  const resposta = await app.pedir(`/api/conversas/${conversaA}/mensagens`, {
    method: 'POST',
    body: JSON.stringify({ texto: '', anexo: { caminho: `conversas/${conversaB}/uuid-foto.png`, tipo: 'imagem', nome: 'foto.png' } }),
  });
  assert.equal(resposta.status, 400);
});

test('POST /mensagens: anexo válido grava mensagem com tipo/media_url e chama canal.enviarMidia', async (t) => {
  const { app, repositorio, canal, conversaId } = await subirComConversa();
  t.after(() => app.encerrar());

  const preparo = await app.pedir(`/api/conversas/${conversaId}/anexos`, {
    method: 'POST',
    body: JSON.stringify({ nome_arquivo: 'exame.pdf', tipo_mime: 'application/pdf', tamanho_bytes: 4096 }),
  });
  const { caminho, tipo, nome } = await preparo.json();

  const resposta = await app.pedir(`/api/conversas/${conversaId}/mensagens`, {
    method: 'POST',
    body: JSON.stringify({ texto: 'segue o exame', anexo: { caminho, tipo, nome } }),
  });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.enviada, true);
  assert.equal(corpo.mensagem.tipo, 'documento');
  assert.equal(corpo.mensagem.media_url, caminho, 'no banco, media_url guarda o PATH interno, não a URL assinada');

  assert.equal(canal.chamadas.midia.length, 1);
  assert.equal(canal.chamadas.midia[0].tipo, 'documento');
  assert.equal(canal.chamadas.midia[0].legenda, 'segue o exame');
  // A URL mandada à Evolution é a de LEITURA assinada, nunca o path cru.
  assert.equal(canal.chamadas.midia[0].mediaUrl, `https://storage.falso/leitura/${caminho}`);

  // E ao listar a thread, media_url já vem resolvido para leitura (o bucket é privado).
  const thread = await app.pedir(`/api/conversas/${conversaId}/mensagens`);
  const mensagens = await thread.json();
  const gravada = mensagens.find((m) => m.tipo === 'documento');
  assert.equal(gravada.media_url, `https://storage.falso/leitura/${caminho}`);
});

test('nota interna (privada) não aceita anexo', async (t) => {
  const { app, conversaId } = await subirComConversa();
  t.after(() => app.encerrar());

  const resposta = await app.pedir(`/api/conversas/${conversaId}/mensagens`, {
    method: 'POST',
    body: JSON.stringify({ texto: 'nota', privada: true, anexo: { caminho: `conversas/${conversaId}/x.png`, tipo: 'imagem' } }),
  });
  assert.equal(resposta.status, 400);
});
