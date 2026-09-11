'use strict';

// Tela de Agentes (docs/AGENTES.md). Sem DOM nesta suíte (`node --test`, sem
// jsdom), a prova é estrutural — mesmo padrão de testes/botoes-orfaos.test.js:
// lê index.html e app.js e confere que as peças se encontram (ids, abas,
// campos de configuração, rotas chamadas, confirmação antes de ligar).
//
// NÃO prova que a tela funciona no navegador: clique, preenchimento e resposta
// da API só um teste manual ou automação de navegador comprovam.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONFIGURACOES_PADRAO } = require('../src/dominio/agentes/regras');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function secaoDeAgentes() {
  const secao = HTML.match(/<section id="agentes" class="tela"[\s\S]*?<\/section>/)?.[0];
  assert.ok(secao, 'a seção #agentes precisa existir em index.html');
  return secao;
}

function blocoDeAgentes() {
  const inicio = APP_JS.indexOf('// Agentes configuráveis (docs/AGENTES.md)');
  const fim = APP_JS.indexOf('// Contatos: a base de pacientes');
  assert.ok(inicio >= 0 && fim > inicio, 'o bloco de agentes precisa existir em app.js, antes do de contatos');
  return APP_JS.slice(inicio, fim);
}

const ABAS = ['teste', 'horario', 'perfil', 'treinamentos', 'trabalho', 'configuracoes', 'inatividade', 'canais'];

test('o menu tem Agentes escondido por padrão e liberado só por agentes:ler', () => {
  assert.match(HTML, /<li id="item-agentes" hidden>\s*<button type="button" data-tela="agentes">/);
  assert.match(APP_JS, /seletor\('#item-agentes'\)/);
  assert.match(APP_JS, /itemAgentes\.hidden = !podeFazer\('agentes:ler'\)/);
});

test('a tela está registrada em TITULOS e abrirTela carrega os agentes', () => {
  assert.match(APP_JS, /agentes: 'Agentes',/);
  assert.match(APP_JS, /if \(tela === 'agentes'\) carregarAgentes\(\);/);
});

test('cada aba do editor tem o seu painel, e só um painel começa visível', () => {
  const secao = secaoDeAgentes();
  for (const aba of ABAS) {
    assert.match(secao, new RegExp(`data-aba-agente="${aba}"`), `aba ${aba}`);
    assert.match(secao, new RegExp(`data-painel-agente="${aba}"`), `painel ${aba}`);
  }
  const paineis = secao.match(/<[^>]*data-painel-agente="[^"]+"[^>]*>/g);
  assert.equal(paineis.length, ABAS.length);
  assert.equal(paineis.filter((tag) => !/\shidden\b/.test(tag)).length, 1, 'só o perfil nasce aberto');
});

test('todo campo de CONFIGURACOES_PADRAO tem controle na aba Configurações', () => {
  const secao = secaoDeAgentes();
  for (const chave of Object.keys(CONFIGURACOES_PADRAO)) {
    assert.match(secao, new RegExp(`id="agente-cfg-${chave}"`), `falta o controle de ${chave}`);
  }
  // E o app.js lê as oito chaves booleanas pelo mesmo nome.
  for (const [chave, valor] of Object.entries(CONFIGURACOES_PADRAO)) {
    if (typeof valor === 'boolean') assert.ok(blocoDeAgentes().includes(`'${chave}'`), `app.js não lê ${chave}`);
  }
});

test('todo id que o bloco de agentes procura existe no HTML', () => {
  const bloco = blocoDeAgentes();
  const ids = new Set([...bloco.matchAll(/seletor\('#([\w-]+)'\)/g)].map((achado) => achado[1]));
  assert.ok(ids.size > 20, 'o teste precisa enxergar os seletores do bloco');
  for (const id of ids) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} é usado em app.js mas não existe em index.html`);
  }
});

test('nenhum botão da tela de agentes nasce órfão', () => {
  for (const botao of secaoDeAgentes().match(/<button[^>]*>/g)) {
    const ligado = /\sid="/.test(botao) || /\sdata-[\w-]+="/.test(botao) || /type="submit"/.test(botao);
    assert.ok(ligado, `botão sem id, data-* ou submit: ${botao}`);
  }
});

test('a tela chama todas as rotas da API de agentes', () => {
  const bloco = blocoDeAgentes();
  assert.ok(bloco.includes("pedirJson('/api/agentes')"));
  assert.ok(bloco.includes("pedirJson('/api/agentes', {"));
  for (const trecho of [
    '/treinamentos', '/inatividade', '/canais', '/teste', '/comportamento/', '/restaurar',
    '/operacao`', '/whatsapp`', '/whatsapp/conectar`', '/pausar`', '/retomar`', "'/api/agentes/aguardando'",
  ]) {
    assert.ok(bloco.includes(trecho), `a tela não usa ${trecho}`);
  }
  assert.ok(bloco.includes("metodo: 'DELETE'"));
  assert.ok(bloco.includes("metodo: 'PUT'"));
});

/** Trecho do bloco de agentes a partir de um marcador, até o próximo `seletor('#…')?.addEventListener`. */
function tratadorDe(marcador) {
  const bloco = blocoDeAgentes();
  const inicio = bloco.indexOf(marcador);
  assert.ok(inicio >= 0, `falta o tratador: ${marcador}`);
  const proximo = bloco.indexOf("?.addEventListener('", inicio + marcador.length);
  return bloco.slice(inicio, proximo < 0 ? undefined : proximo);
}

test('retomar o agente pede confirmação que cita a resposta dupla do GPTMaker ANTES de chamar a API', () => {
  const retomar = tratadorDe("seletor('#agente-retomar')?.addEventListener('click'");
  const confirmacao = retomar.indexOf('window.confirm(');
  const chamada = retomar.indexOf('/retomar`');
  assert.ok(confirmacao >= 0 && chamada > confirmacao, 'a confirmação vem antes da chamada');
  assert.match(retomar, /GPTMaker/);
  assert.match(retomar, /resposta dupla/);
});

test('pausar pede confirmação e manda o motivo opcional', () => {
  const pausar = tratadorDe("seletor('#agente-pausar')?.addEventListener('click'");
  assert.ok(pausar.indexOf('window.confirm(') >= 0 && pausar.indexOf('window.confirm(') < pausar.indexOf('/pausar`'));
  assert.match(pausar, /motivo: seletor\('#agente-pausa-motivo'\)/);
});

test('a página do agente segue o desenho da Serena: estado, aguardando, WhatsApp, controle e então as abas', () => {
  const secao = secaoDeAgentes();
  const ordem = [
    'id="agente-op-agente"', 'id="agente-op-whatsapp"', 'id="agente-op-entrega"', 'id="agente-op-aguardando"',
    'id="agente-aguardando"', 'id="agente-whatsapp-card"', 'id="agente-controle"',
    'data-aba-agente="teste"', 'data-aba-agente="horario"', 'data-aba-agente="perfil"', 'data-aba-agente="treinamentos"',
  ].map((trecho) => {
    const posicao = secao.indexOf(trecho);
    assert.ok(posicao >= 0, `falta ${trecho}`);
    return posicao;
  });
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, 'a ordem dos blocos segue a tela da Serena');

  for (const rotulo of [
    'Aguardando você', 'WhatsApp do agente', 'Controle da automação', 'Pausar agente', 'Retomar agente',
    'Testar o agente', 'Horário de atendimento', 'Comportamento no ar', 'Versões', 'Treinamentos',
  ]) {
    assert.ok(secao.includes(rotulo), `rótulo ausente: ${rotulo}`);
  }
});

test('o painel de operação recarrega ao abrir o agente e o selo do menu conta quem aguarda', () => {
  const bloco = blocoDeAgentes();
  const abrir = bloco.slice(bloco.indexOf('async function abrirAgente('), bloco.indexOf('function selecionarAbaDoAgente('));
  assert.match(abrir, /carregarOperacaoDoAgente\(\)/);
  assert.match(HTML, /data-tela="agentes">[^<]*<span[^>]*>◈<\/span> Agentes <b class="contador" id="contador-agentes"[^>]*hidden>/);
  assert.match(APP_JS, /iniciarSeloDeAgentes\(\);/, 'o selo começa junto com a aplicação');
  assert.match(bloco, /pedirJson\('\/api\/agentes\/aguardando'\)/);
});

// ------------------------------------------- B2: painel nunca mostra outro agente

test('B2: trocar de agente zera o painel e desabilita o Controle antes de pedir a operação nova', () => {
  const abrir = funcaoDoApp('abrirAgente');
  const zerar = abrir.indexOf('zerarOperacaoDoAgente();');
  const zerarWhatsapp = abrir.indexOf('zerarWhatsappDoAgente();');
  const carregar = abrir.indexOf('carregarOperacaoDoAgente();');
  assert.ok(zerar >= 0 && zerarWhatsapp >= 0, 'abrir outro agente zera operação e WhatsApp');
  assert.ok(zerar < carregar && zerarWhatsapp < carregar, 'zera antes de pedir de novo');
  assert.match(funcaoDoApp('zerarOperacaoDoAgente'), /desabilitarControleDoAgente\(\);/);
  const desabilitar = funcaoDoApp('desabilitarControleDoAgente');
  for (const id of ['#agente-pausar', '#agente-retomar', '#agente-pausa-motivo']) {
    assert.ok(desabilitar.includes(`'${id}'`), `desabilita ${id}`);
  }
  assert.match(funcaoDoApp('desenharOperacaoDoAgente'), /\.disabled = false/, 'só a operação do agente aberto reabilita');
});

test('B2: a operação é desenhada assim que chega, sem esperar o WhatsApp, e resposta velha é descartada', () => {
  const carregar = funcaoDoApp('carregarOperacaoDoAgente');
  assert.doesNotMatch(carregar, /allSettled/, 'nada de esperar os dois pedidos juntos');
  assert.match(carregar, /\/operacao`\)\s*\.then\(\(dados\) => \{ if \(vale\(\)\) desenharOperacaoDoAgente\(dados\); \}\)/);
  assert.match(carregar, /\.catch\(\(erro\) => \{ if \(vale\(\)\) mostrarFalhaDaOperacaoDoAgente\(erro\); \}\)/);
  assert.match(carregar, /\/whatsapp`\)\s*\.then\(\(dados\) => \{ if \(vale\(\)\) desenharWhatsappDoAgente\(dados\); \}\)/);
  assert.match(carregar, /const vale = \(\) => pedido === carregarOperacaoDoAgente\.pedido/,
    'descarta resposta de pedido que não é o mais novo');
  assert.match(carregar, /Number\(agenteAberto\.agente\.id\) === id/, 'descarta resposta de outro agente');
});

test('B2: falha da operação mostra erro e deixa o Controle desabilitado, sem dados antigos', () => {
  const falha = funcaoDoApp('mostrarFalhaDaOperacaoDoAgente');
  assert.match(falha, /zerarOperacaoDoAgente\(\);/);
  assert.match(falha, /pintarEstado\('#agente-op-agente', 'Indisponível', 'ruim'\)/);
  assert.match(falha, /desabilitarControleDoAgente\(\);/);
});

test('B2: pausar e retomar só reabilitam o botão quando a chamada falha', () => {
  for (const marcador of ["seletor('#agente-pausar')?.addEventListener('click'", "seletor('#agente-retomar')?.addEventListener('click'"]) {
    const tratador = tratadorDe(marcador);
    assert.doesNotMatch(tratador, /finally \{\s*botao\.disabled = false;/, 'no sucesso quem reabilita é a operação nova');
    assert.match(tratador, /catch \(erro\) \{[\s\S]*botao\.disabled = false;/);
  }
});

test('B6: sem código e sem QR, a tela diz indisponível e aponta o manager da Evolution', () => {
  const secao = secaoDeAgentes();
  const aviso = secao.match(/<p[^>]*id="agente-whatsapp-sem-codigo"[^>]*>[\s\S]*?<\/p>/)?.[0];
  assert.ok(aviso, 'o aviso de indisponível existe no HTML');
  assert.match(aviso, /\shidden\b/, 'nasce escondido');
  assert.match(aviso, /manager da Evolution/, 'aponta o caminho alternativo');
  assert.match(secao, /<p[^>]*id="agente-whatsapp-instrucao"/, 'a instrução do celular tem id para sumir sem código');

  const pareamento = funcaoDoApp('desenharPareamentoDoAgente');
  assert.doesNotMatch(pareamento, /resultado\.codigo_pareamento \|\| 'use o QR abaixo'/, 'não promete QR que não veio');
  assert.match(pareamento, /resultado\.codigo_pareamento \|\| \(qrValido \? 'use o QR abaixo' : 'indisponível'\)/);
  assert.match(pareamento, /seletor\('#agente-whatsapp-sem-codigo'\)\.hidden = temCaminho;/);
  assert.match(pareamento, /seletor\('#agente-whatsapp-instrucao'\)\.hidden = !resultado\.codigo_pareamento;/);
});

test('o QR do pareamento só entra na tela como data URL PNG, por propriedade do img', () => {
  const bloco = blocoDeAgentes();
  assert.match(bloco, /\/\^data:image\\\/png;base64,\[A-Za-z0-9\+\/=\]\+\$\/\.test\(resultado\.qr\)/);
  assert.match(bloco, /qr\.src = resultado\.qr/);
  assert.doesNotMatch(bloco, /innerHTML[^;]*resultado\.qr/);
});

test('a conversa aguardando abre na tela Conversas, sem filtro que a esconda', () => {
  const bloco = blocoDeAgentes();
  const inicio = bloco.indexOf('async function abrirConversaDoAgente(');
  assert.ok(inicio >= 0);
  const funcao = bloco.slice(inicio, bloco.indexOf('\n}\n', inicio));
  assert.match(funcao, /filaAtual = 'todos'/);
  assert.match(funcao, /abrirTela\('conversas'\)/);
  assert.match(funcao, /abrirConversa\(conversaId\)/);
});

test('a lista e a pílula dizem Atendendo/Pausado, os mesmos nomes do Controle da automação', () => {
  const bloco = blocoDeAgentes();
  assert.match(bloco, /const ROTULO_STATUS_AGENTE = \{ ativo: 'Atendendo', treinamento: 'Em treinamento', desativado: 'Pausado' \};/);
  assert.doesNotMatch(bloco, /'Desativado'/, 'a tela não mistura "Desativado" com "Pausado"');
});

test('o status saiu do formulário do perfil: ligar e desligar é só pelo Controle da automação', () => {
  assert.doesNotMatch(secaoDeAgentes(), /id="agente-status"/);
  const perfil = tratadorDe("seletor('#agente-aba-perfil')?.addEventListener('submit'");
  assert.doesNotMatch(perfil, /\bstatus\b/, 'salvar o comportamento não pode mudar o status');
});

test('texto dinâmico em atributo usa escaparAtributo, nunca escapar (que não escapa aspas)', () => {
  const bloco = blocoDeAgentes();
  assert.ok(bloco.includes('function escaparAtributo('));
  assert.doesNotMatch(bloco, /="\$\{escapar\(/, 'escapar() dentro de atributo deixa aspas passarem');
  assert.match(bloco, /value="\$\{escaparAtributo\(acao\.instrucao/);
  assert.match(bloco, /value="\$\{escaparAtributo\(canal\.instancia/);
});

test('a tela de agentes não aninha <section>: blocos internos são div com role="region"', () => {
  // Um <section> interno fechava cedo o recorte da tela (regex até o primeiro
  // </section>) e escondia do teste metade dos ids — pego ao montar o painel.
  const inicio = HTML.indexOf('<section id="agentes" class="tela"');
  const fim = HTML.indexOf('<section id="contatos" class="tela"');
  assert.ok(inicio >= 0 && fim > inicio);
  assert.equal((HTML.slice(inicio, fim).match(/<section\b/g) ?? []).length, 1);
});

test('a seção não tem script, estilo ou manipulador inline (CSP estrita)', () => {
  const secao = secaoDeAgentes();
  assert.doesNotMatch(secao, /<script/i);
  assert.doesNotMatch(secao, /\sstyle="/i);
  assert.doesNotMatch(secao, /\son[a-z]+="/i);
});

/**
 * Nomes de função declarados no nível superior de um script clássico (sem
 * módulo). Num script assim, a ÚLTIMA declaração com o mesmo nome vence em
 * silêncio — foi o que quebrou a tela: a `desenharConversaDeTeste` do
 * laboratório da Serena sobrescrevia a dos agentes, e abrir um agente lançava
 * "Cannot read properties of undefined (reading 'length')".
 */
function funcoesDuplicadas(fonte) {
  const contagem = new Map();
  for (const achado of fonte.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
    contagem.set(achado[1], (contagem.get(achado[1]) ?? 0) + 1);
  }
  return [...contagem].filter(([, vezes]) => vezes > 1).map(([nome, vezes]) => `${nome} (${vezes}x)`);
}

test('o detector de função duplicada pega o caso que quebrou a tela', () => {
  const comOBug = [
    'function desenharConversaDeTeste() {', '  return 1;', '}',
    'async function outra() {}',
    'function desenharConversaDeTeste(mensagens) {', '  return mensagens.length;', '}',
  ].join('\n');
  assert.deepEqual(funcoesDuplicadas(comOBug), ['desenharConversaDeTeste (2x)']);
});

test('app.js não declara a mesma função de nível superior duas vezes', () => {
  assert.deepEqual(funcoesDuplicadas(APP_JS), [], 'a declaração de baixo sobrescreve a de cima em silêncio');
});

test('abrir um agente desenha a conversa de teste DO AGENTE, não a do laboratório da Serena', () => {
  const bloco = blocoDeAgentes();
  assert.match(bloco, /function desenharConversaDeTesteDoAgente\(\)/);
  assert.doesNotMatch(bloco, /desenharConversaDeTeste\(/, 'o bloco de agentes não chama a função da Serena');
});

// ------------------------------------------------ inbox: de quem é a conversa

// ------------------------- BN1: código de pareamento nunca aparece em outro agente

test('BN1: o código de pareamento só é desenhado se o agente aberto ainda é o que pediu', () => {
  const gerar = tratadorDe("seletor('#agente-whatsapp-form')?.addEventListener('submit'");
  const guardar = gerar.indexOf('const id = Number(agenteAberto.agente.id);');
  const pedir = gerar.indexOf('/api/agentes/${id}/whatsapp/conectar');
  const conferir = gerar.indexOf('Number(agenteAberto.agente.id) !== id');
  const desenhar = gerar.indexOf('desenharPareamentoDoAgente(resultado);');
  assert.ok(guardar >= 0 && guardar < pedir, 'guarda o agente antes de pedir o código');
  assert.ok(conferir > pedir && conferir < desenhar, 'confere o agente aberto antes de desenhar o código');
});

function funcaoDoApp(nome) {
  const inicio = APP_JS.search(new RegExp(`^(?:async\\s+)?function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `function ${nome} precisa existir em app.js`);
  const proxima = APP_JS.slice(inicio + 1).search(/^(?:async\s+)?function\s/m);
  return APP_JS.slice(inicio, proxima < 0 ? undefined : inicio + 1 + proxima);
}

test('a linha do inbox mostra o selo do agente antes dos outros selos', () => {
  const linha = funcaoDoApp('montarLinhaDaLista');
  const seloAgente = linha.indexOf('conversa.agente_nome');
  const seloHumano = linha.indexOf('conversa.assumida_por_humano');
  assert.ok(seloAgente >= 0, 'a linha precisa ler agente_nome');
  assert.ok(seloAgente < seloHumano, 'o selo do agente vem primeiro');
  assert.match(linha, /selo\.className = 'etiqueta agente'/);
  assert.match(linha, /selo\.textContent = conversa\.agente_nome/, 'nome do agente por textContent, nunca innerHTML');
});

test('o inbox filtra por quem atende e o seletor existe no HTML', () => {
  assert.match(HTML, /<select id="filtro-agente-conversas"[^>]*hidden>/);
  assert.match(HTML, /<option value="clinica">/);
  const carregar = funcaoDoApp('carregarConversas');
  assert.match(carregar, /parametros\.set\('agente', agente\)/);
  assert.match(APP_JS, /seletor\('#filtro-agente-conversas'\)\?\.addEventListener\('change', carregarConversas\)/);
  assert.match(funcaoDoApp('prepararFiltroDeAgentesDaConversa'), /podeFazer\('agentes:ler'\)/);
});

test('conversa de agente transferida (assumida e sem responsável) mostra "Assumir" — achado M1', () => {
  const abrir = funcaoDoApp('abrirConversa');
  assert.match(abrir, /const agenteSemResponsavel = Boolean\(conversa\.agente_id\) && conversa\.assumida_por_humano && !conversa\.atribuido_a;/);
  assert.match(abrir, /seletor\('\.acao\[data-acao="assumir"\]'\)\.hidden = conversa\.assumida_por_humano && !agenteSemResponsavel;/);
  assert.match(abrir, /seletor\('\.acao\[data-acao="liberar"\]'\)\.hidden = !conversa\.assumida_por_humano;/,
    '"Devolver à IA" segue a regra de antes');
});

test('conversa de agente não é assinada nem avisada como Serena', () => {
  assert.match(funcaoDoApp('desenharThread'), /agenteDaConversaAberta \|\| 'Serena'/);
  const abrir = funcaoDoApp('abrirConversa');
  assert.match(abrir, /agenteDaConversaAberta = conversa\.agente_nome \|\| null/);
  assert.match(abrir, /Atendida pelo \$\{agenteDaConversaAberta\}/);
  assert.match(funcaoDoApp('desenharFicha'), /atendida pelo \$\{conversa\.agente_nome\}/);
});

test('o teste de agente não reaproveita os rótulos dos botões órfãos removidos', () => {
  const bloco = blocoDeAgentes();
  for (const rotulo of ['Nova tarefa', 'Nova conversa', 'Novo lead']) {
    assert.ok(!bloco.includes(rotulo), `"${rotulo}" não pode aparecer no bloco de agentes`);
  }
});
