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

const ABAS = ['teste', 'horario', 'perfil', 'treinamentos', 'trabalho', 'configuracoes', 'inatividade', 'canais', 'equipe'];

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
  assert.match(HTML, /data-tela="agentes">[^<]*<span[^>]*>☰<\/span> Todos os agentes <b class="contador" id="contador-agentes"[^>]*hidden>/);
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

test('o inbox separa por abas Clínica | agente (migration 047), no lugar do seletor antigo', () => {
  assert.ok(!HTML.includes('filtro-agente-conversas'), 'o seletor "Todas / Só da clínica" saiu');
  assert.match(HTML, /<div class="abas abas-escopo" id="abas-escopo-conversas" role="tablist"[^>]*hidden><\/div>/);
  const carregar = funcaoDoApp('carregarConversas');
  assert.match(carregar, /parametros\.set\('agente', escopoDaListaDeConversas\)/);
  assert.match(APP_JS, /seletor\('#abas-escopo-conversas'\)\?\.addEventListener\('click'/);
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

// ------------------------------------------- grupo AGENTES do menu (Serena + agentes)

test('o menu tem um grupo AGENTES com a Serena e o ponto de ancoragem dos agentes', () => {
  assert.match(HTML, /<p class="divisor" id="grupo-agentes">AGENTES<\/p>/);
  assert.match(HTML, /<ul aria-labelledby="grupo-agentes" id="menu-agentes">/);
  const grupo = HTML.match(/<ul aria-labelledby="grupo-agentes" id="menu-agentes">[\s\S]*?<\/ul>/)?.[0];
  assert.ok(grupo, 'o grupo AGENTES precisa existir');
  assert.match(grupo, /data-tela="serena"/, 'a Serena mora no grupo dos agentes');
  assert.match(grupo, /id="item-agentes"/, 'e o item da lista é a âncora dos itens por agente');
  assert.doesNotMatch(
    HTML.match(/<ul aria-labelledby="grupo-controle">[\s\S]*?<\/ul>/)?.[0] ?? '',
    /data-tela="serena"|id="item-agentes"/,
    'nada de agente sobrou no grupo CONTROLE',
  );
});

test('desenharMenuDeAgentes recria os itens sem duplicar e sem HTML de texto do banco', () => {
  const funcao = funcaoDoApp('desenharMenuDeAgentes');
  assert.match(funcao, /querySelectorAll\('\[data-agente-menu\]'\)\) antigo\.remove\(\)/,
    'os itens antigos saem antes de inserir os novos — agente apagado não fica no menu');
  assert.match(funcao, /grupo\.insertBefore\(item, ancora\)/, 'os itens entram antes de "Todos os agentes"');
  assert.match(funcao, /botao\.append\(icone, /, 'o nome vai como nó de texto (append), nunca como innerHTML');
  assert.doesNotMatch(funcao, /innerHTML/, 'nada de innerHTML com dado de agente no menu');
  assert.match(funcao, /botao\.title = nome/, 'o nome inteiro fica no title: o visível é truncado em 24');
  assert.match(funcao, /nome\.length > 24\s*\?\s*`\$\{nome\.slice\(0, 23\)\}…`/,
    'o corte em 24 É a proteção: sem o número aqui, um corte em 240 passaria e a lateral de 232px voltaria a transbordar');
});

test('o ponto âmbar do menu só aparece quando o agente não está atendendo, e o estado vai em texto junto', () => {
  const funcao = funcaoDoApp('desenharMenuDeAgentes');
  assert.match(funcao, /if \(agente\.status !== 'ativo'\) \{/);
  assert.match(funcao, /aviso\.className = 'aviso-menu'/);
  assert.match(funcao, /aviso\.setAttribute\('aria-hidden', 'true'\)/, 'o ponto é decoração');
  assert.match(funcao, /estado\.className = 'oculto-visual'/);
  assert.match(funcao, /ROTULO_STATUS_AGENTE\[agente\.status\]/,
    'quem diz "Pausado" é o texto, não a cor: title não é lido por leitor de tela nem por teclado');
});

test('redesenhar o menu não tira o foco de quem navega por teclado', () => {
  const funcao = funcaoDoApp('desenharMenuDeAgentes');
  // A leitura do activeElement tem de estar na MESMA linha da declaração: com
  // `const focado = null` cedo e o activeElement lido depois da remoção, o
  // teste de ordem abaixo passaria e o foco continuaria se perdendo.
  assert.match(funcao, /const focado = document\.activeElement\?\.dataset\?\.abrirAgenteMenu/,
    'guarda quem estava focado, lendo o activeElement na própria declaração');
  const guarda = funcao.indexOf('const focado');
  const remove = funcao.indexOf('antigo.remove()');
  const devolve = funcao.indexOf('.focus()');
  assert.ok(guarda >= 0 && guarda < remove && devolve > remove,
    'guarda quem estava focado ANTES de remover os itens e devolve o foco depois de recriar');
});

test('item de agente nasce escondido para quem não vê a clínica', () => {
  assert.match(
    funcaoDoApp('desenharMenuDeAgentes'),
    /if \(escopoAtual && !veClinica\(\)\) item\.hidden = true;/,
    'escopo já lido e sem clínica: o item não pode nascer visível',
  );
});

test('só o agente aberto fica marcado no menu — abrirTela não acende todos de uma vez', () => {
  const abrirTela = funcaoDoApp('abrirTela');
  assert.match(abrirTela, /botao\.dataset\.tela === tela && !botao\.dataset\.abrirAgenteMenu/,
    'os itens por agente ficam de fora do destaque genérico da tela');
  const destacar = funcaoDoApp('destacarAgenteNoMenu');
  assert.match(destacar, /botao\.dataset\.abrirAgenteMenu === alvo/);
  assert.match(destacar, /removeAttribute\('aria-current'\)/);
  assert.match(funcaoDoApp('abrirAgente'), /destacarAgenteNoMenu\(dados\.agente\.id\)/);
});

test('clicar no agente pelo menu não deixa o agente anterior em voo', () => {
  const delegado = APP_JS.match(/seletor\('#menu-agentes'\)\?\.addEventListener\([\s\S]*?\}\);/)?.[0];
  assert.ok(delegado, 'o clique do menu é delegado, porque os itens nascem depois da página');
  const zera = delegado.indexOf('agenteAberto = null;');
  const abre = delegado.indexOf("abrirTela('agentes')");
  assert.ok(zera >= 0 && abre > zera,
    'zera antes de abrir a tela: senão carregarAgentes reabre o agente anterior e a tela troca sozinha');
  assert.match(delegado, /abrirAgente\(botao\.dataset\.abrirAgenteMenu\)/);
});

test('a lista da tela Agentes começa pela Serena, com o mesmo estado do botão de parada', () => {
  const lista = funcaoDoApp('desenharListaDeAgentes');
  assert.match(lista, /innerHTML = linhaDaSerena\(\) \+ agentes/,
    'a Serena abre a lista também quando há outros agentes, não só no caso vazio');
  assert.ok(lista.includes('${linhaDaSerena()}<li class="vazio">'), 'e continua na lista sem nenhum outro agente');
  assert.match(lista, /desenharMenuDeAgentes\(agentes\)/, 'a mesma carga alimenta o menu');
  const linha = funcaoDoApp('linhaDaSerena');
  assert.match(linha, /data-abrir-serena="1"/, '"Abrir" leva para a tela da Serena');
  assert.match(linha, /data-pilula-serena/);
  assert.match(APP_JS, /if \(evento\.target\.closest\('\[data-abrir-serena\]'\)\) \{\s*abrirTela\('serena'\);/);
  assert.match(funcaoDoApp('desenharParadaDeEmergencia'), /serenaNoAr = ativa;\s*desenharEstadoDaSerenaNaLista\(\);/,
    'parar ou religar a Serena atualiza a linha da lista');
  const estado = funcaoDoApp('desenharEstadoDaSerenaNaLista');
  assert.match(estado, /pilula\.hidden = false;/, 'a pílula existe desde o começo e só aparece quando o estado é conhecido');
  assert.doesNotMatch(linha, /desligada/,
    'Serena parada não pode ser a linha mais apagada da tela: é o estado que mais precisa ser visto');
});

test('o menu nasce com os agentes: carregarAgentes roda na abertura da sessão, só com permissão', () => {
  assert.match(funcaoDoApp('mostrarAplicacao'), /if \(podeFazer\('agentes:ler'\)\) carregarAgentes\(\);/,
    'dentro de mostrarAplicacao, não solto em qualquer canto do arquivo');
});

test('quem só lê a Serena também vê o estado dela na lista', () => {
  const sincronizar = funcaoDoApp('sincronizarParadaDeEmergencia');
  assert.match(sincronizar, /const podeGerenciar = podeFazer\('serena:gerenciar'\);/);
  assert.match(sincronizar, /botao\.hidden = !podeGerenciar;/, 'sem permissão some o botão, não a leitura');
  assert.match(sincronizar, /if \(!podeGerenciar && !\(podeFazer\('serena:ler'\) && podeFazer\('agentes:ler'\)\)\) return;/,
    'o gestor (serena:ler + agentes:ler) precisa do estado para a linha da Serena; o atendente não vê aquela lista, então não pergunta');
  assert.match(sincronizar, /if \(podeGerenciar\) desenharParadaDeEmergencia\(true\);/,
    'na falha, "armado" vale para o botão; para quem só lê, nada é afirmado');
  // Sem re-tentativa, uma falha de rede na abertura deixaria a linha da Serena
  // sem pílula até alguém recarregar a página inteira.
  assert.match(funcaoDoApp('carregarAgentes'), /if \(serenaNoAr === null\) sincronizarParadaDeEmergencia\(\);/,
    'abrir a tela de agentes com o estado ainda desconhecido pergunta de novo');
});

test('a pílula da Serena não afirma estado antes de conhecê-lo', () => {
  const linha = funcaoDoApp('linhaDaSerena');
  assert.match(linha, /const desconhecido = serenaNoAr === null;/);
  assert.match(linha, /\$\{desconhecido \? ' hidden' : ''\}/,
    'estado desconhecido não pode sair da tela como "Parada": a pílula existe, mas escondida');
  assert.match(funcaoDoApp('desenharEstadoDaSerenaNaLista'), /if \(!pilula \|\| serenaNoAr === null\) return;/,
    'e só é revelada quando o estado chega');
});

test('"Todos os agentes" volta para a lista em vez de piscar', () => {
  const handler = APP_JS.match(/seletor\('#item-agentes button'\)\?\.addEventListener\([\s\S]*?\}\);/)?.[0];
  assert.ok(handler, 'o item da lista precisa de comportamento próprio: abrirTela sozinho não fecha o editor');
  assert.match(handler, /agenteAberto = null;/);
  assert.match(handler, /editor\.hidden = true;/);
  assert.match(handler, /destacarAgenteNoMenu\(null\)/);
  const fechar = APP_JS.match(/seletor\('#agente-fechar'\)\?\.addEventListener\([\s\S]*?\}\);/)?.[0];
  assert.match(fechar, /destacarAgenteNoMenu\(null\)/, 'fechar o editor também devolve o destaque à lista');
});

test('"Todos os agentes" fica marcado quando é ele o destino, e só então', () => {
  const destacar = funcaoDoApp('destacarAgenteNoMenu');
  assert.match(destacar, /if \(alvo\) lista\.removeAttribute\('aria-current'\);/,
    'com um agente aberto, quem está marcado é o agente');
  assert.match(destacar, /else if \(seletor\('#agentes'\)\?\.hidden === false\) lista\.setAttribute\('aria-current', 'page'\);/,
    'sem agente aberto, só marca se a tela de agentes for a que está aberta');
});

test('recarregar a lista não abre o mesmo agente duas vezes', () => {
  const carregar = funcaoDoApp('carregarAgentes');
  assert.match(carregar, /const abertoAoEntrar = agenteAberto\?\.agente\?\.id \?\? null;/);
  assert.match(carregar, /if \(abertoAoEntrar && agenteAberto\?\.agente\?\.id === abertoAoEntrar\) await abrirAgente\(abertoAoEntrar\);/,
    'só reabre quem já estava aberto quando a carga começou: senão o clique no menu pedia o mesmo agente duas vezes');
});

test('o rótulo invisível do contador concorda em número', () => {
  const funcao = funcaoDoApp('atualizarSeloDeAgentes');
  assert.match(funcao, /total === 1/, '"1 clientes" não pode chegar ao leitor de tela');
  assert.match(funcao, /cliente de agente aguardando a equipe/);
  assert.match(funcao, /clientes de agentes aguardando a equipe/);
});

// ------------------------------------------- o que a guarda de reabertura NAO pode quebrar

test('toda recarga legítima da lista continua reabrindo o agente aberto', () => {
  // A guarda `abertoAoEntrar` existe para o clique no menu, que dispara a carga
  // da lista e a abertura do agente ao mesmo tempo. Ela não pode ter custado as
  // recargas que acontecem DEPOIS de mexer no agente que está na tela: em todas
  // elas o agente aberto é o mesmo antes e depois, então a guarda deixa passar.
  const bloco = blocoDeAgentes();
  const acoes = [
    ["/api/agentes/${Number(agenteAberto.agente.id)}`, { metodo: 'PUT'", 'salvar a configuração'],
    ['/comportamento/', 'restaurar versão do comportamento'],
    ["/treinamentos`, { metodo: 'POST'", 'cadastrar treinamento'],
    ['/inatividade`', 'salvar inatividade'],
    ['/canais`', 'salvar canais'],
    ['/pausar`', 'pausar o agente'],
    ['/retomar`', 'retomar o agente'],
  ];
  for (const [trecho, nome] of acoes) {
    const inicio = bloco.indexOf(trecho);
    assert.ok(inicio >= 0, `falta a chamada de ${nome}`);
    const depois = bloco.slice(inicio, inicio + 900);
    assert.ok(depois.includes('carregarAgentes()'), `${nome} precisa recarregar a lista`);
    assert.ok(!depois.slice(0, depois.indexOf('carregarAgentes()')).includes('agenteAberto = null'),
      `${nome} não pode zerar o agente aberto antes de recarregar: a guarda impediria a reabertura`);
  }

  // E a guarda compara o agente do começo com o do fim, em vez de olhar só se
  // existe algum aberto — é o que distingue "recarga legítima" de "o usuário
  // fechou ou trocou de agente enquanto a lista vinha".
  const carregar = funcaoDoApp('carregarAgentes');
  assert.match(carregar, /if \(abertoAoEntrar && agenteAberto\?\.agente\?\.id === abertoAoEntrar\)/);
});

test('não existe exclusão de agente: nada some da lista pelas costas da guarda', () => {
  // Se um dia existir, a guarda precisa ser revista: apagar o agente aberto
  // deixaria `abertoAoEntrar` apontando para um id que não volta mais na lista.
  const bloco = blocoDeAgentes();
  const exclusoes = [...bloco.matchAll(/\/api\/agentes\/\$\{[^}]+\}`, \{ metodo: 'DELETE'/g)];
  assert.equal(exclusoes.length, 0,
    'apareceu exclusão de agente: revisar a guarda abertoAoEntrar em carregarAgentes');
});

test('os dois tratadores do clique em "Todos os agentes" chegam ao mesmo estado', () => {
  // Os dois rodam no mesmo clique, na ordem de registro: primeiro o genérico do
  // menu (abrirTela, que dispara a carga da lista), depois o do item. Se o
  // segundo viesse antes, a carga leria `agenteAberto` já nulo e daria no mesmo;
  // o que não pode é a carga reabrir o agente que o clique acabou de fechar —
  // por isso este teste anda junto com a guarda de carregarAgentes.
  const generico = APP_JS.indexOf("for (const gatilho of document.querySelectorAll('nav [data-tela]'))");
  const doItem = APP_JS.indexOf("seletor('#item-agentes button')?.addEventListener");
  assert.ok(generico >= 0 && doItem > generico,
    'o tratador do item é registrado depois do genérico, então roda depois dele');

  // O tratador é síncrono: a ordem das linhas dentro dele não muda nada, e
  // travá-la seria prender o teste a uma escrita, não a um comportamento. O que
  // importa é que as três coisas aconteçam antes de qualquer resposta chegar —
  // e que a carga da lista, já disparada pelo genérico, não desfaça nenhuma.
  const handler = APP_JS.slice(doItem, APP_JS.indexOf('});', doItem));
  for (const efeito of ['agenteAberto = null', 'editor.hidden = true', 'destacarAgenteNoMenu(null)']) {
    assert.ok(handler.includes(efeito), `o tratador precisa de: ${efeito}`);
  }
  assert.doesNotMatch(handler, /await|then\(/, 'nada assíncrono aqui: a tela fica consistente no mesmo clique');
  assert.match(funcaoDoApp('carregarAgentes'), /if \(abertoAoEntrar && agenteAberto\?\.agente\?\.id === abertoAoEntrar\)/,
    'e a carga em voo não reabre o agente que este tratador acabou de fechar');
});

test('o par de botões da Serena fica estável nos três estados', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
  // Sozinha, a parada encosta à direita; com o "Liberar" visível, o par anda
  // junto; no telefone os dois dividem a linha. Sem o `margin-left: auto` da
  // parada, a regra seguinte não teria o que cancelar e o botão mudava de lugar
  // conforme o vizinho aparecia.
  assert.match(css, /\.parada-emergencia \{ order: 2; width: auto; margin-left: auto;/,
    'sozinha, a parada tem posição fixa à direita');
  assert.match(css, /\.liberar-em-massa:not\(\[hidden\]\) \+ \.parada-emergencia \{ margin-left: 0; \}/,
    'com o vizinho VISÍVEL (não só presente no HTML), o par anda junto');
  assert.match(css, /\.liberar-em-massa, \.parada-emergencia \{ flex: 1 1 45%; margin-left: 0;/,
    'no telefone os dois dividem a linha, sem margem automática');
});
