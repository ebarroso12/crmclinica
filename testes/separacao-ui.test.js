'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Telas da separação clínica × agentes (migration 047). Guardas estruturais: o
// que o servidor recorta está provado em testes/separacao-clinica-agentes.test.js;
// aqui, que a tela não oferece nem pede o que responderia 403, e que monta nomes
// sem innerHTML cru. NÃO prova o comportamento no navegador.

const RAIZ = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');

function funcaoDoApp(nome) {
  const inicio = APP_JS.search(new RegExp(`^(?:async\\s+)?function ${nome}\\(`, 'm'));
  assert.ok(inicio >= 0, `function ${nome} precisa existir em app.js`);
  const proxima = APP_JS.slice(inicio + 1).search(/^(?:async\s+)?function\s/m);
  return APP_JS.slice(inicio, proxima < 0 ? undefined : inicio + 1 + proxima);
}

test('a sessão carrega o escopo ANTES de iniciar o inbox, e quem não vê a clínica cai em Conversas', () => {
  const mostrar = funcaoDoApp('mostrarAplicacao');
  const posEscopo = mostrar.indexOf('prepararEscopoDaSessao().then(() => {');
  const posInbox = mostrar.indexOf('iniciarInbox();');
  assert.ok(posEscopo >= 0 && posInbox > posEscopo, 'o inbox só começa depois do escopo');
  assert.match(mostrar, /if \(!veClinica\(\) && !usuarioAtual\?\.precisa_trocar_senha\) abrirTela\('conversas'\);/);
  assert.match(funcaoDoApp('prepararEscopoDaSessao'), /pedirJson\('\/api\/conversas\/escopo'\)/);
  assert.match(funcaoDoApp('limparSessao'), /escopoAtual = null;/);
});

test('iniciarInbox não pede resumo nem leads para quem não vê a clínica; painel Hoje só na aba da clínica', () => {
  const inbox = funcaoDoApp('iniciarInbox');
  assert.match(inbox, /if \(veClinica\(\)\) \{\s*carregarResumo\(\);/);
  assert.match(inbox, /if \(veClinica\(\)\) carregarLeads\(\);/);
  assert.match(funcaoDoApp('carregarConversas'), /if \(veClinica\(\) && \(!escopoDaListaDeConversas \|\| escopoDaListaDeConversas === 'clinica'\)\) \{\s*desenharFilaDeHoje/);
  assert.match(funcaoDoApp('veClinica'), /escopoAtual\?\.clinica === true/, 'antes de carregar, não vê');
});

test('menu do colaborador: só Conversas, Contatos e Meu perfil; parada da Serena, liberar em massa e novo contato somem', () => {
  assert.match(APP_JS, /const TELAS_SEM_CLINICA = new Set\(\['conversas', 'contatos', 'perfil'\]\);/);
  const aplicar = funcaoDoApp('aplicarEscopoNoMenu');
  assert.match(aplicar, /if \(veClinica\(\)\) return;/);
  assert.match(aplicar, /!TELAS_SEM_CLINICA\.has\(botao\.dataset\.tela\)/);
  for (const alvo of ['#parada-emergencia', '#liberar-em-massa', '#contato-novo', '#editar-ficha', '#botao-nota']) assert.ok(aplicar.includes(`'${alvo}'`), alvo);
  // Auditoria de acesso A3: editar contato é da clínica — o botão só existe para quem a vê.
  assert.match(funcaoDoApp('carregarContatos'), /\$\{veClinica\(\) \? `<button type="button" class="secundario" data-editar-contato=/);
  assert.match(funcaoDoApp('sincronizarLiberarEmMassa'), /\(escopoAtual !== null && !veClinica\(\)\)/);
});

test('abas "Clínica | agente": abrem na clínica, escondidas com um contexto só, rótulo por textContent', () => {
  const abas = funcaoDoApp('desenharAbasDeEscopoDasConversas');
  assert.match(abas, /\.\.\.\(veClinica\(\) \? \[\{ valor: 'clinica', rotulo: 'Clínica' \}\] : \[\]\)/, 'clínica primeiro');
  assert.match(abas, /escopoDaListaDeConversas = opcoes\[0\]\?\.valor \?\? null/);
  assert.match(abas, /barra\.hidden = opcoes\.length <= 1;/);
  assert.match(abas, /botao\.textContent = opcao\.rotulo;/);
  assert.ok(!/innerHTML/.test(abas), 'nome de agente nunca por innerHTML');
  assert.match(funcaoDoApp('abrirConversaDoAgente'), /escopoDaListaDeConversas = String\(Number\(agenteAberto\.agente\.id\)\)/);
});

test('conversa aberta: temperatura e agenda do paciente só para quem vê a clínica', () => {
  const abrir = funcaoDoApp('abrirConversa');
  assert.match(abrir, /temperatura\.hidden = !veClinica\(\);/);
  assert.match(abrir, /if \(veClinica\(\)\) carregarAgendaDaConversa\(conversaId\);/);
});

test('aba Equipe do agente: lista, adicionar (admin) e tirar com confirmação; resposta de outro agente é descartada', () => {
  // A aba pode trazer a luz de estado (<span class="luz">) antes do texto, por
  // isso o intervalo em vez de `[^>]*` — o que importa é que a aba "equipe"
  // exista e seja rotulada "Equipe".
  assert.match(HTML, /data-aba-agente="equipe"[\s\S]{0,160}>Equipe<\/button>/);
  assert.match(HTML, /<div class="agente-aba" data-painel-agente="equipe" hidden>/);
  assert.match(HTML, /<form id="agente-equipe-form" class="form-regra" hidden>/);
  // Produção 11/09: todas as contas eram admin e a lista de candidatos vinha vazia —
  // o admin vê as conversas, mas o RESUMO do agente só vai para quem está na equipe.
  assert.ok(HTML.includes('O administrador sempre vê as conversas; para receber o resumo deste agente, também precisa estar na equipe.'));

  const carregar = funcaoDoApp('carregarEquipeDoAgente');
  assert.match(carregar, /const aindaEste = \(\) => agenteAberto && Number\(agenteAberto\.agente\.id\) === id;/);
  assert.ok((carregar.match(/if \(!aindaEste\(\)\) return;/g) ?? []).length >= 2);
  assert.match(carregar, /formulario\.hidden = !dados\.pode_gerenciar;/);

  const desenhar = funcaoDoApp('desenharEquipeDoAgente');
  assert.match(desenhar, /escapar\(membro\.nome/);
  assert.match(desenhar, /Colaborador \(só agentes\)/);
  const candidatos = funcaoDoApp('preencherCandidatosDaEquipe');
  assert.doesNotMatch(candidatos, /usuario\.papel !== 'admin'/, 'admin entra na equipe para receber o resumo do agente');
  assert.match(candidatos, /usuario\.situacao === 'ativo' && !naEquipe\.has\(Number\(usuario\.id\)\)/);
  assert.match(candidatos, /usuario\.papel === 'admin' \? ' · já vê tudo; entra para receber o resumo' : ''/);
  assert.match(desenhar, /Ninguém na equipe ainda: só o administrador vê as conversas deste agente, e ninguém recebe o resumo dele\./);
  assert.match(APP_JS, /window\.confirm\('Tirar esta pessoa da equipe\?/);
  assert.match(APP_JS, /\/api\/agentes\/\$\{id\}\/equipe\/\$\{Number\(botao\.dataset\.removerMembro\)\}`, \{ metodo: 'DELETE' \}/);
});

test('Usuários: "Vê a clínica" no cadastro e na lista, "Colaborador (só agentes)" e aviso de quem não vê nada', () => {
  assert.match(HTML, /<input type="checkbox" id="novo-acesso-clinica" checked> Vê a clínica/);
  assert.ok(HTML.includes('Desmarcado = só as conversas dos agentes em que a pessoa estiver na Equipe'));

  const linha = funcaoDoApp('montarLinhaDeUsuario');
  assert.match(linha, /selo\.textContent = 'Colaborador \(só agentes\)';/);
  assert.match(linha, /aviso\.textContent = 'Não vê nada: coloque numa equipe de agente';/);
  assert.match(linha, /if \(usuario\.papel !== 'admin'\) \{/);
  assert.match(linha, /agirNoUsuario\(usuario\.id, 'acesso-clinica', \{ acesso_clinica: caixa\.checked \}\)/);
  assert.match(APP_JS, /\/api\/usuarios\/\$\{Number\(criado\.id\)\}\/acesso-clinica`, \{ metodo: 'POST', corpo: \{ acesso_clinica: false \} \}/);
});

test('Contatos: selos de origem escapados, filtro Todos/Clínica/agente, e o colaborador não exclui', () => {
  assert.match(HTML, /<select id="contatos-origem" title="De onde o contato veio">/);
  assert.match(funcaoDoApp('selosDoContatoEmHtml'), /escapar\(item\.rotulo\)/);
  assert.match(funcaoDoApp('prepararFiltroDeOrigemDosContatos'), /\.\.\.\(veClinica\(\) \? \[\['clinica', 'Clínica'\]\] : \[\]\)/);
  const carregar = funcaoDoApp('carregarContatos');
  assert.match(carregar, /&origem=\$\{encodeURIComponent\(origem\)\}/);
  // Auditoria de acesso A3: "Editar" e "Excluir" do contato no mesmo bloco, só para quem vê a clínica.
  assert.match(carregar, /\$\{veClinica\(\) \? `<button type="button" class="secundario" data-editar-contato="\$\{contato\.id\}">Editar<\/button>\s*<button type="button" class="perigo" data-excluir-contato=/);
  assert.match(funcaoDoApp('verHistoricoDoContato'), /c\.agente_nome \?\? 'Clínica'/);
});

test('fim de sessão numa aba já usada recarrega a página: menu e inbox da sessão anterior não passam para a próxima (code review de 12e16b1)', () => {
  // Sem isto: o colaborador sai, um gestor entra na mesma aba e fica sem os menus
  // da clínica (aplicarEscopoNoMenu só esconde) e sem painel Hoje/leads (iniciarInbox
  // roda uma vez por página); no inverso, carregarResumo seguia pedindo 403 a cada minuto.
  const encerrar = funcaoDoApp('encerrarSessaoNaTela');
  assert.match(encerrar, /limparSessao\(\);/);
  assert.match(encerrar, /if \(!aplicacaoJaMostrada\) \{\s*mostrarPortao\(mensagem\);\s*return;\s*\}/,
    'antes de o app rodar nesta página, só o portão — sem laço de recarga');
  assert.match(encerrar, /window\.location\.reload\(\);/);
  assert.match(funcaoDoApp('mostrarAplicacao'), /aplicacaoJaMostrada = true;/);

  assert.match(funcaoDoApp('renovarSessaoUmaVez'), /catch \{\s*encerrarSessaoNaTela\(\);\s*return false;/);
  const inicioSair = APP_JS.indexOf("seletor('#sair')?.addEventListener('click'");
  assert.ok(inicioSair >= 0);
  const sair = APP_JS.slice(inicioSair, APP_JS.indexOf('\n});', inicioSair));
  assert.match(sair, /keepalive: true/, 'o logout no servidor não morre com o recarregamento');
  assert.match(sair, /encerrarSessaoNaTela\(\);/);
  assert.ok(!/mostrarPortao\(/.test(sair), 'o portão vem de encerrarSessaoNaTela');
  assert.match(APP_JS, /setTimeout\(\(\) => encerrarSessaoNaTela\('Senha alterada\. Entre com a senha nova\.'\), 1500\);/);
  // O aviso do portão sobrevive ao recarregamento.
  assert.match(APP_JS, /else mostrarPortao\(lerEApagarAvisoDoPortao\(\)\);/);
});

test('uma renovação de sessão por vez, e "Sair" espera a que está em andamento (revisão de 4669467)', () => {
  // Dois pedidos com 401 no mesmo tick (timers de 60 s e 30 s, Promise.all ao
  // abrir conversa) gastavam o mesmo refresh rotativo: um renovava, o outro era
  // recusado e encerrava a sessão — agora com recarga da página no meio do plantão.
  assert.match(APP_JS, /^let renovacaoEmAndamento = null;$/m);
  const renovar = funcaoDoApp('renovarSessao');
  assert.match(renovar, /if \(!renovacaoEmAndamento\) \{/);
  assert.match(renovar, /renovacaoEmAndamento = renovarSessaoUmaVez\(\)\.finally\(/);
  assert.match(renovar, /return renovacaoEmAndamento;/);

  // "Sair" no meio de uma renovação revogava o refresh velho, e o novo chegava
  // depois: a pessoa voltava logada após a recarga.
  const inicioSair = APP_JS.indexOf("seletor('#sair')?.addEventListener('click'");
  const sair = APP_JS.slice(inicioSair, APP_JS.indexOf('\n});', inicioSair));
  const esperar = sair.indexOf('if (renovacaoEmAndamento) await renovacaoEmAndamento');
  const ler = sair.indexOf('const refresh = lerRefresh();');
  const encerrar = sair.indexOf('encerrarSessaoNaTela();');
  assert.ok(esperar >= 0 && esperar < ler && ler < encerrar, 'espera a renovação, lê o refresh atual, depois encerra');

  // O aviso do portão é lido uma vez só.
  assert.match(funcaoDoApp('lerEApagarAvisoDoPortao'), /sessionStorage\.removeItem\(CHAVE_AVISO_PORTAO\);/);
});

test('ficha: "Editar" só para quem vê a clínica, também ao abrir cada conversa (code review de 12e16b1)', () => {
  // desenharFicha roda a cada conversa aberta e desfazia o que aplicarEscopoNoMenu
  // escondeu: gestor sem acesso à clínica via "Editar" e o salvar dava 403.
  assert.match(funcaoDoApp('desenharFicha'),
    /seletor\('#editar-ficha'\)\.hidden = !podeFazer\('contatos:editar'\) \|\| !veClinica\(\);/);
});

test('nada inline nas marcações novas (CSP estrita)', () => {
  for (const trecho of ['abas-escopo-conversas', 'agente-equipe-lista', 'contatos-origem', 'novo-acesso-clinica']) {
    const posicao = HTML.indexOf(trecho);
    const vizinhanca = HTML.slice(Math.max(0, posicao - 400), posicao + 600);
    assert.ok(!/\son[a-z]+=/i.test(vizinhanca), `handler inline perto de ${trecho}`);
    assert.ok(!/\sstyle=/i.test(vizinhanca), `style inline perto de ${trecho}`);
  }
});
