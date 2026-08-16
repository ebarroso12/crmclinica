'use strict';

// Achado P2 da auditoria adversarial (protocolo SRE, 2026-08-16): sem
// limite, um usuário autenticado pode gerar bilhetes de SSE em loop —
// exatamente o sintoma do bug corrigido em 20cfeba (405 em loop a cada 5s,
// para sempre, antes da correção do method/metodo). Cada bilhete grava uma
// linha em `conversas_eventos_tickets`, sem função de limpeza — crescimento
// de armazenamento sem teto, barato de disparar.
//
// Limite: 60 bilhetes por minuto por usuário (janela deslizante), decidido
// como generoso o bastante para múltiplas abas reconectando de verdade
// durante uma queda de rede (cada aba tenta a cada 5s = ~12/min sozinha) —
// só barra loop indefinido ou abuso deliberado.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

async function pedirTicket(app, sessao) {
  return fetch(`${app.base}/api/conversas/eventos/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessao.access_token}` },
  });
}

test('a 61ª emissão de bilhete no mesmo minuto, para o mesmo usuário, é recusada com 429', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'atendente', master: false });
  t.after(() => app.encerrar());
  const sessao = app.sessao;

  const respostas = [];
  for (let i = 0; i < 61; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    respostas.push(await pedirTicket(app, sessao));
  }

  const statusCodes = respostas.map((r) => r.status);
  const sucessos = statusCodes.filter((s) => s === 200).length;
  const recusados = statusCodes.filter((s) => s === 429).length;

  assert.equal(sucessos, 60, `as primeiras 60 emissões precisam suceder — obtido ${sucessos}`);
  assert.equal(recusados, 1, `a 61ª emissão precisa ser recusada com 429 — obtido ${recusados} recusa(s)`);
  assert.equal(statusCodes[60], 429, 'especificamente a 61ª chamada (índice 60) precisa ser a recusada');

  const corpoRecusado = await respostas[60].json();
  assert.match(corpoRecusado.erro, /demais|limite/i, 'o erro precisa explicar que é limite de taxa, não outro tipo de falha');
});

test('duas contas diferentes têm limites independentes — uma não consome o teto da outra', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'atendente', master: false });
  t.after(() => app.encerrar());
  const atendenteA = app.sessao;
  const atendenteB = await app.entrarComo('atendente');

  // Esgota o limite de A.
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await pedirTicket(app, atendenteA);
  }
  const respostaAEstourada = await pedirTicket(app, atendenteA);
  assert.equal(respostaAEstourada.status, 429, 'A precisa estar no limite');

  // B, conta diferente, ainda não pediu nenhum bilhete — não pode ser afetado.
  const respostaB = await pedirTicket(app, atendenteB);
  assert.equal(respostaB.status, 200, 'o limite é por usuário — B não pode ser bloqueado pelo consumo de A');
});

test('emissão normal (bem abaixo do limite) continua funcionando sem fricção', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const app = await subirServidor({ repositorio, configuracao: configuracaoDeTeste(), papel: 'atendente', master: false });
  t.after(() => app.encerrar());

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resposta = await pedirTicket(app, app.sessao);
    assert.equal(resposta.status, 200, `emissão ${i + 1} de 5 (bem abaixo do limite de 60) precisa suceder`);
  }
});
