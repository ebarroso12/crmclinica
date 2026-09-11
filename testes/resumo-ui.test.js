'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Tela Usuários do resumo por equipe (docs/RESUMOS.md). Guardas estruturais: o
// comportamento das rotas está em testes/resumo-usuarios-rotas.test.js. NÃO
// prova o comportamento no navegador.

const RAIZ = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');

function funcaoDoApp(nome) {
  const inicio = APP_JS.search(new RegExp(`^(?:async\\s+)?function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `function ${nome} precisa existir em app.js`);
  const proxima = APP_JS.slice(inicio + 1).search(/^(?:async\s+)?function\s/m);
  return APP_JS.slice(inicio, proxima < 0 ? undefined : inicio + 1 + proxima);
}

test('cada usuário tem a chave "Recebe resumos" e o aviso de quem deveria receber e não recebe', () => {
  const linha = funcaoDoApp('montarLinhaDeUsuario');
  assert.match(linha, /textoDoResumo\.textContent = 'Recebe resumos';/);
  assert.match(linha, /agirNoUsuario\(usuario\.id, 'recebe-resumo', \{ recebe_resumo: caixaDoResumo\.checked \}\)/);
  assert.match(linha, /'Não recebe resumos: sem WhatsApp no cadastro'/);
  assert.match(linha, /'Não recebe resumos: WhatsApp sem autorização'/);
  // A chave vale também para o master: pausar o próprio resumo não é mudar a conta.
  assert.ok(linha.indexOf("'recebe-resumo'") > linha.lastIndexOf('if (!usuario.master) {'), 'fora do bloco do master');
  assert.ok(linha.indexOf('acoes.append(recebeResumo);') > linha.indexOf("for (const [rotulo, situacaoNova, classe] of botoes)"));
});

test('painel "Quem recebe os resumos": carrega com a lista, só texto, número já mascarado pelo servidor', () => {
  assert.match(HTML, /<article class="card" id="cartao-resumos" hidden>/);
  assert.match(HTML, /<div id="painel-resumos" aria-live="polite"><\/div>/);
  assert.match(funcaoDoApp('carregarUsuarios'), /carregarPainelDeResumos\(\);/);

  const painel = funcaoDoApp('carregarPainelDeResumos');
  assert.match(painel, /pedirJson\('\/api\/usuarios\/resumos'\)/);
  assert.ok(!/innerHTML/.test(painel), 'nome de pessoa e de agente nunca por innerHTML');
  assert.match(painel, /item\.textContent = `\$\{destino\.nome\} — \$\{destino\.whatsapp \?\? ''\}`;/);
  assert.match(painel, /'Ninguém recebe este resumo\.'/);
  assert.match(painel, /agente sem WhatsApp ativo: o resumo não sai/);

  const posicao = HTML.indexOf('cartao-resumos');
  const vizinhanca = HTML.slice(posicao - 200, posicao + 900);
  assert.ok(!/\son[a-z]+=/i.test(vizinhanca), 'handler inline');
  assert.ok(!/\sstyle=/i.test(vizinhanca), 'style inline');
});
