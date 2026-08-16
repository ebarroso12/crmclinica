'use strict';

// P1-04, achado da auditoria da sessão anterior: o gate do segundo fator (em
// src/servidor/http.js, perto da linha 1444) só enxerga `usuario` — resolvido
// do cabeçalho `Authorization`. A rota `/api/conversas/eventos` (o fluxo ao
// vivo de conversas, por SSE) não recebe esse cabeçalho — `EventSource` do
// navegador não manda um. NA ÉPOCA, a identidade real era resolvida de um
// `?token=` na querystring, DEPOIS do gate — driblando a checagem.
//
// Nesta sessão (Pendência 4, reconstrução do chat ao vivo), o token de
// sessão saiu da URL de vez: a conexão agora troca um BILHETE de uso único
// (POST /api/conversas/eventos/ticket, autenticado normalmente) por acesso
// ao stream. Como a emissão do bilhete é uma rota comum, o gate de p2f já a
// alcança sem nenhuma checagem extra — a proteção contra o bypass original
// continua valendo, só que por construção, não por uma segunda checagem
// dentro da rota SSE (ver o cabeçalho de src/servidor/eventos-conversas.js).

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

test('[p2f] segundo fator pendente: nem consegue pedir o bilhete de SSE — não pode ser a exceção', async (t) => {
  // Achado desta sessão (reconstrução do chat ao vivo, Pendência 4): o token
  // não vai mais na URL — a rota agora exige um bilhete de uso único, pedido
  // por POST /api/conversas/eventos/ticket (autenticado normalmente). Essa
  // rota começa com /api/ e não com /api/auth/, então passa pelo MESMO gate
  // geral de p2f (linha ~1444 de http.js) que qualquer outra rota — uma
  // conta com segundo fator pendente nunca chega a ter um bilhete válido, e
  // por construção nunca alcança o SSE.
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'admin', master: true, autenticar: false });
  t.after(() => app.encerrar());

  // Sessão aberta manualmente (o helper padrão pularia a autenticação com
  // `autenticar: false`) — precisamos do access_token com p2f:true para
  // reproduzir exatamente a conta que o restante da API já recusa.
  const sessao = await autenticar({ base: app.base, repositorio, papel: 'admin', master: true });

  const resposta = await fetch(`${app.base}/api/conversas/eventos/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessao.access_token}` },
  });

  assert.equal(
    resposta.status, 403,
    'o bilhete do chat ao vivo não pode ser emitido para quem o resto da API recusa por segundo fator pendente',
  );
  assert.equal((await resposta.json()).codigo, 'segundo_fator_pendente');
});

test('[p2f] papel sem 2FA obrigatório (atendente) nunca ganha p2f — acessa o SSE normalmente', async (t) => {
  // Controle negativo FRACO: só prova que um papel que nunca recebe `p2f`
  // (não é master/admin) continua acessando. NÃO prova que um master/admin
  // com TOTP confirmado acessa — ver o teste seguinte, que é o controle de
  // verdade. (Achado da auditoria independente desta sessão: o teste
  // original desta suíte usava só este caso e o rotulava como prova de que
  // "TOTP confirmado continua acessando" — não era; nenhum teste cobria de
  // fato uma conta master/admin com TOTP ativo.)
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'atendente', master: false });
  t.after(() => app.encerrar());

  const { ticket } = await (await app.pedir('/api/conversas/eventos/ticket', { method: 'POST' })).json();
  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`,
    { signal: controle.signal },
  );
  assert.equal(resposta.status, 200);
  controle.abort();
  await resposta.body?.cancel().catch(() => {});
});

test('[p2f] master com TOTP CONFIRMADO acessa o SSE normalmente — a recusa é só sobre p2f pendente', async (t) => {
  // Controle negativo de verdade: mesma conta (master, 2FA obrigatório
  // ligado) que o primeiro teste desta suíte recusa — mas depois de ativar o
  // segundo fator pelo fluxo real (preparar → confirmar), o que zera `p2f`
  // no PRÓXIMO token emitido (ver src/seguranca/sessoes.js:39-42). Prova que
  // a recusa é especificamente sobre segundo fator pendente, não uma quebra
  // geral da rota para contas privilegiadas.
  const { gerarCodigo } = require('../src/seguranca/totp');
  const { SENHA_DE_TESTE } = require('./auxiliar');

  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const app = await subirServidor({ repositorio, configuracao, papel: 'admin', master: true });
  t.after(() => app.encerrar());

  // `/api/auth/segundo-fator*` é a exceção do gate — é exatamente por onde
  // uma conta com p2f pendente ativa o TOTP, com o token que já tem.
  const preparo = await (await app.pedir('/api/auth/segundo-fator', { method: 'POST' })).json();
  const confirmado = await app.pedir('/api/auth/segundo-fator/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codigo: gerarCodigo(preparo.segredo) }),
  });
  assert.equal(confirmado.status, 200, 'confirmação do TOTP precisa suceder para o teste fazer sentido');

  // Login de novo: só agora `totp_ativo` é true no momento da emissão do
  // token, então só este novo access_token vem sem `p2f`.
  const login = await fetch(`${app.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: app.sessao.email, senha: SENHA_DE_TESTE, codigo: gerarCodigo(preparo.segredo),
    }),
  });
  assert.equal(login.status, 200, 'login com o código do segundo fator precisa suceder');
  const { access_token: accessToken } = await login.json();

  const respostaDoBilhete = await fetch(`${app.base}/api/conversas/eventos/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(respostaDoBilhete.status, 200, 'sem p2f pendente, o bilhete precisa ser emitido normalmente');
  const { ticket } = await respostaDoBilhete.json();

  const controle = new AbortController();
  const resposta = await app.pedirSemAuth(
    `/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}`,
    { signal: controle.signal },
  );
  assert.equal(resposta.status, 200, 'master com TOTP confirmado não pode ser recusado pela mesma checagem de p2f');
  controle.abort();
  await resposta.body?.cancel().catch(() => {});
});
