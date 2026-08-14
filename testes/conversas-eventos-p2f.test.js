'use strict';

// P1-04, achado da auditoria desta sessão: o gate do segundo fator (em
// src/servidor/http.js, perto da linha 1444) só enxerga `usuario` — resolvido
// do cabeçalho `Authorization`. A rota `/api/conversas/eventos` (o fluxo ao
// vivo de conversas, por SSE) não recebe esse cabeçalho — `EventSource` do
// navegador não manda um — então `usuario` chega SEMPRE `null` ali, o gate
// passa direto, e só DEPOIS a identidade de verdade é resolvida a partir do
// token da querystring (`?token=`).
//
// Sem a checagem extra dentro da própria rota, uma conta com segundo fator
// pendente (master/admin, TOTP ainda não confirmado) conseguia abrir o fluxo
// ao vivo de conversas — mensagem de paciente — só passando o token na URL
// desta rota, driblando o mesmo gate que bloqueia QUALQUER outra rota da API
// para essa mesma conta.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste, autenticar } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

test('[p2f] segundo fator pendente: /api/conversas é recusado (referência de comportamento)', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'admin', master: true });
  t.after(() => app.encerrar());

  // A própria sessão já nasce com o token marcado p2f: true (TOTP não ativo).
  // `/api/auth/*` é a exceção declarada do gate (é lá que o TOTP se ativa) —
  // por isso a referência usa `/api/conversas`, não `/api/auth/sessao`.
  const resposta = await app.pedir('/api/conversas');
  assert.equal(resposta.status, 403);
  assert.equal((await resposta.json()).codigo, 'segundo_fator_pendente');
});

test('[p2f] segundo fator pendente: /api/conversas/eventos (SSE) também é recusado — não pode ser a exceção', async (t) => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'admin', master: true, autenticar: false });
  t.after(() => app.encerrar());

  // Sessão aberta manualmente (o helper padrão pularia a autenticação com
  // `autenticar: false`) — precisamos do access_token com p2f:true para
  // reproduzir exatamente a conta que o restante da API já recusa.
  const sessao = await autenticar({ base: app.base, repositorio, papel: 'admin', master: true });

  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?token=${encodeURIComponent(sessao.access_token)}`,
  );

  assert.equal(
    resposta.status, 403,
    'a rota de eventos ao vivo não pode deixar passar quem o resto da API recusa por segundo fator pendente',
  );
  assert.equal((await resposta.json()).codigo, 'segundo_fator_pendente');
});

test('[p2f] com TOTP confirmado, a mesma conta acessa normalmente o SSE', async (t) => {
  // Controle negativo: prova que a recusa acima é especificamente sobre p2f
  // pendente, não uma quebra geral da rota para contas master/admin.
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'atendente', master: false });
  t.after(() => app.encerrar());

  // Papel "atendente" (não master/admin) nunca ganha p2f — token sem a marca.
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?token=${encodeURIComponent(app.sessao.access_token)}`,
    { signal: controle.signal },
  );
  assert.equal(resposta.status, 200);
  controle.abort();
  await resposta.body?.cancel().catch(() => {});
});
