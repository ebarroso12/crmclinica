'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

// "Toda vez que entro no CRM preciso dar Ctrl+Shift+R" (12/09/2026).
//
// O servidor já entregava o código novo; quem segurava era o cache do
// navegador. São duas defesas, e as duas precisam existir:
//
//   1. o HTML nunca sai do cache (`no-store`) — é ele que aponta para todo o
//      resto, e um HTML velho ignora qualquer arquivo novo;
//   2. quem passa o dia com a aba aberta recebe o aviso de versão nova, e o
//      clique recarrega DE VERDADE (reload puro pode reaproveitar o cache).

function cabecalhoDe(fonte) {
  const bloco = (VERCEL.headers ?? []).find((h) => h.source === fonte);
  const cache = (bloco?.headers ?? []).find((h) => h.key.toLowerCase() === 'cache-control');
  return cache?.value ?? null;
}

test('o HTML nunca é servido do cache', () => {
  for (const fonte of ['/', '/index.html']) {
    const valor = cabecalhoDe(fonte);
    assert.ok(valor, `falta cache-control para ${fonte}`);
    assert.match(valor, /no-store/, `${fonte} precisa de no-store: HTML velho ignora JS novo`);
  }
});

test('JS e CSS revalidam sempre, mas podem ser guardados', () => {
  const valor = cabecalhoDe('/(.*).(js|css)');
  assert.ok(valor, 'falta cache-control para js/css');
  assert.match(valor, /no-cache/, 'pergunta antes de usar (ETag responde 304 quando nada mudou)');
  assert.doesNotMatch(valor, /no-store/,
    'no-store aqui jogaria fora o arquivo a cada navegação, sem ganho — o ETag já resolve');
});

test('os cabeçalhos de segurança continuam de pé', () => {
  // O bloco de cache é acrescentado, não substitui o que já existia.
  const geral = (VERCEL.headers ?? []).find((h) => h.source === '/(.*)');
  assert.ok(geral, 'o bloco geral não pode ter sumido');
  const chaves = geral.headers.map((h) => h.key.toLowerCase());
  for (const esperado of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'strict-transport-security']) {
    assert.ok(chaves.includes(esperado), `perdeu o cabeçalho ${esperado}`);
  }
});

test('as regras de rota da Vercel não foram tocadas', () => {
  const destinos = (VERCEL.rewrites ?? []).map((r) => r.source);
  assert.ok(destinos.includes('/health'), '/health precisa continuar chegando na função');
  assert.ok(destinos.includes('/api/:caminho*'));
});

// ---------------------------------------------------------------- o aviso

test('o botão existe, nasce escondido e diz o que faz', () => {
  assert.match(HTML, /id="banner-atualizar" hidden/);
  assert.match(HTML, /Nova versão disponível/);
});

test('o aviso aparece quando o commit no ar difere do que esta aba carregou', () => {
  assert.match(APP_JS, /const temVersaoNova = Boolean\(saude\.commit\) && saude\.commit !== commitCarregadoNestaAba;/,
    'o commit é o que muda a cada deploy; `versao` só muda quando alguém lembra');
  // Dois lugares desde 13/09/2026: o do menu (computador) e o do topo do
  // conteúdo — no celular o menu vira faixa rolável e ninguém acha o botão lá.
  assert.match(APP_JS, /botao\.hidden = !temVersaoNova/);
  assert.match(APP_JS, /aviso\.hidden = !temVersaoNova/);
});

test('voltar para a aba também verifica — é quando a pessoa vai usar a tela', () => {
  assert.match(APP_JS, /visibilitychange/,
    'sem isto, quem fecha e volta no dia seguinte espera 5 minutos para ser avisado');
  assert.match(APP_JS, /document\.visibilityState === 'visible' && inboxIniciado/);
});

test('o clique recarrega de verdade, sem reaproveitar o cache', () => {
  // O recarregamento virou função nomeada (`atualizarAgora`) porque três botões
  // usam o mesmo caminho: o do menu, o do topo e o de Meu perfil.
  const inicio = APP_JS.indexOf('function atualizarAgora()');
  const funcao = APP_JS.slice(inicio, APP_JS.indexOf('\n}', inicio));
  assert.match(funcao, /searchParams\.set\('v'/, 'endereço novo obriga o navegador a buscar');
  assert.match(funcao, /window\.location\.replace/,
    'replace em vez de reload: não empilha no histórico nem repete no voltar');
  assert.ok(
    APP_JS.includes("seletor('#banner-atualizar')?.addEventListener('click', atualizarAgora)"),
    'o botão do menu continua ligado ao mesmo caminho',
  );
});

test('o parâmetro de recarga é limpo da barra depois de cumprir o papel', () => {
  assert.match(APP_JS, /limparMarcaDeRecarga/);
  assert.match(APP_JS, /url\.searchParams\.delete\('v'\)/);
  assert.match(APP_JS, /history\.replaceState/,
    'replaceState não cria entrada nova no histórico');
});

test('a versão no ar aparece no rodapé E em Meu perfil', () => {
  // O rodapé é onde se confere a olho no computador. Em Meu perfil porque o CSS
  // esconde o rodapé do menu em tela estreita — pelo celular não havia como
  // saber a versão em uso (relato de 13/09/2026).
  assert.match(APP_JS, /const versaoLegivel = `v\$\{saude\.versao\}/);
  assert.match(APP_JS, /rodape\.textContent = `crmclinica \$\{versaoLegivel\}`/);
  assert.match(APP_JS, /definirTexto\('#perfil-versao', `crmclinica \$\{versaoLegivel\}`\)/);
  assert.match(APP_JS, /saude\.commit\.slice\(0, 7\)/, 'o commit curto identifica o deploy');
  assert.match(HTML, /id="rodape-versao"/);
  assert.match(HTML, /id="perfil-versao"/);
});
