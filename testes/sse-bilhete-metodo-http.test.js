'use strict';

// Achado do rollout de produção do PR #34 (2026-08-16): o bilhete de conexão
// do SSE de conversas nunca chegava — `GET /api/conversas/eventos/ticket`
// devolvia 405 em loop, a cada 5s, para sempre, em toda aba aberta.
//
// Causa raiz: `pedirJson` (public/app.js) lê `opcoes.metodo` (português) para
// decidir o verbo HTTP — `method: opcoes.metodo || 'GET'`. A chamada que pede
// o bilhete (`conectarEventosDeConversas`) passava `{ method: 'POST' }`, com
// a chave em INGLÊS. `opcoes.metodo` ficava `undefined`, caía no padrão
// 'GET', o servidor recusava (a rota só aceita POST —
// `src/servidor/http.js:1534`), e o `catch` de `conectarEventosDeConversas`
// reagendava a mesma tentativa fadada em 5s. Loop infinito, sem 500, sem
// duplicação, mas o "ao vivo" nunca ligava — o próprio requisito central da
// Pendência 4 deste hotfix.
//
// Esse bug já estava no código antes de qualquer migration/merge/deploy desta
// sessão (introduzido no commit d84fa44c, 2026-08-14, parte do PR #34 desde
// o início) — nenhuma suíte automatizada o pegou porque é um mismatch de
// chave de opções num `fetch` real de navegador; só apareceu ao abrir a
// aplicação de verdade e observar a rede.
//
// A prova aqui NÃO reproduz a chamada manualmente (isso provaria só que eu
// sei escrever `{ metodo: 'POST' }`, não que o arquivo real está certo).
// Em vez disso, extrai a linha literal do call site de public/app.js e a
// executa de verdade contra `pedirJson` (também extraído de verdade), com um
// `fetch` fake que só grava o método recebido — sem rede, sem servidor. Se
// alguém reintroduzir a chave errada (ou qualquer outra chave que `pedirJson`
// não leia), este teste falha sozinho, sem precisar saber o nome da chave de
// antemão.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extrairFonteDe(regex, mensagem) {
  const encontrado = APP_JS.match(regex);
  assert.ok(encontrado, mensagem);
  return encontrado[0];
}

test('a chamada real de bilhete de SSE em conectarEventosDeConversas dispara um fetch POST de verdade', async () => {
  const fontePedirJson = extrairFonteDe(
    /async function pedirJson\([\s\S]*?\n\}/,
    'public/app.js precisa declarar `pedirJson`',
  );

  // A linha literal do call site — não uma reprodução manual. Se o nome da
  // chave (ou a URL) mudar no arquivo real, é isto que muda aqui também.
  const fonteChamadaDoBilhete = extrairFonteDe(
    /pedirJson\('\/api\/conversas\/eventos\/ticket',\s*\{[^}]*\}\)/,
    'a chamada do bilhete de SSE precisa existir em public/app.js (procurada em conectarEventosDeConversas)',
  );

  const chamadasRegistradas = [];
  const contexto = {
    accessToken: 'token-de-teste',
    lerRefresh: () => null,
    renovarSessao: async () => false,
    fetch: async (caminho, opcoes) => {
      chamadasRegistradas.push({ caminho, metodo: opcoes?.method ?? 'GET' });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ticket: 'bilhete-de-teste', expira_em_ms: 30000 }),
      };
    },
  };
  vm.createContext(contexto);
  vm.runInContext(
    `${fontePedirJson}\nthis.__resultado = (${fonteChamadaDoBilhete});`,
    contexto,
  );
  await contexto.__resultado;

  assert.equal(chamadasRegistradas.length, 1, 'fetch precisa ter sido chamado exatamente uma vez');
  assert.equal(chamadasRegistradas[0].caminho, '/api/conversas/eventos/ticket');
  assert.equal(
    chamadasRegistradas[0].metodo,
    'POST',
    'a chamada real do bilhete de SSE precisa disparar um fetch POST — se cair para GET, ' +
      '/api/conversas/eventos/ticket devolve 405 e o SSE nunca conecta (loop de reconexão a cada 5s, para sempre)',
  );
});
