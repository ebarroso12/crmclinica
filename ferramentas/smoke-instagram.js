#!/usr/bin/env node
'use strict';

// Smoke do gatilho de Instagram, ponta a ponta e sem tocar a Meta.
//
//   npm run smoke-instagram
//
// Sobe o servidor de verdade (o mesmo `criarAplicacao` da produção), semeia as
// regras de `bin/semear-instagram.js`, manda comentários assinados na rota real
// do webhook e IMPRIME o que teria saído para a Graph API — URL, corpo e tudo.
//
// Por que existe: teste unitário prova lógica isolada; este prova o caminho.
// Foi escrito depois de 05/09, quando o Instagram recebia 15 comentários e não
// respondia nenhum — e nenhuma peça isolada acusava nada de errado.
//
// A Graph API é interceptada em `globalThis.fetch` ANTES de a aplicação subir,
// que é quando `criarClienteInstagramEnvio` captura a referência. Nada sai para
// a internet: chamada a graph.instagram.com é registrada e respondida aqui.

const crypto = require('node:crypto');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { REGRAS } = require('../bin/semear-instagram');

const SEGREDO = 'segredo-sintetico-do-app-do-instagram-com-mais-de-32-caracteres';
const CONTA = '17841400000000000';
const WHATSAPP = '+55 16 99743-3914';

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const vermelho = (t) => `\x1b[31m${t}\x1b[0m`;
const cinza = (t) => `\x1b[90m${t}\x1b[0m`;

// ------------------------------------------------------- Graph API de mentira
const fetchReal = globalThis.fetch;
const chamadas = [];

globalThis.fetch = async (url, opcoes = {}) => {
  const alvo = String(url);
  if (!alvo.includes('graph.instagram.com')) return fetchReal(url, opcoes);

  const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
  chamadas.push({ url: alvo, corpo, autorizacao: opcoes.headers?.authorization ?? null });

  const json = alvo.endsWith('/replies')
    ? { id: `reply-${chamadas.length}` }
    : { recipient_id: 'psid-sintetico', message_id: `mid.${chamadas.length}` };

  return new Response(JSON.stringify(json), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

// Só depois do stub: `subirServidor` monta a aplicação, e é na montagem que o
// cliente do Instagram guarda a referência de fetch.
const { subirServidor, configuracaoDeTeste } = require('../testes/auxiliar');

function comentario({ id, texto, autor, username }) {
  return {
    object: 'instagram',
    entry: [{
      id: CONTA,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'comments',
        value: { id, text: texto, from: { id: autor, username }, media: { id: 'post-1' } },
      }],
    }],
  };
}

async function mandar(app, corpo) {
  const bruto = JSON.stringify(corpo);
  const assinatura = `sha256=${crypto.createHmac('sha256', SEGREDO).update(bruto).digest('hex')}`;
  const resposta = await app.pedirSemAuth('/api/canais/instagram/eventos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinatura },
    body: bruto,
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

let falhas = 0;
function conferir(descricao, condicao, detalhe = '') {
  if (condicao) {
    console.log(`${verde('  OK  ')} ${descricao}`);
  } else {
    falhas += 1;
    console.log(`${vermelho(' FALHA')} ${descricao}${detalhe ? cinza(` — ${detalhe}`) : ''}`);
  }
}

async function main() {
  const repositorio = criarRepositorioEmMemoria();
  for (const regra of REGRAS) await repositorio.criarRegraDeGatilho(regra);

  const configuracao = configuracaoDeTeste({
    INSTAGRAM_ACCESS_TOKEN: 'token-sintetico',
    INSTAGRAM_APP_SECRET: SEGREDO,
    INSTAGRAM_BUSINESS_ACCOUNT_ID: CONTA,
    INSTAGRAM_API_VERSION: 'v23.0',
    WHATSAPP_BUSINESS_PHONE: WHATSAPP,
  });

  const app = await subirServidor({ repositorio, configuracao, autenticar: false });

  try {
    // ------------------------------------------------ 1. "quero agendar"
    console.log(`\n${cinza('1) comentário no post: "Oi doutor, quero agendar uma consulta"')}`);
    chamadas.length = 0;
    const um = await mandar(app, comentario({
      id: 'comentario-1', texto: 'Oi doutor, quero agendar uma consulta',
      autor: 'ig-ana', username: 'ana.souza',
    }));

    conferir('webhook aceito (HTTP 200)', um.status === 200, `status ${um.status}`);
    conferir('a regra "Agendamento" foi a que bateu',
      um.corpo?.regra?.nome === 'Agendamento', JSON.stringify(um.corpo));
    conferir('resposta pública enviada', um.corpo?.resposta_publica_enviada === true);
    conferir('DM enviada', um.corpo?.dm_enviada === true);

    const publica = chamadas.find((c) => c.url.endsWith('/replies'));
    const dm = chamadas.find((c) => c.url.endsWith('/messages'));

    conferir('resposta pública vai para POST /{comment-id}/replies',
      publica?.url === 'https://graph.instagram.com/v23.0/comentario-1/replies', publica?.url);
    conferir('corpo da resposta pública usa o campo `message`',
      typeof publica?.corpo?.message === 'string' && publica.corpo.message.length > 0);
    conferir('DM vai para POST /{IG_ID}/messages (não /me/messages)',
      dm?.url === `https://graph.instagram.com/v23.0/${CONTA}/messages`, dm?.url);
    conferir('DM endereça por comment_id (private reply)',
      dm?.corpo?.recipient?.comment_id === 'comentario-1', JSON.stringify(dm?.corpo?.recipient));
    conferir('DM leva o link do WhatsApp da clínica',
      String(dm?.corpo?.message?.text ?? '').includes('https://wa.me/5516997433914'));
    conferir('Bearer no cabeçalho', dm?.autorizacao === 'Bearer token-sintetico');

    console.log(cinza('\n  --- resposta pública que sairia ---'));
    console.log(cinza(`  ${publica?.corpo?.message}`));
    console.log(cinza('\n  --- DM que sairia ---'));
    console.log(cinza(`  ${String(dm?.corpo?.message?.text ?? '').split('\n').join('\n  ')}`));

    const conversas = await repositorio.listarConversas({});
    const mensagens = await repositorio.listarMensagens(conversas[0].id);
    conferir('virou contato, conversa e lead no CRM',
      conversas.length === 1 && conversas[0].canal === 'instagram');
    conferir('o histórico grava o texto que a pessoa recebeu, com o link',
      mensagens[0]?.conteudo === dm?.corpo?.message?.text);

    // ------------------------------------------ 2. comentário sem gatilho
    console.log(`\n${cinza('2) comentário no post: "parabéns doutor, que post lindo"')}`);
    chamadas.length = 0;
    const dois = await mandar(app, comentario({
      id: 'comentario-2', texto: 'parabéns doutor, que post lindo',
      autor: 'ig-joao', username: 'joao',
    }));
    conferir('cai na regra geral em vez de ficar sem resposta',
      dois.corpo?.regra?.nome === 'Todo comentário', JSON.stringify(dois.corpo));
    conferir('respondeu publicamente', dois.corpo?.resposta_publica_enviada === true);
    console.log(cinza(`\n  --- resposta pública ---\n  ${chamadas.find((c) => c.url.endsWith('/replies'))?.corpo?.message}`));

    // ------------------------------------------------- 3. lote com dois
    console.log(`\n${cinza('3) a Meta manda DOIS comentários na mesma chamada')}`);
    chamadas.length = 0;
    const lote = comentario({ id: 'comentario-3', texto: 'quero marcar', autor: 'ig-c', username: 'c' });
    lote.entry[0].changes.push({
      field: 'comments',
      value: { id: 'comentario-4', text: 'qual o horario?', from: { id: 'ig-d', username: 'd' }, media: { id: 'post-1' } },
    });
    const tres = await mandar(app, lote);
    conferir('os DOIS comentários do lote foram processados',
      tres.corpo?.comentarios === 2, JSON.stringify(tres.corpo));
    conferir('saíram duas respostas públicas e duas DMs',
      chamadas.filter((c) => c.url.endsWith('/replies')).length === 2
      && chamadas.filter((c) => c.url.endsWith('/messages')).length === 2);

    // ---------------------------------------------------- 4. idempotência
    console.log(`\n${cinza('4) a Meta reentrega o comentário 1 (webhook duplicado)')}`);
    chamadas.length = 0;
    const quatro = await mandar(app, comentario({
      id: 'comentario-1', texto: 'Oi doutor, quero agendar uma consulta',
      autor: 'ig-ana', username: 'ana.souza',
    }));
    conferir('reentrega não responde de novo', quatro.corpo?.ja_processado === true);
    conferir('nenhuma chamada nova à Graph API', chamadas.length === 0, `${chamadas.length} chamada(s)`);

    // ------------------------------------------------------------ métricas
    const metricas = await repositorio.metricasInstagram();
    console.log(`\n${cinza('métricas da tela de Instagram depois do smoke:')}`);
    console.log(cinza(`  processados ${metricas.total_comentarios} · com gatilho ${metricas.com_gatilho} `
      + `· respostas públicas ${metricas.resposta_publica_enviada} · DMs ${metricas.dm_enviada}`));
  } finally {
    await app.encerrar();
  }

  console.log(falhas === 0
    ? verde('\nSmoke do Instagram: tudo passou.\n')
    : vermelho(`\nSmoke do Instagram: ${falhas} verificação(ões) falharam.\n`));
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(vermelho(`smoke falhou: ${erro.stack}`));
  process.exit(1);
});
