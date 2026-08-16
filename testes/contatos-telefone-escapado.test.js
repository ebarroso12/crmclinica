'use strict';

// Achado da auditoria adversarial (protocolo SRE, 2026-08-16): a lista de
// contatos (`carregarContatos`, public/app.js) escapa `contato.nome` mas
// não `contato.telefone` no mesmo template — inconsistência real, não
// hipótese.
//
// Por que importa: `contato.telefone` nasce de `evento.remetente` no
// webhook (src/dominio/atendimento.js:86). Via Evolution, o valor é
// normalizado por `normalizarTelefone()` (evolution-webhook.js:30-36) —
// regex `^\d{10,15}$`, só dígitos. Mas via ponte OpenClaw (assinatura HMAC),
// o mesmo campo passa só por `exigirTexto()` (src/contratos/evento.js:39-44)
// — checa não-vazio e limite de 120 caracteres, SEM restringir formato.
// Hoje isso não é explorável por um paciente comum (o remetente é atribuído
// pelo protocolo do WhatsApp, não digitável no texto da mensagem), mas é
// ausência de defesa em profundidade: um bug futuro na ponte, ou um
// adaptador novo que esqueça de normalizar, vira XSS imediato na tela de
// contatos — exatamente o padrão que este teste tranca.
//
// Prova: extrai o template literal REAL de `carregarContatos` (não uma
// reprodução manual) e o executa contra um `contato` fake com telefone
// malicioso, com `escapar` também extraído do fonte real.

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

/**
 * Executa o template literal real de `carregarContatos` (o `.map(...)`)
 * contra uma lista de contatos fake, com `escapar` de verdade — sem rede,
 * sem DOM além do que `escapar` precisa (um `document.createElement`
 * mínimo, mesmo padrão de public/app.js:3106-3110).
 */
function renderizarContatos(contatosFalsos) {
  const fonteEscapar = extrairFonteDe(
    /function escapar\([\s\S]*?\n\}/,
    'public/app.js precisa declarar `escapar`',
  );
  const fonteTemplate = extrairFonteDe(
    /dados\.contatos\.map\(\(contato\) => `[\s\S]*?`\)\.join\(''\)/,
    'o template de renderização de contatos precisa existir em carregarContatos (public/app.js)',
  );

  // DOM mínimo, só o suficiente para `escapar` (document.createElement +
  // textContent/innerHTML) e para Date/toLocaleDateString funcionarem.
  class ElementoFalso {
    constructor() { this._html = ''; this._texto = ''; }
    set textContent(valor) { this._texto = String(valor ?? ''); this._html = this._texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    get textContent() { return this._texto; }
    get innerHTML() { return this._html; }
  }
  const contexto = vm.createContext({
    document: { createElement: () => new ElementoFalso() },
    Date,
    __contatos: contatosFalsos,
  });
  const fonteTemplateComVariavelLocal = fonteTemplate.replace('dados.contatos', '__contatos');
  return vm.runInContext(`${fonteEscapar}\n(${fonteTemplateComVariavelLocal});`, contexto);
}

test('telefone malicioso não vira tag HTML executável na lista de contatos', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const html = renderizarContatos([{ id: 1, nome: 'Paciente Teste', telefone: PAYLOAD, excluido: false }]);

  assert.ok(
    !html.includes('<img'),
    `telefone não escapado permite tag <img> crua no HTML renderizado — html:\n${html}`,
  );
  assert.ok(
    html.includes('&lt;img') || html.includes('&amp;lt;img'),
    'o payload precisa aparecer escapado (entidade HTML), não desaparecer nem virar tag real',
  );
});

test('nome malicioso continua escapado (não regride — controle positivo)', () => {
  const PAYLOAD = '<script>alert(1)</script>';
  const html = renderizarContatos([{ id: 1, nome: PAYLOAD, telefone: '5511999999999', excluido: false }]);
  assert.ok(!html.includes('<script>'), 'nome precisa continuar escapado — este teste não pode regredir esse controle');
});
