'use strict';

// Interface do crmclinica. Fala só com a API do próprio domínio; nenhuma credencial
// trafega pelo navegador. O inbox é local: conversa e mensagem vêm do banco do produto.

const TITULOS = {
  painel: 'Hoje',
  conversas: 'Conversas',
  leads: 'Leads',
  agenda: 'Agenda',
  metricas: 'Métricas',
  serena: 'Serena',
  instagram: 'Instagram',
  agentes: 'Agentes',
  contatos: 'Contatos',
  auditoria: 'Auditoria',
  bloqueios: 'Bloqueio de Contato',
  usuarios: 'Usuários',
  perfil: 'Meu perfil',
};

const seletor = (alvo) => document.querySelector(alvo);

function abrirTela(tela) {
  if (!TITULOS[tela]) return;

  for (const secao of document.querySelectorAll('.tela')) {
    secao.hidden = secao.id !== tela;
  }
  for (const botao of document.querySelectorAll('nav button[data-tela]')) {
    const ativo = botao.dataset.tela === tela && !botao.dataset.abrirAgenteMenu;
    if (ativo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }

  seletor('#titulo').textContent = TITULOS[tela];
  document.title = `${TITULOS[tela]} · crmclinica`;

  if (tela === 'conversas') carregarConversas();
  if (tela === 'leads') carregarLeads();
  if (tela === 'agenda') carregarAgenda();
  if (tela === 'metricas') carregarMetricas();
  if (tela === 'serena') carregarSerena();
  if (tela === 'instagram') carregarInstagram();
  if (tela === 'agentes') carregarAgentes();
  if (tela === 'contatos') carregarContatos();
  if (tela === 'auditoria') carregarAuditoria();
  if (tela === 'bloqueios') carregarBloqueios();
  if (tela === 'usuarios') carregarUsuarios();
  if (tela === 'perfil') {
    desenharPerfil();
    // O cartão de avisos no celular vive aqui: é ajuste de conta, e o aparelho
    // avisado é aquele onde a pessoa apertar o botão.
    carregarAvisosDoCelular().catch(() => {});
  }
}

for (const gatilho of document.querySelectorAll('nav [data-tela]')) {
  gatilho.addEventListener('click', () => abrirTela(gatilho.dataset.tela));
}

// Cidade exibida no relógio. Franca/SP fica no fuso America/Sao_Paulo, então o
// fuso NÃO muda — muda só o rótulo. (No futuro dá para vir de admin_config,
// chave 'clinica_cidade'; por ora o padrão abaixo.)
const CIDADE_DA_CLINICA = 'Franca - SP';

function atualizarRelogio() {
  const agora = new Date();
  seletor('#hora').textContent = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(agora);
  // Antes era "São Paulo · hoje" fixo. Agora mostra a cidade certa e a DATA
  // completa do dia, no fuso da clínica.
  const local = seletor('#hora-local');
  if (local) {
    const data = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Sao_Paulo',
    }).format(agora);
    local.textContent = `${CIDADE_DA_CLINICA} · ${data}`;
  }
}

// --- Estado de leitura da API ---

const LEGENDAS = {
  operacional: ['Operacional', 'ok'],
  configurada: ['Configurada', 'ok'],
  disponível: ['Disponível', 'ok'],
  exigida: ['Assinatura exigida', 'ok'],
  degradado: ['Degradado', 'alerta'],
  nao_configurado: ['Não configurado', 'alerta'],
  ausente: ['Não configurado', 'alerta'],
  indisponivel: ['Indisponível', 'ruim'],
};

function aplicarEstado(alvo, chave) {
  const elemento = seletor(alvo);
  if (!elemento) return;
  const [rotulo, classe] = LEGENDAS[chave] || [String(chave), ''];
  elemento.textContent = rotulo;
  elemento.className = `estado ${classe}`.trim();
}

function definirTexto(alvo, valor) {
  const elemento = seletor(alvo);
  if (elemento) elemento.textContent = valor;
}

async function carregarAuditoria(mais = false) {
  if (!podeFazer('auditoria:ler')) return definirTexto('#auditoria-resumo', 'Seu perfil não tem acesso à auditoria.');
  try {
    const sufixo = mais && cursorAuditoria ? `?cursor=${encodeURIComponent(cursorAuditoria)}` : '';
    const dados = await pedirJson(`/api/auditoria${sufixo}`);
    const lista = seletor('#lista-auditoria');
    if (!mais) lista.replaceChildren();
    for (const item of dados.itens) {
      const linha = document.createElement('li');
      linha.className = 'contato-item';
      linha.textContent = `${item.acao} · ${item.entidade} #${item.entidade_id ?? '—'} · ${item.usuario_nome ?? 'sistema'} · ${new Date(item.criado_em).toLocaleString('pt-BR')}`;
      lista.append(linha);
    }
    cursorAuditoria = dados.proximo_cursor;
    seletor('#auditoria-mais').hidden = !cursorAuditoria;
    definirTexto('#auditoria-resumo', dados.itens.length ? 'Eventos redigidos; dados sensíveis não são exibidos.' : 'Nenhum evento encontrado.');
  } catch (erro) { definirTexto('#auditoria-resumo', erro.detalhe || 'Não foi possível carregar a auditoria.'); }
}

seletor('#auditoria-mais')?.addEventListener('click', () => carregarAuditoria(true));

// ---------------------------------------------------------------------------
// Tema da tela (12/09/2026)
//
// Três estados, como no sistema operacional: "sistema" (padrão), "claro" e
// "escuro". Quem decide as cores é o CSS; aqui só se carimba `data-tema` no
// <html> e se guarda a escolha.
//
// A escolha é por APARELHO (localStorage), não por conta: a mesma pessoa pode
// querer claro no computador do consultório e escuro no celular à noite.
//
// Isto roda cedo de propósito — antes de qualquer pedido à API. Aplicar o tema
// depois faria a tela piscar branca antes de escurecer, que é justamente o que
// incomoda quem abre o CRM no escuro.

const CHAVE_TEMA = 'crmclinica:tema';
const TEMAS = ['sistema', 'claro', 'escuro'];

function lerTemaEscolhido() {
  try {
    const guardado = localStorage.getItem(CHAVE_TEMA);
    return TEMAS.includes(guardado) ? guardado : 'sistema';
  } catch {
    return 'sistema';
  }
}

function aplicarTema(tema) {
  const escolha = TEMAS.includes(tema) ? tema : 'sistema';
  // "sistema" não carimba nada: sem o atributo, quem manda é o
  // `prefers-color-scheme` do aparelho.
  if (escolha === 'sistema') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', escolha);

  for (const botao of document.querySelectorAll('[data-tema-escolha]')) {
    const ativo = botao.dataset.temaEscolha === escolha;
    botao.setAttribute('aria-checked', String(ativo));
    if (ativo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }
  return escolha;
}

function escolherTema(tema) {
  const escolha = aplicarTema(tema);
  try { localStorage.setItem(CHAVE_TEMA, escolha); } catch { /* armazenamento bloqueado */ }
}

aplicarTema(lerTemaEscolhido());

for (const botao of document.querySelectorAll('[data-tema-escolha]')) {
  botao.addEventListener('click', () => escolherTema(botao.dataset.temaEscolha));
}

// ---------------------------------------------------------------------------
// Sessão da equipe.
//
// O access token fica só em memória: em `localStorage` ele sobreviveria à aba e
// ficaria legível por qualquer script injetado. Ele vale 15 minutos.
//
// O refresh mudou de `sessionStorage` para `localStorage` em 12/09/2026, a
// pedido do Dr. Edson ("o login deve ser contínuo"). A diferença prática:
// sessionStorage morre quando a aba (ou o app instalado) fecha, então quem usa
// o CRM no celular tinha de digitar e-mail e senha toda vez que voltava. Com
// localStorage a sessão sobrevive, até o limite que o SERVIDOR define — sete
// dias, renovados a cada uso (o refresh é rotativo).
//
// O que isso custa: num aparelho compartilhado ou perdido, quem abrir o
// navegador entra sem senha. É a mesma troca que todo aplicativo de mensagens
// faz, e "Sair" continua revogando a sessão no servidor na hora. Para uma
// recepção que atende paciente no balcão, o risco de deixar o CRM logado no
// aparelho de trabalho é conhecido; o de errar a senha no meio do atendimento,
// também.
// ---------------------------------------------------------------------------

let accessToken = null;
let usuarioAtual = null;
let cursorAuditoria = null;
// Migration 047: o que esta sessão vê (GET /api/conversas/escopo) — a clínica
// e os agentes da equipe. `null` até carregar. O servidor garante o recorte;
// aqui é para não oferecer (nem pedir) o que responderia 403.
let escopoAtual = null;
// A aplicação já rodou nesta página? Depois disso, fim de sessão recarrega a
// página (encerrarSessaoNaTela): menu e inbox são montados uma vez por sessão.
let aplicacaoJaMostrada = false;

const CHAVE_REFRESH = 'crmclinica.refresh';

/**
 * Onde o refresh mora. `localStorage` sobrevive ao fechamento; o
 * `sessionStorage` continua sendo lido uma última vez para quem já estava
 * logado antes desta mudança não ser posto para fora sem motivo.
 */
function guardarRefresh(token) {
  try { localStorage.setItem(CHAVE_REFRESH, token); } catch { /* armazenamento bloqueado */ }
  try { sessionStorage.removeItem(CHAVE_REFRESH); } catch { /* idem */ }
}
// Aviso do portão que precisa sobreviver ao recarregamento (ex.: senha trocada).
const CHAVE_AVISO_PORTAO = 'crmclinica.aviso-portao';

function guardarSessao(sessao) {
  accessToken = sessao.access_token;
  usuarioAtual = sessao.usuario;
  // Navegador com armazenamento bloqueado: a sessão vale enquanto a página viver.
  guardarRefresh(sessao.refresh_token);
}

function lerRefresh() {
  try {
    // A sessão antiga (sessionStorage) ainda vale nesta aba: quem estava
    // logado quando a mudança subiu não é posto para fora.
    return localStorage.getItem(CHAVE_REFRESH) || sessionStorage.getItem(CHAVE_REFRESH);
  } catch {
    return null;
  }
}

function limparSessao() {
  accessToken = null;
  usuarioAtual = null;
  // Quem entrar depois nesta aba não herda as abas nem o menu da sessão anterior.
  escopoAtual = null;
  escopoDaListaDeConversas = null;
  // A conexão ao vivo carrega o token na URL: sem isso, ela ficaria aberta
  // com a sessão anterior mesmo depois do logout.
  encerrarEventosDeConversas();
  // Sair limpa os dois lugares: deixar o refresh velho no sessionStorage faria
  // a próxima carga desta aba ressuscitar a sessão que acabou de ser encerrada.
  try { localStorage.removeItem(CHAVE_REFRESH); } catch { /* nada a fazer */ }
  try { sessionStorage.removeItem(CHAVE_REFRESH); } catch { /* nada a fazer */ }
}

/**
 * Fim de sessão na tela: Sair, renovação recusada, senha trocada.
 *
 * Com a aplicação já rodando nesta página, recarrega. O menu escondido pelo
 * escopo (aplicarEscopoNoMenu só esconde), o inbox (iniciarInbox roda uma vez
 * por página) e os relógios da sessão anterior não podem passar para quem
 * entrar depois na mesma aba — code review de 12e16b1: o colaborador saía, um
 * gestor entrava e ficava sem os menus da clínica; no inverso, o resumo seguia
 * pedindo 403 a cada minuto. Antes de a aplicação rodar, só mostra o portão:
 * sem laço de recarga.
 */
function encerrarSessaoNaTela(mensagem = '') {
  limparSessao();
  if (!aplicacaoJaMostrada) {
    mostrarPortao(mensagem);
    return;
  }
  if (mensagem) {
    try {
      sessionStorage.setItem(CHAVE_AVISO_PORTAO, mensagem);
    } catch {
      // Sem armazenamento: recarrega sem o aviso.
    }
  }
  window.location.reload();
}

function lerEApagarAvisoDoPortao() {
  try {
    const aviso = sessionStorage.getItem(CHAVE_AVISO_PORTAO) || '';
    sessionStorage.removeItem(CHAVE_AVISO_PORTAO);
    return aviso;
  } catch {
    return '';
  }
}

function podeFazer(permissao) {
  return Boolean(usuarioAtual?.permissoes?.includes(permissao));
}

/** Migration 047: esta sessão vê a clínica? Antes de o escopo carregar, não. */
function veClinica() {
  return escopoAtual?.clinica === true;
}

async function pedirJson(caminho, opcoes = {}, jaRenovou = false) {
  const resposta = await fetch(caminho, {
    method: opcoes.metodo || 'GET',
    headers: {
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(opcoes.corpo ? { 'content-type': 'application/json' } : {}),
    },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });

  // Access token vence a cada 15 minutos; renovar e repetir é transparente para
  // quem está atendendo. Uma tentativa só, para não entrar em laço.
  if (resposta.status === 401 && !jaRenovou && lerRefresh()) {
    if (await renovarSessao()) return pedirJson(caminho, opcoes, true);
  }

  if (!resposta.ok) {
    const erro = new Error(`HTTP ${resposta.status}`);
    erro.status = resposta.status;
    try {
      const corpo = await resposta.json();
      erro.detalhe = corpo.erro;
      // O código de erro permite à interface reagir (pedir o próximo passo,
      // pedir o motivo da perda) em vez de só reclamar.
      erro.codigo = corpo.codigo ?? null;
    } catch {
      erro.detalhe = null;
    }
    throw erro;
  }
  return resposta.json();
}

// Uma renovação por vez (revisão de 4669467). O refresh é rotativo: dois pedidos
// com 401 no mesmo tick (timers de 60 s e 30 s, Promise.all ao abrir conversa)
// gastavam o mesmo refresh, um renovava e o outro era recusado e encerrava a
// sessão — com a recarga de encerrarSessaoNaTela, no meio do plantão.
let renovacaoEmAndamento = null;

async function renovarSessao() {
  if (!renovacaoEmAndamento) {
    renovacaoEmAndamento = renovarSessaoUmaVez().finally(() => {
      renovacaoEmAndamento = null;
    });
  }
  return renovacaoEmAndamento;
}

async function renovarSessaoUmaVez() {
  const refresh = lerRefresh();
  if (!refresh) return false;

  try {
    const resposta = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!resposta.ok) throw new Error('refresh recusado');

    guardarSessao(await resposta.json());
    return true;
  } catch {
    encerrarSessaoNaTela();
    return false;
  }
}

// Estado do banner #aviso-serena entre polls — ver comentários dentro de
// carregarResumo(). null = ainda não sabemos o estado real da Serena.
let serenaAvisoUltimoEstado = null;
let serenaAvisoDadosDesatualizados = false;

async function carregarResumo() {
  try {
    const resumo = await pedirJson('/api/resumo');

    // Indicador sem fonte vem `null` e vira "—": melhor um traço honesto que um
    // número inventado ao lado de números reais.
    const { pendentes, leadsHoje, consultasHoje, escalonamentos } = resumo.indicadores;
    const mostrar = (valor) => (valor === null || valor === undefined ? '—' : valor);

    definirTexto('#metrica-pendentes', mostrar(pendentes));
    definirTexto('#metrica-leads', mostrar(leadsHoje));
    definirTexto('#metrica-consultas', mostrar(consultasHoje));
    definirTexto('#metrica-escalonamentos', mostrar(escalonamentos));

    const aviso = seletor('#aviso-ambiente');
    if (aviso) {
      aviso.hidden = resumo.origem === 'banco';
      aviso.textContent = 'Inbox rodando em memória: nada é persistido e tudo se perde no reinício.';
    }

    const avisoSerena = seletor('#aviso-serena');
    if (avisoSerena) {
      // Achado da auditoria de 22/08: `montarResumo` aninha em
      // `plataforma.serena` (src/dominio/resumo.js) — não existe `atendimento`
      // na raiz do resumo. Lendo daqui, o banner nunca aparecia, mesmo com a
      // Serena desligada há dias.
      const serena = resumo.plataforma?.serena;
      const desligada = Boolean(serena && serena.ativa === false);
      const mudouDeEstado = desligada !== serenaAvisoUltimoEstado;

      // Achado da revisão de UX de 22/08: `#aviso-serena` é `role="alert"`
      // (index.html) — uma região aria-live="assertive" do leitor de tela,
      // que interrompe qualquer fala em andamento a cada mudança de texto.
      // Este poll roda a cada 60s; reescrever o texto em todo poll faria o
      // leitor de tela interromper de novo a cada minuto durante TODA uma
      // queda da automação, porque "há N min" muda a cada minuto — o pior
      // momento possível para atrapalhar quem está atendendo manualmente.
      // Por isso só reescreve quando o estado de verdade muda (ligou/
      // desligou) ou quando o dado volta a ficar fresco depois de uma falha
      // de poll (abaixo). O texto fica com o tempo decorrido congelado no
      // valor de quando apareceu — troca deliberada: a informação essencial
      // (a automação está parada) não muda com o relógio, e vale mais que
      // repetir a interrupção.
      if (mudouDeEstado || (desligada && serenaAvisoDadosDesatualizados)) {
        avisoSerena.hidden = !desligada;
        if (desligada) {
          const ha = serena.desde ? haQuanto(serena.desde) : '';
          avisoSerena.textContent = ha
            ? `Serena desligada ${ha} — o atendimento automático está pausado.`
            : 'Serena desligada — o atendimento automático está pausado.';
        } else {
          avisoSerena.textContent = '';
        }
      }
      serenaAvisoUltimoEstado = desligada;
      serenaAvisoDadosDesatualizados = false;
    }

    const { orquestrador, atendimento, inbox, fonteDeVerdade } = resumo.plataforma;
    aplicarEstado('#saude-orquestrador', orquestrador.saude);
    aplicarEstado('#saude-atendimento', atendimento.integracao);
    aplicarEstado('#saude-inbox', inbox?.saude ?? 'ausente');
    aplicarEstado('#saude-crm', fonteDeVerdade.banco === 'configurado' ? 'operacional' : 'ausente');

    // Achado da auditoria de 22/08: esta função (polling global a cada 60s)
    // também escrevia `#estado-serena` com "Ativa"/"Aguardando integração"
    // (status de CONFIGURAÇÃO da integração) — sobrescrevendo periodicamente
    // o "Ligada"/"Desligada" real que `desenharEstadoDaSerena` (dona correta
    // do elemento, na tela Serena) tinha acabado de calcular a partir do
    // interruptor de verdade. `#estado-serena` tem uma dona só: desenharEstadoDaSerena.
  } catch {
    for (const alvo of ['#saude-orquestrador', '#saude-atendimento', '#saude-inbox', '#saude-crm']) {
      aplicarEstado(alvo, 'indisponivel');
    }

    // Achado da revisão de UX de 22/08: sem isto, uma falha de poll deixava
    // o banner "Serena desligada há Xh" congelado, com o tempo decorrido
    // cada vez mais errado e nenhuma pista de que o dado está velho — e, se
    // a automação tivesse voltado durante a falha, ninguém saberia pela
    // tela. Marca uma vez; o texto volta ao normal sozinho no próximo poll
    // que tiver sucesso (ver `serenaAvisoDadosDesatualizados` acima).
    const avisoSerena = seletor('#aviso-serena');
    if (avisoSerena && !avisoSerena.hidden && !serenaAvisoDadosDesatualizados) {
      avisoSerena.textContent += ' (falha ao atualizar — este dado pode estar desatualizado)';
    }
    serenaAvisoDadosDesatualizados = true;
  }
}

// ---------------------------------------------------------------------------
// Inbox: lista à esquerda, thread no centro, ficha à direita.
// ---------------------------------------------------------------------------

let filaAtual = 'todos';
let conversaAberta = null;
let contatoAberto = null;
let ordenacaoConversas = 'desc';
let etiquetasDisponiveis = [];
// Nome do agente dono da conversa aberta (docs/AGENTES.md); null = clínica.
// A thread usa para não assinar como "Serena" o que um agente respondeu.
let agenteDaConversaAberta = null;
// Aba de escopo da lista de Conversas (migration 047): 'clinica' ou o id de um agente.
let escopoDaListaDeConversas = null;

function iniciais(nome) {
  return (nome || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((parte) => parte[0] || '')
    .join('')
    .toUpperCase();
}

function haQuanto(instante) {
  if (!instante) return '';
  const minutos = Math.floor((Date.now() - new Date(instante).getTime()) / 60000);
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  return `há ${Math.floor(horas / 24)} d`;
}

function hora(instante) {
  if (!instante) return '';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(instante));
}

function avisar(elemento, mensagem, marcador = 'li') {
  elemento.innerHTML = '';
  const linha = document.createElement(marcador);
  linha.className = 'vazio';
  linha.textContent = mensagem;
  elemento.append(linha);
}

async function carregarEtiquetas() {
  try {
    const dados = await pedirJson('/api/conversas/filas');
    etiquetasDisponiveis = dados.etiquetas || [];
  } catch {
    etiquetasDisponiveis = [];
  }
}

async function carregarConversas() {
  const lista = seletor('#lista-conversas');
  if (!lista) return;

  const parametros = new URLSearchParams({ fila: filaAtual, ordenacao: ordenacaoConversas });
  const busca = seletor('#busca-conversas')?.value.trim();
  if (busca) parametros.set('busca', busca);
  const data = seletor('#filtro-data-conversas')?.value;
  if (data) parametros.set('data', data);
  if (escopoDaListaDeConversas) parametros.set('agente', escopoDaListaDeConversas);

  try {
    const dados = await pedirJson(`/api/conversas?${parametros}`);
    definirTexto('#fila-topo', `${dados.total} conversa(s)`);
    definirTexto('#contador-conversas', dados.total);

    if (dados.conversas.length === 0) {
      avisar(lista, 'Nenhuma conversa nesta fila.');
      return;
    }

    lista.innerHTML = '';
    for (const conversa of dados.conversas) {
      lista.append(montarLinhaDaLista(conversa));
    }

    // O painel Hoje é da clínica: só quem a vê, e só com a aba da clínica.
    if (veClinica() && (!escopoDaListaDeConversas || escopoDaListaDeConversas === 'clinica')) {
      desenharFilaDeHoje(dados.conversas);
    }
  } catch (erro) {
    avisar(lista, erro.status === 503 ? 'Inbox indisponível.' : 'Não foi possível carregar as conversas.');
  }
}

/**
 * Abas "Clínica | <agente>" da lista de Conversas (decisão 11/09, migration
 * 047). As opções vêm do escopo da sessão: "Clínica" para quem a vê e um item
 * por agente da equipe. Abre em "Clínica". Quem só tem um contexto não vê abas
 * — a lista já é só dele. Nomes por textContent, nunca innerHTML.
 */
function desenharAbasDeEscopoDasConversas() {
  const barra = seletor('#abas-escopo-conversas');
  if (!barra) return;
  const opcoes = [
    ...(veClinica() ? [{ valor: 'clinica', rotulo: 'Clínica' }] : []),
    ...(escopoAtual?.agentes ?? []).map((agente) => ({ valor: String(Number(agente.id)), rotulo: agente.nome })),
  ];
  if (!opcoes.some((opcao) => opcao.valor === escopoDaListaDeConversas)) escopoDaListaDeConversas = opcoes[0]?.valor ?? null;

  barra.textContent = '';
  for (const opcao of opcoes) {
    const botao = document.createElement('button');
    const ativa = opcao.valor === escopoDaListaDeConversas;
    botao.type = 'button';
    botao.className = ativa ? 'aba selecionada' : 'aba';
    botao.setAttribute('role', 'tab');
    botao.setAttribute('aria-selected', String(ativa));
    botao.dataset.escopoConversas = opcao.valor;
    botao.textContent = opcao.rotulo;
    barra.append(botao);
  }
  barra.hidden = opcoes.length <= 1;
}

/** Painel Hoje: as conversas que ainda esperam a equipe, com dado real. */
function desenharFilaDeHoje(conversas) {
  const fila = seletor('#fila-hoje');
  if (!fila) return;

  const esperando = conversas.filter((conversa) => conversa.status !== 'resolvida').slice(0, 5);
  definirTexto('#metrica-pendentes', esperando.length);

  if (esperando.length === 0) {
    avisar(fila, 'Nenhuma conversa esperando resposta.');
    return;
  }

  fila.innerHTML = '';
  for (const conversa of esperando) {
    const linha = montarLinhaDaLista(conversa);
    linha.addEventListener('click', () => abrirTela('conversas'));
    fila.append(linha);
  }

  // Os cartões de SLA e de tarefas carregam junto do painel; o sino também.
  carregarFilaSla();
  carregarTarefas();
  atualizarSino();
}

/** Cartão de SLA: quem falou por último e há quanto tempo espera. */
async function carregarFilaSla() {
  const fila = seletor('#fila-sla');
  if (!fila) return;

  try {
    const dados = await pedirJson('/api/conversas/aguardando');
    if (dados.total === 0) {
      avisar(fila, 'Ninguém aguardando resposta. 🎉');
      return;
    }

    fila.innerHTML = '';
    for (const conversa of dados.conversas.slice(0, 6)) {
      const linha = document.createElement('li');
      linha.tabIndex = 0;
      linha.setAttribute('role', 'button');

      const texto = document.createElement('span');
      texto.className = 'linha-texto';
      const nome = document.createElement('b');
      nome.textContent = conversa.contato_nome || `Conversa ${conversa.id}`;
      const espera = document.createElement('small');
      const minutos = conversa.minutos_aguardando;
      espera.textContent = minutos >= 60
        ? `esperando há ${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')}`
        : `esperando há ${minutos} min`;
      // Mais de 15 minutos de espera é estouro do SLA padrão.
      if (minutos > 15) espera.className = 'sla-estourado';
      texto.append(nome, espera);

      linha.append(texto);
      linha.addEventListener('click', () => { abrirTela('conversas'); abrirConversa(conversa.id); });
      fila.append(linha);
    }
  } catch {
    avisar(fila, 'Não foi possível carregar a fila de SLA.');
  }
}

/** Cartão de tarefas: o sino da equipe, com conclusão em um clique. */
async function carregarTarefas() {
  const fila = seletor('#fila-tarefas');
  if (!fila) return;

  try {
    const dados = await pedirJson('/api/tarefas');
    if (dados.total === 0) {
      avisar(fila, 'Nenhuma tarefa aberta.');
      return;
    }

    fila.innerHTML = '';
    for (const tarefa of dados.tarefas.slice(0, 6)) {
      const linha = document.createElement('li');

      const texto = document.createElement('span');
      texto.className = 'linha-texto';
      const titulo = document.createElement('b');
      titulo.textContent = tarefa.titulo;
      const detalhe = document.createElement('small');
      detalhe.textContent = tarefa.detalhe || tarefa.tipo;
      texto.append(titulo, detalhe);

      const concluir = document.createElement('button');
      concluir.type = 'button';
      concluir.className = 'link';
      concluir.textContent = 'Concluir';
      concluir.addEventListener('click', async () => {
        try {
          await pedirJson(`/api/tarefas/${tarefa.id}/concluir`, { metodo: 'POST', corpo: {} });
          carregarTarefas();
        } catch (erro) {
          informar(`Não foi possível concluir: ${erro.detalhe || erro.message}`);
        }
      });

      linha.append(texto, concluir);
      fila.append(linha);
    }
  } catch {
    avisar(fila, 'Não foi possível carregar as tarefas.');
  }
}

function montarLinhaDaLista(conversa) {
  const linha = document.createElement('li');
  linha.dataset.conversa = conversa.id;
  linha.tabIndex = 0;
  linha.setAttribute('role', 'button');
  if (conversa.id === conversaAberta) linha.classList.add('ativa');

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = iniciais(conversa.contato?.nome);

  const texto = document.createElement('span');
  texto.className = 'linha-texto';
  const nome = document.createElement('b');
  nome.textContent = conversa.contato?.nome || conversa.contato?.telefone || `Conversa ${conversa.id}`;
  const previa = document.createElement('small');
  previa.textContent = conversa.previa || 'Sem mensagens';
  texto.append(nome, previa);

  const quando = document.createElement('span');
  quando.className = 'quando';
  quando.textContent = haQuanto(conversa.ultima_msg_em);

  linha.append(avatar, texto, quando);

  const selos = document.createElement('span');
  selos.className = 'selos';

  // Primeiro selo: de quem é a conversa. Cliente de agente é de outro negócio
  // e sai por outro número — quem tria o inbox precisa ver isso antes de tudo.
  if (conversa.agente_nome) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta agente';
    selo.textContent = conversa.agente_nome;
    selos.append(selo);
  }
  if (conversa.assumida_por_humano) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta amarela';
    selo.textContent = 'Humano';
    selos.append(selo);
  }
  if (conversa.temperatura) {
    const selo = document.createElement('span');
    selo.className = `etiqueta temp-${conversa.temperatura}`;
    // O score ao lado da temperatura explica de onde ela veio.
    selo.textContent = conversa.score
      ? `${conversa.temperatura} ${conversa.score}`
      : conversa.temperatura;
    selos.append(selo);
  }
  if (conversa.status === 'resolvida') {
    const selo = document.createElement('span');
    selo.className = 'etiqueta';
    selo.textContent = 'resolvida';
    selos.append(selo);
  }
  // A próxima ação é o que a recepção precisa ler sem abrir a conversa.
  if (conversa.proxima_acao) {
    const acao = document.createElement('span');
    acao.className = 'proxima-acao';
    acao.textContent = conversa.proxima_acao;
    selos.append(acao);
  }

  if (selos.childElementCount > 0) linha.append(selos);

  const abrir = () => abrirConversa(conversa.id);
  linha.addEventListener('click', abrir);
  linha.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); abrir(); }
  });

  return linha;
}

function alternarAcoes(habilitado) {
  const controles = document.querySelectorAll(
    '.acoes-conversa .acao, #form-resposta input, #form-resposta button, #botao-nota',
  );
  for (const controle of controles) controle.disabled = !habilitado;
  seletor('#thread-nome').disabled = !habilitado;
}

async function abrirConversa(conversaId) {
  conversaAberta = conversaId;
  fecharHistorico();

  for (const linha of document.querySelectorAll('#lista-conversas li[data-conversa]')) {
    linha.classList.toggle('ativa', Number(linha.dataset.conversa) === Number(conversaId));
  }

  try {
    const [detalhe, mensagens] = await Promise.all([
      pedirJson(`/api/conversas/${conversaId}`),
      pedirJson(`/api/conversas/${conversaId}/mensagens`),
    ]);

    const { conversa, ficha } = detalhe;
    contatoAberto = conversa.contato_id;
    agenteDaConversaAberta = conversa.agente_nome || null;

    definirTexto('#thread-nome', conversa.contato?.nome || `Conversa ${conversa.id}`);
    definirTexto(
      '#thread-detalhe',
      `${conversa.canal} · ${conversa.status}${conversa.prioridade ? ` · ${conversa.prioridade}` : ''}`
        + `${agenteDaConversaAberta ? ` · ${agenteDaConversaAberta}` : ''}`,
    );

    // A pausa da IA é a informação mais importante da tela: quem responde agora?
    // Em conversa de agente a resposta é do agente, pelo número dele — nunca da Serena.
    const aviso = seletor('#aviso-ia');
    if (agenteDaConversaAberta) {
      aviso.hidden = false;
      aviso.textContent = conversa.assumida_por_humano
        ? `Conversa assumida pela equipe. O ${agenteDaConversaAberta} está pausado nesta conversa.`
        : `Atendida pelo ${agenteDaConversaAberta}. As respostas saem pelo número do agente, não pelo da clínica.`;
    } else {
      aviso.hidden = !conversa.assumida_por_humano;
      aviso.textContent = conversa.assumida_por_humano
        ? 'Conversa assumida pela equipe. A resposta automática está pausada.'
        : '';
    }
    // Conversa que o agente transferiu fica assumida e sem responsável: ainda
    // precisa de alguém que diga "é minha" (achado M1). Na clínica, como antes.
    const agenteSemResponsavel = Boolean(conversa.agente_id) && conversa.assumida_por_humano && !conversa.atribuido_a;
    seletor('.acao[data-acao="assumir"]').hidden = conversa.assumida_por_humano && !agenteSemResponsavel;
    seletor('.acao[data-acao="liberar"]').hidden = !conversa.assumida_por_humano;

    desenharThread(mensagens);
    desenharFicha(conversa, ficha, detalhe.temperatura);

    seletor('#seletor-prioridade').value = conversa.prioridade || '';
    seletor('#seletor-temperatura').value = detalhe.temperatura || '';
    alternarAcoes(true);

    // Temperatura e agenda são do funil e da agenda da clínica (migration 047):
    // quem não vê a clínica não recebe o controle nem dispara a chamada.
    const temperatura = seletor('#seletor-temperatura');
    if (temperatura) temperatura.hidden = !veClinica();
    // Sem `await`: a agenda do paciente é apoio, e a thread não deve esperar
    // por ela para aparecer.
    if (veClinica()) carregarAgendaDaConversa(conversaId);
    else definirTexto('#agenda-da-conversa', '');
  } catch (erro) {
    seletor('#thread-mensagens').innerHTML = '';
    definirTexto('#thread-nome', 'Não foi possível abrir');
    definirTexto('#thread-detalhe', erro.status === 404 ? 'Conversa não encontrada.' : 'Tente novamente.');
    alternarAcoes(false);
  }
}

/** O elemento de mídia certo para o tipo da mensagem — sempre via propriedade DOM, nunca innerHTML. */
function desenharAnexo(mensagem) {
  if (mensagem.tipo === 'imagem') {
    const img = document.createElement('img');
    img.className = 'anexo-imagem';
    img.src = mensagem.media_url;
    img.alt = 'Imagem enviada';
    img.loading = 'lazy';
    return img;
  }
  if (mensagem.tipo === 'video') {
    const video = document.createElement('video');
    video.className = 'anexo-video';
    video.src = mensagem.media_url;
    video.controls = true;
    return video;
  }
  if (mensagem.tipo === 'audio') {
    const audio = document.createElement('audio');
    audio.src = mensagem.media_url;
    audio.controls = true;
    return audio;
  }
  // Documento (ou qualquer tipo futuro sem visualização própria): link direto.
  const link = document.createElement('a');
  link.className = 'anexo-documento';
  link.href = mensagem.media_url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '📄 Abrir documento';
  return link;
}

function desenharThread(mensagens) {
  const thread = seletor('#thread-mensagens');
  thread.innerHTML = '';

  const ROTULOS_DE_EVENTO = {
    conversa_devolvida: 'Conversa devolvida à automação.',
    conversa_resolvida: 'Conversa marcada como resolvida.',
  };

  for (const mensagem of mensagens) {
    const item = document.createElement('li');

    // Bug B, item 2 ("chat completo"): GET /mensagens agora mescla eventos
    // operacionais (conversa_devolvida/resolvida) com as mensagens — são a
    // única transição que hoje não tem aviso de sistema próprio (ver
    // src/dominio/atendimento.js: `assumir` grava um; `liberar`/resolver
    // não gravam). Mesmo balão visual do aviso de sistema, texto conforme o
    // tipo do evento.
    if (mensagem.tipo_item === 'evento') {
      item.className = 'balao-sistema';
      item.textContent = ROTULOS_DE_EVENTO[mensagem.tipo] || mensagem.tipo;
      thread.append(item);
      continue;
    }

    if (mensagem.tipo === 'sistema') {
      item.className = 'balao-sistema';
      item.textContent = mensagem.conteudo || '';
      thread.append(item);
      continue;
    }

    item.className = mensagem.direcao === 'entrada' ? 'recebida' : 'enviada';
    if (mensagem.privada) item.classList.add('privada');
    // Comando 7, achado A-3: a barreira final pode gravar uma resposta e
    // depois bloquear a entrega dela — sem esta marca, a tela mostrava as
    // duas do mesmo jeito, e ninguém enxergava que o paciente não recebeu
    // nada. `entrega_falhou` só existe em mensagens que o backend marcou
    // assim (ver src/dominio/atendimento.js); nunca em mensagem de entrada.
    if (mensagem.entrega_falhou) item.classList.add('nao-entregue');
    // Migration 038/Bug B: "indeterminada" é um terceiro estado, distinto de
    // "falhou" — o canal pode ter entregue ou não, ninguém sabe. Confundir
    // com "não entregue" seria afirmar algo que o sistema não sabe; deixar
    // sem marca nenhuma seria esconder a incerteza da equipe.
    if (mensagem.entrega_indeterminada) item.classList.add('entrega-incerta');

    // Anexo: media_url já chega como URL de leitura assinada, resolvida no
    // backend (o bucket é privado — ver rotas-conversas.js listarMensagens).
    // `src`/`href` via propriedade DOM direta, nunca innerHTML — mesmo
    // padrão de segurança do resto desta função.
    if (mensagem.media_url) item.append(desenharAnexo(mensagem));

    const corpo = document.createElement('span');
    corpo.textContent = mensagem.conteudo || '';

    const rodape = document.createElement('small');
    const autor = mensagem.autor_tipo === 'automacao'
      ? (agenteDaConversaAberta || 'Serena')
      : mensagem.autor_nome || '';
    rodape.textContent = [mensagem.privada ? 'nota interna' : autor, hora(mensagem.criado_em)]
      .filter(Boolean)
      .join(' · ');

    item.append(corpo, rodape);

    if (mensagem.entrega_falhou) {
      const aviso = document.createElement('small');
      aviso.className = 'aviso-nao-entregue';
      aviso.textContent = '⚠ não entregue ao paciente';
      item.append(aviso);
    } else if (mensagem.entrega_indeterminada) {
      const aviso = document.createElement('small');
      aviso.className = 'aviso-entrega-incerta';
      aviso.textContent = '? entrega incerta — não sabemos se chegou ao paciente';
      item.append(aviso);
    }

    thread.append(item);
  }

  thread.scrollTop = thread.scrollHeight;
}

function desenharFicha(conversa, ficha, temperatura) {
  definirTexto('#ficha-nome', ficha?.nome || 'Sem nome');
  definirTexto('#ficha-canal', `${conversa.canal}${conversa.agente_nome ? ` · atendida pelo ${conversa.agente_nome}` : ''}`
    + `${temperatura ? ` · lead ${temperatura}` : ''}`);
  definirTexto('#ficha-telefone', ficha?.telefone || '—');
  definirTexto('#ficha-identificador', ficha?.identificador || '—');
  definirTexto('#ficha-email', ficha?.email || '—');
  // Roda a cada conversa aberta: sem `veClinica()` desfazia o que
  // aplicarEscopoNoMenu escondeu (code review de 12e16b1).
  seletor('#editar-ficha').hidden = !podeFazer('contatos:editar') || !veClinica();

  // Atributos livres da ficha.
  const atributos = seletor('#ficha-atributos');
  atributos.innerHTML = '';
  const pares = Object.entries(ficha?.atributos || {});
  if (pares.length === 0) {
    const vazio = document.createElement('dd');
    vazio.textContent = '—';
    atributos.append(vazio);
  } else {
    for (const [chave, valor] of pares) {
      const rotulo = document.createElement('dt');
      rotulo.textContent = chave;
      const conteudo = document.createElement('dd');
      conteudo.textContent = String(valor);
      atributos.append(rotulo, conteudo);
    }
  }

  desenharQualificacao(conversa);
  desenharEtiquetas(conversa.etiquetas || []);

  const notas = seletor('#ficha-notas');
  notas.innerHTML = '';
  if (!ficha?.notas?.length) avisar(notas, 'Nenhuma nota.');
  else {
    for (const nota of ficha.notas) {
      const item = document.createElement('li');
      item.textContent = nota.texto;
      notas.append(item);
    }
  }

  const anteriores = seletor('#ficha-anteriores');
  anteriores.innerHTML = '';
  if (!ficha?.conversas_anteriores?.length) avisar(anteriores, 'Nenhuma conversa anterior.');
  else {
    for (const anterior of ficha.conversas_anteriores) {
      const item = document.createElement('li');
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'link';
      botao.textContent = `#${anterior.id} · ${anterior.status} · ${haQuanto(anterior.em)}`;
      botao.addEventListener('click', () => abrirConversa(anterior.id));
      item.append(botao);
      anteriores.append(item);
    }
  }
}

const ROTULOS_DE_QUALIFICACAO = {
  interesse: 'Interesse',
  primeira_consulta: 'Primeira consulta',
  pagamento: 'Pagamento',
  urgencia: 'Urgência',
  disponibilidade: 'Horário',
};

/** Mostra o que já se sabe do lead e o que fazer agora. */
function desenharQualificacao(conversa) {
  definirTexto('#ficha-proxima-acao', conversa.proxima_acao || '—');

  const area = seletor('#ficha-qualificacao');
  if (!area) return;
  area.innerHTML = '';

  const respondidos = Object.entries(ROTULOS_DE_QUALIFICACAO)
    .filter(([campo]) => {
      const valor = conversa[campo];
      return valor !== null && valor !== undefined && valor !== '' && !String(valor).startsWith('indefinid');
    });

  if (respondidos.length === 0) {
    const vazio = document.createElement('dd');
    vazio.textContent = 'Nada perguntado ainda.';
    area.append(vazio);
    return;
  }

  for (const [campo, rotulo] of respondidos) {
    const chave = document.createElement('dt');
    chave.textContent = rotulo;

    const valor = document.createElement('dd');
    valor.textContent = campo === 'primeira_consulta'
      ? (conversa[campo] ? 'sim' : 'retorno')
      : String(conversa[campo]);

    area.append(chave, valor);
  }
}

/** Etiquetas como caixas: marcar e desmarcar substitui o conjunto da conversa. */
function desenharEtiquetas(aplicadas) {
  const area = seletor('#ficha-etiquetas');
  area.innerHTML = '';

  for (const etiqueta of etiquetasDisponiveis) {
    const rotulo = document.createElement('label');
    rotulo.className = 'etiqueta-opcao';

    const caixa = document.createElement('input');
    caixa.type = 'checkbox';
    caixa.value = etiqueta.nome;
    caixa.checked = aplicadas.includes(etiqueta.nome);
    caixa.addEventListener('change', salvarEtiquetas);

    const texto = document.createElement('span');
    texto.textContent = etiqueta.nome;

    rotulo.append(caixa, texto);
    area.append(rotulo);
  }
}

async function salvarEtiquetas() {
  if (!conversaAberta) return;
  const marcadas = [...document.querySelectorAll('#ficha-etiquetas input:checked')].map((caixa) => caixa.value);
  await agir('etiquetas', { etiquetas: marcadas });
}

async function agir(caminho, corpo, metodo = 'POST') {
  if (!conversaAberta) return;
  try {
    await pedirJson(`/api/conversas/${conversaAberta}/${caminho}`, { metodo, corpo });
    await abrirConversa(conversaAberta);
    await carregarConversas();
    await carregarLeads();
  } catch {
    definirTexto('#thread-detalhe', 'A ação não pôde ser concluída.');
  }
}

// --- Histórico do contato, ao clicar no nome ---

function fecharHistorico() {
  const painel = seletor('#historico-contato');
  if (!painel) return;
  painel.hidden = true;
  seletor('#thread-nome').setAttribute('aria-expanded', 'false');
}

async function abrirHistorico() {
  if (!contatoAberto) return;
  const painel = seletor('#historico-contato');
  const lista = seletor('#historico-lista');

  if (!painel.hidden) return fecharHistorico();

  painel.hidden = false;
  seletor('#thread-nome').setAttribute('aria-expanded', 'true');
  avisar(lista, 'Carregando…');

  try {
    const { conversas, notas } = await pedirJson(`/api/contatos/${contatoAberto}/conversas`);
    lista.innerHTML = '';

    for (const conversa of conversas) {
      const item = document.createElement('li');
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'link';
      botao.textContent = `#${conversa.id} · ${conversa.status} · ${haQuanto(conversa.ultima_msg_em)}`;
      botao.addEventListener('click', () => { fecharHistorico(); abrirConversa(conversa.id); });
      item.append(botao);
      lista.append(item);
    }

    if (notas.length > 0) {
      const titulo = document.createElement('li');
      titulo.className = 'vazio';
      titulo.textContent = `${notas.length} nota(s) na ficha`;
      lista.append(titulo);
    }
  } catch {
    avisar(lista, 'Não foi possível carregar o histórico.');
  }
}

// --- Kanban de leads ---

async function carregarLeads() {
  const kanban = seletor('#kanban-leads');
  if (!kanban) return;

  try {
    const { colunas } = await pedirJson('/api/leads');
    kanban.innerHTML = '';

    for (const coluna of colunas) {
      const secao = document.createElement('section');
      const titulo = document.createElement('h3');
      titulo.textContent = `${coluna.rotulo} `;
      const total = document.createElement('b');
      total.textContent = coluna.total;
      titulo.append(total);

      const lista = document.createElement('ul');
      for (const lead of coluna.leads) {
        const item = document.createElement('li');

        // Clicar no lead abre a conversa que o originou.
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.className = `card-lead t-${lead.temperatura ?? 'frio'}`;
        botao.textContent = lead.nome || lead.telefone || 'Lead sem nome';

        const detalhe = document.createElement('small');
        detalhe.textContent = lead.origem_detalhe
          ? `${lead.origem} (${lead.origem_detalhe}) · ${lead.temperatura}`
          : `${lead.origem} · ${lead.temperatura}`;

        // Aging: há quantos dias o card está nesta coluna. A cor vem da faixa
        // calculada no servidor — o navegador só pinta.
        if (Number.isInteger(lead.dias_no_estagio)) {
          const idade = document.createElement('span');
          idade.className = `aging aging-${lead.aging ?? 'recente'}`;
          idade.textContent = ` ${lead.dias_no_estagio}d`;
          idade.title = `${lead.dias_no_estagio} dia(s) neste estágio (${lead.aging})`;
          detalhe.append(idade);
        }
        botao.append(detalhe);

        // O próximo passo combinado, visível sem abrir nada: é o que transforma
        // o kanban de galeria de nomes em lista de trabalho.
        if (lead.proximo_passo) {
          const passo = document.createElement('small');
          passo.className = 'proximo-passo';
          passo.textContent = `→ ${lead.proximo_passo}`;
          botao.append(passo);
        }

        if (lead.conversa_id) {
          botao.addEventListener('click', () => {
            abrirTela('conversas');
            abrirConversa(lead.conversa_id);
          });
        } else {
          botao.disabled = true;
        }

        // Arrastar move o lead de etapa. O card carrega o próprio estágio junto
        // do id: soltar na coluna de origem não deve gerar uma escrita nem uma
        // linha de auditoria dizendo que alguém moveu algo que ficou no lugar.
        item.draggable = true;
        item.dataset.leadId = lead.id;
        item.dataset.estagio = coluna.estagio ?? '';
        item.addEventListener('dragstart', (evento) => {
          evento.dataTransfer.setData('text/plain', String(lead.id));
          evento.dataTransfer.effectAllowed = 'move';
          item.classList.add('arrastando');
        });
        item.addEventListener('dragend', () => item.classList.remove('arrastando'));

        item.append(botao);
        lista.append(item);
      }

      // A coluna inteira recebe, não só a lista: soltar no espaço vazio abaixo
      // do último card é o gesto mais natural quando a coluna tem poucos leads.
      secao.dataset.estagio = coluna.estagio ?? '';
      secao.addEventListener('dragover', (evento) => {
        evento.preventDefault();
        evento.dataTransfer.dropEffect = 'move';
        secao.classList.add('recebendo');
      });
      secao.addEventListener('dragleave', () => secao.classList.remove('recebendo'));
      secao.addEventListener('drop', (evento) => {
        evento.preventDefault();
        secao.classList.remove('recebendo');
        const leadId = evento.dataTransfer.getData('text/plain');
        if (leadId) moverLead(leadId, secao.dataset.estagio);
      });

      secao.append(titulo, lista);
      kanban.append(secao);
    }
  } catch (erro) {
    kanban.innerHTML = '';
    avisar(kanban, erro.status === 503 ? 'Inbox indisponível.' : 'Não foi possível carregar os leads.', 'p');
  }
}

// --- Métricas (docs/METRICAS.md) ---

/** Barra proporcional simples: rótulo, barra e "n de d" — denominador sempre à vista. */
function tabelaDeBarras(linhas, { rotulo, valor, denominador = null }) {
  const tabela = document.createElement('table');
  tabela.className = 'tabela-metricas';

  const maior = Math.max(1, ...linhas.map((linha) => Number(linha[valor]) || 0));
  for (const linha of linhas) {
    const tr = document.createElement('tr');

    const nome = document.createElement('td');
    nome.textContent = linha[rotulo];

    const barra = document.createElement('td');
    barra.className = 'barra-celula';
    const preenchimento = document.createElement('span');
    preenchimento.className = 'barra';
    preenchimento.style.width = `${Math.round((Number(linha[valor]) / maior) * 100)}%`;
    barra.append(preenchimento);

    const numero = document.createElement('td');
    numero.className = 'numero';
    const dtotal = denominador ? linha[denominador] : null;
    numero.textContent = dtotal ? `${linha[valor]} de ${dtotal}` : String(linha[valor]);

    tr.append(nome, barra, numero);
    tabela.append(tr);
  }
  return tabela;
}

function blocoDeMetricas(titulo, elemento) {
  const bloco = document.createElement('div');
  bloco.className = 'bloco-metrica';
  const h4 = document.createElement('h4');
  h4.textContent = titulo;
  bloco.append(h4, elemento);
  return bloco;
}

async function carregarMetricas() {
  const contexto = seletor('#metricas-contexto');
  if (!contexto) return;

  const parametros = new URLSearchParams();
  const de = seletor('#metricas-de')?.value;
  const ate = seletor('#metricas-ate')?.value;
  if (de) parametros.set('de', de);
  if (ate) parametros.set('ate', ate);

  carregarMenusDeIA();

  try {
    const resumo = await pedirJson(`/api/metricas/resumo${parametros.size ? `?${parametros}` : ''}`);

    // O contexto obrigatório: período, fuso e filtros, sempre visíveis.
    contexto.textContent = `Período ${resumo.periodo.de} a ${resumo.periodo.ate} (exclusivo) · `
      + `fuso ${resumo.periodo.timezone} · dados sintéticos ${resumo.filtros.dados_sinteticos}`;

    const topo = seletor('#metricas-topo');
    topo.innerHTML = '';
    const numeros = [
      ['LEADS NOVOS', resumo.leads.novos, 'no período'],
      ['CONVERSAS COM INBOUND', resumo.conversas.com_inbound, 'no período'],
      ['1ª RESPOSTA (MEDIANA)', resumo.conversas.primeira_resposta_minutos.mediana ?? '—',
        `min · base ${resumo.conversas.primeira_resposta_minutos.base}`],
      ['AGUARDANDO AGORA', resumo.conversas.backlog_aguardando, 'fotografia'],
    ];
    for (const [titulo, numero, nota] of numeros) {
      const item = document.createElement('li');
      const small = document.createElement('small');
      small.textContent = titulo;
      const strong = document.createElement('strong');
      strong.textContent = String(numero);
      const span = document.createElement('span');
      span.textContent = nota;
      item.append(small, strong, span);
      topo.append(item);
    }

    const esquerda = seletor('#painel-leads-conversas');
    esquerda.innerHTML = '';
    esquerda.append(
      // Primeiro a tendência: "está crescendo?" vem antes de "de onde vem?".
      blocoDeMetricas('Leads por dia', graficoDeLinha(totalPorDia(resumo.leads.por_dia), { rotuloValor: 'total' })),
      blocoDeMetricas('Leads por origem', tabelaDeBarras(resumo.leads.por_origem, {
        rotulo: 'origem', valor: 'total', denominador: 'denominador',
      })),
      blocoDeMetricas('Funil (fotografia de agora)', graficoDeFunil(resumo.leads.funil_fotografia, {
        rotulo: 'estagio', valor: 'total',
      })),
      blocoDeMetricas('Motivos de perda', resumo.leads.motivos_perda.length
        ? tabelaDeBarras(resumo.leads.motivos_perda, { rotulo: 'motivo', valor: 'total' })
        : Object.assign(document.createElement('p'), { className: 'vazio', textContent: 'Nenhuma perda no período.' })),
    );

    const direita = seletor('#painel-agenda-serena');
    direita.innerHTML = '';
    const comparecimento = resumo.agenda.comparecimento;
    const notaComparecimento = document.createElement('p');
    notaComparecimento.className = 'nota-metrica';
    notaComparecimento.textContent = comparecimento.taxa === null
      ? 'Comparecimento: sem consultas concluídas no período.'
      : `Comparecimento: ${comparecimento.taxa}% (${comparecimento.numerador} de ${comparecimento.denominador}).`;

    direita.append(
      blocoDeMetricas('Consultas por status', resumo.agenda.por_status.length
        ? tabelaDeBarras(resumo.agenda.por_status, { rotulo: 'status', valor: 'total' })
        : Object.assign(document.createElement('p'), { className: 'vazio', textContent: 'Nenhuma consulta no período.' })),
      notaComparecimento,
      blocoDeMetricas('Serena — ações na conversa', resumo.serena.por_acao.length
        ? tabelaDeBarras(resumo.serena.por_acao.map((linha) => ({
          ...linha,
          rotulo: linha.motivo && linha.motivo !== '—' ? `${linha.acao} (${linha.motivo})` : linha.acao,
        })), { rotulo: 'rotulo', valor: 'total' })
        : Object.assign(document.createElement('p'), { className: 'vazio', textContent: 'Nenhuma ação da automação no período.' })),
    );
  } catch (erro) {
    contexto.textContent = erro.status === 400
      ? `Período inválido: ${erro.detalhe ?? 'confira as datas.'}`
      : 'Não foi possível carregar as métricas.';
  }
}

seletor('#metricas-aplicar')?.addEventListener('click', carregarMetricas);

// --- IA: menus, relatório e assistente ---

let catalogoDeIA = null;

/** Menus dependentes: escolher o provedor filtra os modelos DELE. */
async function carregarMenusDeIA() {
  if (catalogoDeIA) return;
  try {
    const { provedores } = await pedirJson('/api/ia/modelos');
    catalogoDeIA = provedores;

    const seletorProvedor = seletor('#ia-provedor');
    if (!seletorProvedor) return;
    for (const linha of provedores) {
      const opcao = document.createElement('option');
      opcao.value = linha.provedor;
      opcao.textContent = linha.disponivel ? linha.provedor : `${linha.provedor} (sem chave)`;
      opcao.disabled = !linha.disponivel;
      seletorProvedor.append(opcao);
    }
    seletorProvedor.addEventListener('change', () => {
      const escolhido = catalogoDeIA.find((linha) => linha.provedor === seletorProvedor.value);
      const seletorModelo = seletor('#ia-modelo');
      seletorModelo.innerHTML = '<option value="">automático</option>';
      for (const modelo of escolhido?.modelos ?? []) {
        const opcao = document.createElement('option');
        opcao.value = modelo.modelo;
        opcao.textContent = modelo.padrao ? `${modelo.rotulo} (padrão)` : modelo.rotulo;
        seletorModelo.append(opcao);
      }
    });
  } catch {
    // Sem catálogo o cartão continua funcional no modo automático.
  }
}

seletor('#ia-gerar-relatorio')?.addEventListener('click', async () => {
  const saida = seletor('#ia-relatorio');
  const origem = seletor('#ia-relatorio-origem');
  saida.hidden = false;
  saida.textContent = 'Gerando…';
  origem.hidden = true;

  try {
    const corpo = {};
    const de = seletor('#metricas-de')?.value;
    const ate = seletor('#metricas-ate')?.value;
    if (de) corpo.de = de;
    if (ate) corpo.ate = ate;
    if (seletor('#ia-provedor')?.value) corpo.provedor = seletor('#ia-provedor').value;
    if (seletor('#ia-modelo')?.value) corpo.modelo = seletor('#ia-modelo').value;

    const resultado = await pedirJson('/api/ia/relatorio', { metodo: 'POST', corpo });
    saida.textContent = resultado.relatorio;
    origem.hidden = false;
    origem.textContent = resultado.gerado_por === 'deterministico'
      ? `Gerado sem IA (${resultado.motivo_fallback}): é o resumo determinístico dos mesmos números.`
      : `Gerado por ${resultado.gerado_por}${resultado.de_cache ? ' · reaproveitado do cache do dia' : ''}`
        + `${resultado.fallback_de ? ` · fallback de ${resultado.fallback_de}` : ''}`;
  } catch (erro) {
    saida.textContent = `Não foi possível gerar o relatório: ${erro.detalhe || erro.message}`;
  }
});

seletor('#assistente-perguntar')?.addEventListener('click', async () => {
  const saida = seletor('#assistente-resposta');
  const pergunta = seletor('#assistente-pergunta')?.value.trim();
  if (!pergunta) return;

  saida.hidden = false;
  saida.textContent = 'Pensando…';
  try {
    const resultado = await pedirJson('/api/ia/assistente', {
      metodo: 'POST',
      corpo: { aba: seletor('#assistente-aba')?.value || 'metricas', pergunta },
    });
    saida.textContent = resultado.resposta;
  } catch (erro) {
    saida.textContent = erro.status === 503
      ? 'Nenhum provedor de IA configurado no servidor.'
      : `Não foi possível responder: ${erro.detalhe || erro.message}`;
  }
});

// --- Central de notificações (o sino) ---

async function atualizarSino() {
  const contador = seletor('#sino-contador');
  if (!contador) return;
  try {
    const { total } = await pedirJson('/api/notificacoes');
    contador.textContent = String(total);
    contador.hidden = total === 0;
  } catch { /* sino silencioso é melhor que sino quebrado */ }
}

seletor('#sino-botao')?.addEventListener('click', async () => {
  const lista = seletor('#sino-lista');
  if (!lista.hidden) {
    lista.hidden = true;
    return;
  }

  lista.innerHTML = '';
  lista.hidden = false;
  try {
    const { notificacoes } = await pedirJson('/api/notificacoes');
    if (notificacoes.length === 0) {
      lista.textContent = 'Nenhuma notificação nova.';
      return;
    }
    for (const notificacao of notificacoes) {
      const item = document.createElement('div');
      item.className = 'sino-item';

      const texto = document.createElement('span');
      const titulo = document.createElement('b');
      titulo.textContent = notificacao.titulo;
      texto.append(titulo);
      if (notificacao.corpo) {
        const corpo = document.createElement('small');
        corpo.textContent = notificacao.corpo;
        texto.append(corpo);
      }

      const marcar = document.createElement('button');
      marcar.type = 'button';
      marcar.className = 'link';
      marcar.textContent = 'Lida';
      marcar.addEventListener('click', async () => {
        try {
          await pedirJson(`/api/notificacoes/${notificacao.id}/lida`, { metodo: 'POST', corpo: {} });
          item.remove();
          atualizarSino();
        } catch { /* a próxima abertura recarrega */ }
      });

      item.append(texto, marcar);
      lista.append(item);
    }
  } catch {
    lista.textContent = 'Não foi possível carregar as notificações.';
  }
});

// --- Ligações da interface ---

for (const aba of document.querySelectorAll('.aba[data-fila]')) {
  aba.addEventListener('click', () => {
    filaAtual = aba.dataset.fila;
    for (const outra of document.querySelectorAll('.aba[data-fila]')) {
      const ativa = outra === aba;
      outra.classList.toggle('selecionada', ativa);
      outra.setAttribute('aria-selected', String(ativa));
    }
    carregarConversas();
  });
}

seletor('#abas-escopo-conversas')?.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-escopo-conversas]');
  if (!botao) return;
  escopoDaListaDeConversas = botao.dataset.escopoConversas;
  desenharAbasDeEscopoDasConversas();
  carregarConversas();
});

let buscaAgendada = null;
seletor('#busca-conversas')?.addEventListener('input', () => {
  clearTimeout(buscaAgendada);
  buscaAgendada = setTimeout(carregarConversas, 300);
});

// Um botão só, que alterna: mais recentes primeiro (padrão) ou mais antigas
// primeiro. Duas opções, não um seletor cheio de escolhas.
const botaoOrdenar = seletor('#ordenar-conversas');
botaoOrdenar?.addEventListener('click', () => {
  ordenacaoConversas = ordenacaoConversas === 'desc' ? 'asc' : 'desc';
  botaoOrdenar.dataset.ordenacao = ordenacaoConversas;
  botaoOrdenar.textContent = ordenacaoConversas === 'desc' ? 'Mais recentes ↓' : 'Mais antigas ↑';
  botaoOrdenar.setAttribute(
    'aria-label',
    ordenacaoConversas === 'desc' ? 'Ordenar por data, mais recentes primeiro' : 'Ordenar por data, mais antigas primeiro',
  );
  carregarConversas();
});

const campoData = seletor('#filtro-data-conversas');
const botaoLimparData = seletor('#limpar-data-conversas');
campoData?.addEventListener('change', () => {
  if (botaoLimparData) botaoLimparData.hidden = !campoData.value;
  carregarConversas();
});
botaoLimparData?.addEventListener('click', () => {
  if (!campoData) return;
  campoData.value = '';
  botaoLimparData.hidden = true;
  carregarConversas();
});

// --- Anexo de arquivo no composer ---
//
// Fluxo: o navegador do atendente pede uma URL de upload de uso único
// (POST /anexos, corpo só com metadado — poucos bytes), sobe o ARQUIVO
// direto ao Storage com essa URL (nunca passa pelo nosso servidor: um
// endpoint de JSON não aguenta foto/documento real), e só então manda
// POST /mensagens com o caminho recebido. Allowlist e teto de tamanho
// espelham src/servidor/rotas-conversas.js e src/config.js — checar aqui
// primeiro é só feedback imediato; quem barra de verdade é o backend.
const MIME_ANEXO_PERMITIDO = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'video/mp4',
]);
const TAMANHO_MAXIMO_ANEXO_BYTES = 10 * 1024 * 1024;

let anexoSelecionado = null;

function limparAnexoSelecionado() {
  anexoSelecionado = null;
  const campoArquivo = seletor('#anexo-arquivo');
  if (campoArquivo) campoArquivo.value = '';
  const preview = seletor('#preview-anexo');
  if (preview) preview.hidden = true;
  const nome = seletor('#preview-anexo-nome');
  if (nome) nome.textContent = '';
}

seletor('#botao-anexar')?.addEventListener('click', () => {
  seletor('#anexo-arquivo')?.click();
});

seletor('#anexo-arquivo')?.addEventListener('change', () => {
  const arquivo = seletor('#anexo-arquivo').files?.[0];
  if (!arquivo) return;

  if (!MIME_ANEXO_PERMITIDO.has(arquivo.type)) {
    definirTexto('#thread-detalhe', 'Tipo de arquivo não suportado.');
    seletor('#anexo-arquivo').value = '';
    return;
  }
  if (arquivo.size > TAMANHO_MAXIMO_ANEXO_BYTES) {
    definirTexto('#thread-detalhe', 'Arquivo muito grande (máximo 10MB).');
    seletor('#anexo-arquivo').value = '';
    return;
  }

  anexoSelecionado = arquivo;
  seletor('#preview-anexo-nome').textContent = arquivo.name;
  seletor('#preview-anexo').hidden = false;
});

seletor('#preview-anexo-cancelar')?.addEventListener('click', limparAnexoSelecionado);

/** Sobe o arquivo ao Storage e devolve o que `responder` espera em `anexo`. */
async function prepararEEnviarAnexo(arquivo, conversaId) {
  const preparo = await pedirJson(`/api/conversas/${conversaId}/anexos`, {
    metodo: 'POST',
    corpo: { nome_arquivo: arquivo.name, tipo_mime: arquivo.type, tamanho_bytes: arquivo.size },
  });

  const resposta = await fetch(preparo.upload_url, {
    method: 'PUT',
    headers: { 'content-type': preparo.tipo_mime || arquivo.type },
    body: arquivo,
  });
  if (!resposta.ok) throw new Error(`upload ao Storage falhou: HTTP ${resposta.status}`);

  return { caminho: preparo.caminho, tipo: preparo.tipo, nome: preparo.nome };
}

seletor('#form-resposta')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const campo = seletor('#resposta');
  const texto = campo.value.trim();

  if (!texto && !anexoSelecionado) return;

  if (anexoSelecionado) {
    const arquivo = anexoSelecionado;
    const conversaId = conversaAberta;
    limparAnexoSelecionado();
    campo.value = '';
    try {
      const anexo = await prepararEEnviarAnexo(arquivo, conversaId);
      await agir('mensagens', { texto, anexo });
    } catch {
      definirTexto('#thread-detalhe', 'Não foi possível enviar o anexo. Tente novamente.');
    }
    return;
  }

  campo.value = '';
  await agir('mensagens', { texto });
});

// Campo virou <textarea> multi-linha (Shift+Enter quebra linha, Enter envia)
// — sem isso, Enter sozinho só quebraria linha e nunca enviaria, porque
// textarea, ao contrário de input, não dispara submit no Enter sozinho.
seletor('#resposta')?.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Enter' || evento.shiftKey) return;
  evento.preventDefault();
  seletor('#form-resposta')?.requestSubmit();
});

seletor('#botao-nota')?.addEventListener('click', async () => {
  const campo = seletor('#resposta');
  const texto = campo.value.trim();
  if (!texto) return;

  campo.value = '';
  await agir('notas', { texto });
});

for (const botao of document.querySelectorAll('.acoes-conversa .acao[data-acao]')) {
  botao.addEventListener('click', async () => {
    const acoes = {
      assumir: () => agir('assumir', {}),
      liberar: () => agir('assumir', { liberar: true }),
      resolver: () => agir('estado', { status: 'resolvida' }),
      reabrir: () => agir('estado', { status: 'aberta' }),
    };
    const executar = acoes[botao.dataset.acao];
    if (!executar) return;

    // "Assumir" é o que impede a automação de responder a partir de agora —
    // não cancela uma geração que já estava em voo no instante do clique.
    // Desabilitar aqui evita o duplo clique virando dois comandos
    // concorrentes; "Aplicando…" é o único texto honesto entre o clique e a
    // confirmação do servidor (`agir` já redesenha a barra inteira ao final).
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Aplicando…';
    try {
      await executar();
    } finally {
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  });
}

seletor('#seletor-prioridade')?.addEventListener('change', (evento) => {
  if (evento.target.value) agir('prioridade', { prioridade: evento.target.value });
});

seletor('#seletor-temperatura')?.addEventListener('change', (evento) => {
  if (evento.target.value) agir('temperatura', { temperatura: evento.target.value });
});

seletor('#thread-nome')?.addEventListener('click', abrirHistorico);
seletor('#fechar-historico')?.addEventListener('click', fecharHistorico);

// --- Edição da ficha ---

function alternarEdicaoDaFicha(editando) {
  seletor('#form-ficha').hidden = !editando;
  seletor('#ficha-leitura').hidden = editando;
  seletor('#editar-ficha').textContent = editando ? 'Cancelar' : 'Editar';
}

seletor('#editar-ficha')?.addEventListener('click', () => {
  if (!podeFazer('contatos:editar')) return;
  const editando = seletor('#form-ficha').hidden;
  if (editando) {
    seletor('#ficha-campo-nome').value = seletor('#ficha-nome').textContent.replace('Sem nome', '');
    seletor('#ficha-campo-telefone').value = seletor('#ficha-telefone').textContent.replace('—', '');
    seletor('#ficha-campo-email').value = seletor('#ficha-email').textContent.replace('—', '');

    const pares = [...document.querySelectorAll('#ficha-atributos dt')].map((rotulo) => {
      const valor = rotulo.nextElementSibling?.textContent ?? '';
      return `${rotulo.textContent}: ${valor}`;
    });
    seletor('#ficha-campo-atributos').value = pares.join('\n');
  }
  alternarEdicaoDaFicha(editando);
});

seletor('#cancelar-ficha')?.addEventListener('click', () => alternarEdicaoDaFicha(false));

seletor('#form-ficha')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!conversaAberta) return;

  // "chave: valor" por linha — formato simples o bastante para a recepção usar.
  const atributos = {};
  for (const linha of seletor('#ficha-campo-atributos').value.split('\n')) {
    const separador = linha.indexOf(':');
    if (separador <= 0) continue;
    atributos[linha.slice(0, separador).trim()] = linha.slice(separador + 1).trim();
  }

  const corpo = {
    nome: seletor('#ficha-campo-nome').value.trim() || null,
    telefone: seletor('#ficha-campo-telefone').value.trim() || null,
    email: seletor('#ficha-campo-email').value.trim() || null,
    atributos,
  };

  try {
    await pedirJson(`/api/conversas/${conversaAberta}/ficha`, { metodo: 'PUT', corpo });
    alternarEdicaoDaFicha(false);
    await abrirConversa(conversaAberta);
    await carregarConversas();
  } catch {
    definirTexto('#thread-detalhe', 'Não foi possível salvar a ficha.');
  }
});

// ---------------------------------------------------------------------------
// Campos de senha: o botão de olho.
//
// Ele mostra o que a pessoa está digitando, para conferir antes de enviar.
// Não "descriptografa" nada: a senha guardada é hash, e hash não tem volta —
// nem para nós. É essa a razão de o sistema não conseguir dizer qual é a sua
// senha, só se a que você digitou confere.
// ---------------------------------------------------------------------------

for (const botao of document.querySelectorAll('.olho[data-olho]')) {
  botao.addEventListener('click', () => {
    const campo = document.getElementById(botao.dataset.olho);
    if (!campo) return;

    const mostrando = campo.type === 'text';
    campo.type = mostrando ? 'password' : 'text';
    botao.setAttribute('aria-pressed', String(!mostrando));
    botao.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Ocultar senha');
    campo.focus();
  });
}

// --- Portão de entrada ---

const PAINEIS_DO_PORTAO = ['login', 'cadastro', 'recuperar', 'redefinir'];
let tokenDeRecuperacao = null;

function mostrarPainelDoPortao(nome) {
  for (const painel of PAINEIS_DO_PORTAO) {
    const elemento = seletor(`#form-${painel}`);
    if (elemento) elemento.hidden = painel !== nome;
  }
  limparRetornoDoPortao();
}

function limparRetornoDoPortao() {
  for (const alvo of ['#erro-login', '#aviso-portao']) {
    const elemento = seletor(alvo);
    if (elemento) { elemento.hidden = true; elemento.textContent = ''; }
  }
}

function avisarNoPortao(mensagem, tipo = 'erro') {
  const elemento = seletor(tipo === 'erro' ? '#erro-login' : '#aviso-portao');
  if (!elemento) return;
  elemento.hidden = false;
  elemento.textContent = mensagem;
}

function mostrarPortao(mensagem = '') {
  seletor('#portao').hidden = false;
  seletor('#aplicacao').hidden = true;

  if (mensagem) avisarNoPortao(mensagem);
  else limparRetornoDoPortao();

  seletor('#login-email')?.focus();
}

// Telas que quem não vê a clínica (colaborador da loja) ainda usa.
const TELAS_SEM_CLINICA = new Set(['conversas', 'contatos', 'perfil']);

/**
 * Carrega o escopo da sessão e ajusta menu e abas. Falha na leitura mantém a
 * tela da clínica: o servidor é quem garante o recorte (403/404), e uma
 * oscilação de rede não pode sumir com o menu de quem atende pacientes.
 */
async function prepararEscopoDaSessao() {
  try {
    escopoAtual = await pedirJson('/api/conversas/escopo');
  } catch {
    escopoAtual = { clinica: true, agentes: [], indisponivel: true };
  }
  aplicarEscopoNoMenu();
  desenharAbasDeEscopoDasConversas();
  sincronizarLiberarEmMassa();
}

function aplicarEscopoNoMenu() {
  if (veClinica()) return;
  for (const botao of document.querySelectorAll('nav button[data-tela]')) {
    const item = botao.closest('li');
    if (item && !TELAS_SEM_CLINICA.has(botao.dataset.tela)) item.hidden = true;
  }
  // Grupo do menu sem nenhum item visível some com o título junto.
  for (const grupo of document.querySelectorAll('nav ul')) {
    const vazio = [...grupo.querySelectorAll('li')].every((item) => item.hidden);
    grupo.hidden = vazio;
    const titulo = grupo.previousElementSibling;
    if (titulo?.classList.contains('divisor')) titulo.hidden = vazio;
  }
  // `#editar-ficha` (auditoria de acesso A3): o colaborador não edita o cadastro do contato.
  // `#botao-nota` (B3): a nota vai para a ficha do contato; ele anota com mensagem privada.
  for (const alvo of ['#parada-emergencia', '#liberar-em-massa', '#contato-novo', '#editar-ficha', '#botao-nota']) {
    const elemento = seletor(alvo);
    if (elemento) elemento.hidden = true;
  }
  definirTexto('#contatos .cabecalho p', 'Clientes dos agentes da sua equipe.');
}

function mostrarAplicacao() {
  aplicacaoJaMostrada = true;
  seletor('#portao').hidden = true;
  seletor('#aplicacao').hidden = false;

  definirTexto('#nome-usuario', usuarioAtual?.nome || '—');
  definirTexto('#avatar-usuario', iniciais(usuarioAtual?.nome));

  // Quem não pode priorizar nem editar ficha não vê o controle: esconder o que
  // a pessoa não pode fazer evita o clique que só devolveria 403.
  const prioridade = seletor('#seletor-prioridade');
  if (prioridade) prioridade.hidden = !podeFazer('conversas:priorizar');
  const editarFicha = seletor('#editar-ficha');
  if (editarFicha) editarFicha.dataset.permitido = String(podeFazer('contatos:editar'));

  // Avisos no celular: o convite é para QUEM ENTRA, não só para quem for
  // procurar em Meu perfil.
  oferecerAvisosNoCelular().catch(() => {});

  // A aba de usuários é do administrador master.
  const itemUsuarios = seletor('#item-usuarios');
  if (itemUsuarios) itemUsuarios.hidden = !usuarioAtual?.master;

  // Bloqueio de contato: admin/gestor, mesma regra de contatos:editar.
  const itemBloqueios = seletor('#item-bloqueios');
  if (itemBloqueios) itemBloqueios.hidden = !podeFazer('bloqueios:gerenciar');

  // Agentes: admin e gestor veem; o atendente não tem nada para operar ali.
  const itemAgentes = seletor('#item-agentes');
  if (itemAgentes) itemAgentes.hidden = !podeFazer('agentes:ler');
  // Selo do menu: cliente de agente que pediu a equipe não entra na fila de
  // escalonadas da clínica — o número no menu é por onde alguém fica sabendo.
  iniciarSeloDeAgentes();
  // Sem isto o grupo AGENTES do menu só listaria a Serena até alguém abrir a
  // tela de agentes uma vez.
  if (podeFazer('agentes:ler')) carregarAgentes();

  // O inbox começa a carregar de qualquer forma: a faixa de saúde não pode ficar
  // em "verificando…" só porque a pessoa foi levada ao perfil. Mas só DEPOIS do
  // escopo (migration 047): o colaborador da loja não pode disparar chamada da
  // clínica, e quem só atende agentes cai direto em Conversas.
  prepararEscopoDaSessao().then(() => {
    iniciarInbox();
    if (!veClinica() && !usuarioAtual?.precisa_trocar_senha) abrirTela('conversas');
  });

  // Senha provisória: leva direto ao perfil, e o aviso fica visível até trocar.
  const precisaTrocar = Boolean(usuarioAtual?.precisa_trocar_senha);
  const aviso = seletor('#aviso-trocar-senha');
  if (aviso) aviso.hidden = !precisaTrocar;

  if (precisaTrocar) abrirTela('perfil');

  if (usuarioAtual?.master) carregarUsuarios();

  sincronizarParadaDeEmergencia();
  sincronizarLiberarEmMassa();
}

/** Último estado conhecido do interruptor da Serena (null = ainda não lido). */
let serenaNoAr = null;

// --- Parada de emergência da Serena ---
//
// O interruptor completo mora na tela Serena; este botão existe para o
// momento em que não há tempo de navegar até lá: a IA respondendo errado com
// paciente na linha. Um clique + uma confirmação, de qualquer tela.

function desenharParadaDeEmergencia(ativa) {
  // Guardado para a linha da Serena na tela Agentes: ela mostra o mesmo estado
  // deste botão, sem uma segunda chamada ao interruptor.
  serenaNoAr = ativa;
  desenharEstadoDaSerenaNaLista();
  const botao = seletor('#parada-emergencia');
  if (!botao) return;
  botao.dataset.estado = ativa ? 'armada' : 'parada';
  botao.textContent = ativa ? '⛔ PARAR SERENA' : '⚠ SERENA PARADA — religar';
}

async function sincronizarParadaDeEmergencia() {
  const botao = seletor('#parada-emergencia');
  if (!botao) return;

  // Quem não pode desligar não vê o botão: um clique que devolve 403 no meio
  // de uma urgência é pior que botão nenhum. Mas continua vendo o ESTADO — ele
  // alimenta a linha da Serena na tela Agentes, e ler é de todos (serena:ler).
  // Quem gerencia precisa do estado para o botao; quem so le, para a linha da
  // Serena na tela Agentes. O atendente nao tem nenhuma das duas: o botao fica
  // escondido e ele nunca ve aquela lista, entao nao ha o que perguntar.
  const podeGerenciar = podeFazer('serena:gerenciar');
  botao.hidden = !podeGerenciar;
  if (!podeGerenciar && !(podeFazer('serena:ler') && podeFazer('agentes:ler'))) return;

  try {
    const estado = await pedirJson('/api/serena/interruptor');
    desenharParadaDeEmergencia(estado.ativa);
  } catch {
    // Sem estado, o botão fica armado: no pior caso, parar uma Serena já
    // parada é inofensivo — o contrário (achar que parou e não parou) não é.
    // Para quem só lê não há botão a armar, e afirmar "Atendendo" sem saber
    // seria pior que não dizer nada: a pílula fica de fora.
    if (podeGerenciar) desenharParadaDeEmergencia(true);
  }
}

seletor('#parada-emergencia')?.addEventListener('click', async () => {
  const botao = seletor('#parada-emergencia');
  const parada = botao?.dataset.estado === 'parada';

  if (!parada) {
    const certeza = window.confirm(
      'Parar a Serena AGORA?\n\nNenhum paciente receberá resposta automática até alguém religar. As mensagens continuam sendo recebidas e gravadas no CRM.',
    );
    if (!certeza) return;
    // Só o `disabled` é gerido aqui: o texto do botão, em qualquer desfecho
    // (sucesso ou erro), é responsabilidade de `desenharParadaDeEmergencia` /
    // `sincronizarParadaDeEmergencia` — restaurar um texto fixo aqui por
    // cima delas reintroduziria exatamente a discordância entre painel e
    // estado real que este botão existe para não ter.
    botao.disabled = true;
    botao.textContent = 'Aplicando…';
    try {
      await pedirJson('/api/serena/estado', {
        metodo: 'POST',
        corpo: { ativa: false, motivo: 'PARADA DE EMERGÊNCIA — botão do painel' },
      });
      desenharParadaDeEmergencia(false);
      // "Comando recebido" — não "toda resposta em curso foi cancelada". Uma
      // geração que já estava em voo no instante do clique pode ter sido
      // entregue antes de este comando alcançar a barreira final.
      informar('Comando recebido: Serena PARADA a partir de agora. As mensagens continuam entrando; a equipe assume as respostas. Se havia uma resposta sendo gerada no instante do clique, ela pode ainda ter sido entregue — confira a conversa.');
    } catch (erro) {
      informar(`Não consegui parar: ${erro.message}`);
      sincronizarParadaDeEmergencia();
    } finally {
      botao.disabled = false;
    }
    return;
  }

  if (!window.confirm('Religar a Serena? Ela volta a responder conforme o horário configurado.')) return;
  botao.disabled = true;
  botao.textContent = 'Aplicando…';
  try {
    await pedirJson('/api/serena/estado', { metodo: 'POST', corpo: { ativa: true } });
    desenharParadaDeEmergencia(true);
    informar('Comando recebido: Serena religada.');
  } catch (erro) {
    informar(`Não consegui religar: ${erro.message}`);
    sincronizarParadaDeEmergencia();
  } finally {
    botao.disabled = false;
  }
});

// --- Liberar em massa ---
//
// Achado de 23/08: falha técnica (canal fora do ar) já não trava mais a
// automação sozinha (ver escalonar() em atendimento.js) — mas qualquer
// indisponibilidade anterior a essa correção, ou uma futura, ainda pode
// deixar várias conversas presas de uma vez. Este botão libera de uma vez só
// as que a PRÓPRIA automação travou — nunca as que um humano assumiu de
// verdade (o backend distingue por `atribuido_a`, ver liberarEmMassa).

function sincronizarLiberarEmMassa() {
  const botao = seletor('#liberar-em-massa');
  if (!botao) return;
  // Mesma permissão de assumir/devolver conversa — não é uma ação nova de
  // RBAC, é a mesma ação (liberar) aplicada a várias conversas de uma vez.
  botao.hidden = !podeFazer('conversas:assumir') || (escopoAtual !== null && !veClinica());
}

seletor('#liberar-em-massa')?.addEventListener('click', async () => {
  const botao = seletor('#liberar-em-massa');
  if (!window.confirm(
    'Liberar todas as conversas travadas por falha da automação?\n\nSó afeta conversas que a própria Serena travou sozinha depois de uma falha técnica — nenhuma conversa que um humano assumiu de verdade é mexida.',
  )) return;

  botao.disabled = true;
  const textoOriginal = botao.textContent;
  botao.textContent = 'Liberando…';
  try {
    const resultado = await pedirJson('/api/conversas/liberar-todas', { metodo: 'POST' });
    informar(resultado.detalhe);
    // A lista de conversas (fila "aguardando equipe") precisa refletir a
    // liberação na hora, sem esperar o próximo refresh automático.
    if (typeof carregarConversas === 'function') carregarConversas();
  } catch (erro) {
    informar(`Não consegui liberar: ${erro.message}`);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
});

// --- Conversas ao vivo (Server-Sent Events, log durável) ---
//
// `EventSource` não manda cabeçalho `Authorization` — não há como. Por isso
// a conexão troca em duas etapas: pede um BILHETE de uso único
// (`POST /api/conversas/eventos/ticket`, autenticado normalmente) e só ELE
// vai na URL do EventSource — nunca o token de sessão. `cursorDeEventos`
// guarda o último `id` recebido; toda reconexão (manual, na queda, ou
// abrindo a aba de novo) manda esse cursor, e o servidor reproduz (replay)
// tudo que ficou perdido no intervalo antes de retomar ao vivo — não perde
// eventos, não duplica (ver `src/servidor/eventos-conversas.js`).

let fonteDeEventos = null;
let reconexaoDeEventosAgendada = null;
let cursorDeEventos = null;
let recargaDeEventosAgendada = null;
let recargaPrecisaDaThread = false;

// Cursor MONOTÔNICO — BLOQUEADOR 2 do gate final do PR #34, camada do cliente.
//
// O defeito era `if (typeof dados.id === 'number') cursorDeEventos = dados.id;`:
// gravava o id recebido SEM comparar com o que já havia. Um evento fora de
// ordem (o servidor entregava [2,1] enquanto o empurrão não era serializado —
// mas um proxy, uma reconexão ou outro processo também produzem isso) fazia o
// cursor RETROCEDER. Na reconexão seguinte, o replay reenviava um evento já
// processado e a MENSAGEM APARECIA DUAS VEZES no chat — o bug que este hotfix
// existe para corrigir.
//
// Isto é defesa em profundidade, não substituto: a ordenação no servidor
// continua sendo obrigatória (ver a fila em src/servidor/eventos-conversas.js).
// O cursor é o que sobrevive à reconexão, então ele precisa ser monotônico por
// construção, independentemente do que chegar pelo fio.
//
// Pura de propósito: recebe o cursor atual e devolve o próximo, sem tocar em
// estado — é o que permite testá-la de verdade sem navegador
// (testes/chat-ao-vivo-cursor-monotonico.test.js).
function proximoCursorDeEventos(cursorAtual, idRecebido) {
  // `Math.max(cursorAtual, Number(idRecebido))` seria a forma curta e é
  // exatamente a armadilha: com `undefined`, `'abc'` ou `{}`, `Number` devolve
  // NaN, `Math.max` propaga NaN, todo `>` seguinte vira false em silêncio e a
  // reconexão passa a mandar `cursor=NaN` — o cursor morre e o replay volta a
  // duplicar. Por isso a validação vem ANTES de qualquer comparação.
  //
  // Aceitar texto além de número não é frouxidão: o servidor entrega `id` como
  // número (`Number(linha.id)` em src/dados/repositorio.js), mas `Last-Event-ID`
  // e qualquer intermediário trafegam texto. Recusar "7" faria o cursor
  // simplesmente PARAR DE AVANÇAR, que termina no mesmo replay duplicado.
  let id;
  if (typeof idRecebido === 'number') {
    id = idRecebido;
  } else if (typeof idRecebido === 'string' && idRecebido.trim() !== '') {
    id = Number(idRecebido);
  } else {
    return cursorAtual;
  }
  // `id` é um bigserial do Postgres: inteiro e não negativo. Qualquer outra
  // coisa (NaN, Infinity, fracionário, negativo) é ruído e não move o cursor.
  if (!Number.isInteger(id) || id < 0) return cursorAtual;
  if (cursorAtual === null || id > cursorAtual) return id;
  return cursorAtual;
}

function encerrarEventosDeConversas() {
  clearTimeout(reconexaoDeEventosAgendada);
  reconexaoDeEventosAgendada = null;
  // A recarga coalescida também precisa morrer aqui: `limparSessao` chama esta
  // função no logout, e um timer sobrevivente dispararia `pedirJson` já sem
  // token — 401 e ruído logo depois de sair.
  clearTimeout(recargaDeEventosAgendada);
  recargaDeEventosAgendada = null;
  recargaPrecisaDaThread = false;
  fonteDeEventos?.close();
  fonteDeEventos = null;
}

// Gate 2 da auditoria ("chat realmente ao vivo", 2026-08-15): antes só
// mensagem_recebida/mensagem_enviada reagiam aqui — conversa_assumida,
// conversa_devolvida, conversa_resolvida, status_entrega e erro (envio
// abortado pela barreira) eram publicados no log durável (Pendência 4) mas
// IGNORADOS pela tela: só apareciam ao trocar de conversa ou recarregar a
// página. Todos os tipos do CHECK de conversas_eventos (migration 037)
// precisam reagir da mesma forma — não há tipo "silencioso" nesta lista.
const TIPOS_DE_EVENTO_CONHECIDOS = [
  'mensagem_recebida', 'mensagem_enviada', 'status_entrega',
  'conversa_assumida', 'conversa_devolvida', 'conversa_resolvida', 'erro',
];

// Janela de coalescência das recargas disparadas por evento ao vivo.
//
// Sem ela, CADA evento vira uma chamada HTTP. O replay de reconexão entrega
// muitos eventos de uma vez (o servidor devolve até 500 — ver
// `listarEventosDeConversasDesde` em src/dados/repositorio.js), e a tela
// dispararia centenas de requisições em rajada, por aba. Numa recepção com
// várias abas abertas isso vira ataque ao próprio servidor que este lote
// acabou de consertar. 250ms é imperceptível para quem atende e transforma a
// rajada em UMA recarga — o que importa é o ESTADO final, não quantos
// eventos o produziram.
const JANELA_DE_COALESCENCIA_MS = 250;

function reagirAEventoDeConversa(dados) {
  // Nunca retrocede (ver `proximoCursorDeEventos`). Repare que o evento
  // atrasado NÃO é descartado: ele carrega estado real (mensagem nova, status
  // de entrega, conversa resolvida) e a tela precisa reagir a ele. O que não
  // pode é ele mandar o cursor para trás.
  cursorDeEventos = proximoCursorDeEventos(cursorDeEventos, dados?.id);

  if (!TIPOS_DE_EVENTO_CONHECIDOS.includes(dados?.tipo)) return;

  // A conversa aberta ganha a atualização na hora — sem esperar o próximo
  // clique nem precisar recarregar a página. Cobre mensagem nova, status de
  // entrega (entregue/falhou/indeterminada), assumir/devolver/resolver e
  // aborto pela barreira — todos afetam o que a thread mostra.
  if (dados.conversa_id === conversaAberta) recargaPrecisaDaThread = true;

  // Já existe recarga agendada: este evento entra nela em vez de criar outra.
  if (recargaDeEventosAgendada) return;

  recargaDeEventosAgendada = setTimeout(() => {
    recargaDeEventosAgendada = null;
    const precisaDaThread = recargaPrecisaDaThread;
    recargaPrecisaDaThread = false;

    // A lista sempre reflete o estado novo: prévia, "há X min", fila (assumida/
    // devolvida/resolvida mudam quem vê a conversa em qual fila) e ordenação.
    if (!seletor('#conversas')?.hidden) carregarConversas();

    if (precisaDaThread && conversaAberta) {
      pedirJson(`/api/conversas/${conversaAberta}/mensagens`).then(desenharThread).catch(() => {});
    }
  }, JANELA_DE_COALESCENCIA_MS);
}

async function conectarEventosDeConversas() {
  if (!accessToken || typeof EventSource === 'undefined') return;
  encerrarEventosDeConversas();

  let ticket;
  try {
    ({ ticket } = await pedirJson('/api/conversas/eventos/ticket', { metodo: 'POST' }));
  } catch {
    // Sem bilhete, sem conexão — tenta de novo no mesmo ritmo do onerror.
    reconexaoDeEventosAgendada = setTimeout(conectarEventosDeConversas, 5000);
    return;
  }

  const cursor = cursorDeEventos !== null ? `&cursor=${encodeURIComponent(cursorDeEventos)}` : '';
  fonteDeEventos = new EventSource(`/api/conversas/eventos?ticket=${encodeURIComponent(ticket)}${cursor}`);

  fonteDeEventos.onmessage = (evento) => {
    let dados;
    try {
      dados = JSON.parse(evento.data);
    } catch {
      return;
    }
    reagirAEventoDeConversa(dados);
  };

  fonteDeEventos.onerror = () => {
    encerrarEventosDeConversas();
    // Um intervalo fixo evita martelar o servidor se ele estiver fora do ar;
    // 5s ainda é rápido o bastante para não se notar numa queda passageira.
    // `cursorDeEventos` já guarda onde parou — a próxima chamada reproduz o
    // que foi perdido nesses 5s, não parte do zero.
    reconexaoDeEventosAgendada = setTimeout(conectarEventosDeConversas, 5000);
  };
}

// --- Versão no ar e aviso de atualização ---
//
// Achado do incidente de 2026-08-17: o rodapé mostrava "v0.1" fixo, sempre —
// nunca refletiu nenhum deploy real, e depois da correção do Single Writer
// também ficou factualmente errado ("orquestrado pelo OpenClaw": não é mais
// o OpenClaw quem decide o envio). Além disso, quem fica com a aba aberta
// por horas nunca sabia que subiu uma versão nova.
//
// `commit` (de /health) é o identificador que muda a cada deploy de verdade
// — `versao` (package.json) só muda quando alguém lembra de dar bump.
let commitCarregadoNestaAba = null;

// Tira o `?v=` da barra depois que ele ja obrigou a recarga — deixar na URL
// faria a pessoa compartilhar um link com lixo, e o proximo F5 repetiria.
(function limparMarcaDeRecarga() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('v')) return;
  url.searchParams.delete('v');
  window.history.replaceState({}, '', url.toString());
})();

async function verificarNovaVersao() {
  let saude;
  try {
    saude = await pedirJson('/health');
  } catch {
    // /health falhar não pode quebrar a tela — só não avisamos desta vez.
    return;
  }

  const rodape = seletor('#rodape-versao');
  if (rodape) {
    rodape.textContent = `crmclinica v${saude.versao}${saude.commit ? ` · ${saude.commit.slice(0, 7)}` : ''}`;
  }

  if (commitCarregadoNestaAba === null) {
    // Primeira leitura desta aba: só registra a baseline, não compara ainda
    // — senão toda aba recém-aberta "descobriria" uma versão nova na hora.
    commitCarregadoNestaAba = saude.commit;
    return;
  }

  // Sem `commit` (rodando fora da Vercel — VPS, local) não há como comparar
  // com segurança: o botão simplesmente nunca aparece, o que é seguro.
  if (saude.commit && saude.commit !== commitCarregadoNestaAba) {
    const botao = seletor('#banner-atualizar');
    if (botao) botao.hidden = false;
  }
}

seletor('#banner-atualizar')?.addEventListener('click', () => {
  // `reload()` puro pode reaproveitar o cache. Um parametro novo na URL
  // obriga o navegador a buscar tudo de novo — e some da barra depois, porque
  // o proprio carregamento seguinte reescreve o endereco.
  const url = new URL(window.location.href);
  url.searchParams.set('v', Date.now().toString(36));
  window.location.replace(url.toString());
});

// Voltar para a aba e o momento em que a pessoa REALMENTE vai usar a tela —
// checar aqui avisa na hora certa, sem esperar o proximo ciclo de 5 minutos.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && inboxIniciado) verificarNovaVersao();
});

let inboxIniciado = false;
function iniciarInbox() {
  if (inboxIniciado) return;
  inboxIniciado = true;

  verificarNovaVersao();
  // 5 minutos: rápido o bastante para quem passa o dia com a aba aberta
  // saber logo depois de um deploy, sem martelar o servidor com polling.
  setInterval(verificarNovaVersao, 5 * 60 * 1000);

  // Resumo do painel Hoje e leads são da clínica (migration 047).
  if (veClinica()) {
    carregarResumo();
    setInterval(carregarResumo, 60000);
  }

  carregarEtiquetas().then(() => {
    carregarConversas();
    if (veClinica()) carregarLeads();
  });
  conectarEventosDeConversas();
  // Rede de segurança: se o SSE cair sem disparar `onerror` (proxy silencioso,
  // aba em segundo plano), a lista ainda se atualiza sozinha, só que devagar.
  setInterval(carregarConversas, 30000);
}

for (const gatilho of document.querySelectorAll('[data-portao]')) {
  gatilho.addEventListener('click', () => mostrarPainelDoPortao(gatilho.dataset.portao));
}

seletor('#form-login')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  limparRetornoDoPortao();

  const email = seletor('#login-email').value.trim();
  const senha = seletor('#login-senha').value;
  const codigo = seletor('#login-codigo')?.value.trim() || null;
  if (!email || !senha) return;

  try {
    const resposta = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha, codigo }),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.json().catch(() => ({}));

      // Falta o código do segundo fator: mostrar o campo em vez de dizer
      // "senha errada", que mandaria a pessoa procurar o problema no lugar errado.
      if (detalhe.segundo_fator) {
        seletor('#bloco-codigo').hidden = false;
        seletor('#login-codigo').focus();
        avisarNoPortao(
          detalhe.segundo_fator === 'incorreto'
            ? 'Código incorreto. Tente o número atual do aplicativo.'
            : 'Digite o código do seu aplicativo autenticador.',
          detalhe.segundo_fator === 'incorreto' ? 'erro' : 'aviso',
        );
        return;
      }
      // Conta na fila ou recusada: a pessoa precisa saber que não é a senha.
      if (resposta.status === 403 && detalhe.situacao) {
        avisarNoPortao(detalhe.erro);
        return;
      }
      throw new Error('credenciais inválidas');
    }

    guardarSessao(await resposta.json());
    seletor('#login-senha').value = '';
    if (seletor('#login-codigo')) seletor('#login-codigo').value = '';
    mostrarAplicacao();
  } catch {
    // Mensagem única: dizer "e-mail não existe" entregaria quem tem conta.
    avisarNoPortao('E-mail ou senha incorretos.');
  }
});

seletor('#form-cadastro')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  limparRetornoDoPortao();

  const corpo = {
    nome: seletor('#cadastro-nome').value.trim(),
    email: seletor('#cadastro-email').value.trim(),
    senha: seletor('#cadastro-senha').value,
  };

  try {
    const resposta = await fetch('/api/auth/cadastro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.erro || 'não foi possível cadastrar');

    mostrarPainelDoPortao('login');
    avisarNoPortao(dados.detalhe, 'aviso');
  } catch (erro) {
    avisarNoPortao(erro.message);
  }
});

seletor('#form-recuperar')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  limparRetornoDoPortao();

  try {
    const resposta = await fetch('/api/auth/recuperar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: seletor('#recuperar-email').value.trim() }),
    });
    const dados = await resposta.json();

    mostrarPainelDoPortao('login');
    // Resposta idêntica com ou sem conta: a tela não pode revelar quem tem cadastro.
    avisarNoPortao(dados.detalhe || 'Se houver uma conta com esse e-mail, o link foi enviado.', 'aviso');
  } catch {
    avisarNoPortao('Não foi possível enviar o link agora.');
  }
});

seletor('#form-redefinir')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  limparRetornoDoPortao();

  try {
    const resposta = await fetch('/api/auth/redefinir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: tokenDeRecuperacao,
        senha_nova: seletor('#redefinir-senha').value,
      }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.erro || 'link inválido ou expirado');

    tokenDeRecuperacao = null;
    mostrarPainelDoPortao('login');
    avisarNoPortao('Senha alterada. Entre com a senha nova.', 'aviso');
  } catch (erro) {
    avisarNoPortao(erro.message);
  }
});

seletor('#entrar-google')?.addEventListener('click', async () => {
  try {
    const { url } = await pedirJson('/api/auth/google');
    window.location.href = url;
  } catch {
    avisarNoPortao('O login com Google não está disponível agora.');
  }
});

/** Descobre o que a tela de entrada deve oferecer. */
async function carregarOpcoesDeEntrada() {
  try {
    const opcoes = await pedirJson('/api/auth/opcoes');

    const botaoGoogle = seletor('#entrar-google');
    if (botaoGoogle) botaoGoogle.hidden = !opcoes.google;

    // "Esqueci minha senha" aparece SEMPRE. Antes ele sumia quando o servidor
    // estava sem SMTP — e quem esquecia a senha ficava sem nenhuma pista do que
    // fazer. Sem envio configurado, o painel explica o caminho que funciona
    // (senha temporária pelo administrador) em vez de oferecer um formulário
    // cujo e-mail nunca chegaria.
    const semEmail = !opcoes.recuperacao_por_email;
    const aviso = seletor('#recuperar-sem-email');
    if (aviso) aviso.hidden = !semEmail;
    const campos = seletor('#recuperar-campos');
    if (campos) campos.hidden = semEmail;
    const nota = seletor('#recuperar-nota');
    if (nota) nota.hidden = semEmail;
    const campoEmail = seletor('#recuperar-email');
    // Campo escondido e obrigatório trava o envio do formulário no navegador.
    if (campoEmail) campoEmail.required = !semEmail;
  } catch {
    // Sem as opções, a entrada por e-mail e senha continua funcionando.
  }
}

seletor('#sair')?.addEventListener('click', async () => {
  // Renovação em andamento gira o refresh: sem esperar, o logout revogaria o
  // velho e o novo, gravado logo depois, manteria a pessoa logada após a recarga.
  if (renovacaoEmAndamento) await renovacaoEmAndamento.catch(() => {});

  // Sair desliga os avisos DESTE aparelho.
  //
  // No computador do balcão, quem sai não pode continuar recebendo no aparelho
  // que ficou — e, desde que o aviso leva nome do paciente e o começo da
  // mensagem, isso seria mostrar a conversa de um atendimento para a próxima
  // pessoa que sentar ali. Quem entrar depois inscreve o aparelho em nome
  // próprio (oferecerAvisosNoCelular), sem precisar autorizar de novo.
  await desligarAvisosDoCelular({ silencioso: true }).catch(() => {});

  const refresh = lerRefresh();

  if (refresh) {
    // Encerrar do lado do servidor é o que revoga de verdade. `keepalive`: o
    // pedido sobrevive ao recarregamento que encerrarSessaoNaTela faz logo abaixo.
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
      keepalive: true,
    }).catch(() => {});
  }
  encerrarSessaoNaTela();
});

// ---------------------------------------------------------------------------
// Usuários — liberação de acesso pelo administrador master.
// ---------------------------------------------------------------------------

const ROTULOS_DE_SITUACAO = {
  pendente: 'Aguardando liberação',
  ativo: 'Ativo',
  recusado: 'Recusado',
  desativado: 'Desativado',
};

const ROTULOS_DE_PAPEL = { admin: 'Administrador', gestor: 'Gestor', atendente: 'Atendente' };

async function carregarUsuarios() {
  const lista = seletor('#lista-usuarios');
  if (!lista || !usuarioAtual?.master) return;

  try {
    const { usuarios, pendentes } = await pedirJson('/api/usuarios');

    definirTexto(
      '#resumo-usuarios',
      `${usuarios.length} conta(s)${pendentes ? ` · ${pendentes} aguardando liberação` : ''}`,
    );

    const contador = seletor('#contador-pendentes');
    if (contador) {
      contador.hidden = pendentes === 0;
      contador.textContent = pendentes;
    }

    lista.innerHTML = '';
    if (usuarios.length === 0) { avisar(lista, 'Nenhuma conta cadastrada.'); return; }

    for (const usuario of usuarios) lista.append(montarLinhaDeUsuario(usuario));
    // Quem recebe os resumos muda com a lista (pausa, equipe, "vê a clínica").
    carregarPainelDeResumos();
  } catch (erro) {
    avisar(lista, erro.status === 403 ? 'Apenas o administrador master vê esta lista.' : 'Não foi possível carregar.');
  }
}

/**
 * Apaga a conta de vez, com confirmacao que diz o que nao tem volta.
 *
 * O nome digitado nao e teatro: e o que separa "cliquei sem ler" de "eu quis
 * apagar esta pessoa". Um ato sem volta merece um segundo de atrito.
 */
async function excluirUsuario(usuario) {
  const aviso = [
    `Excluir a conta de ${usuario.nome} (${usuario.email})?`,
    '',
    'Isto NAO tem volta. O que acontece:',
    '• a conta some da lista e do sistema;',
    '• o historico de atendimento permanece, mas sem o nome de quem fez;',
    '• fica registrado na Auditoria quem excluiu, quando, e os dados da conta.',
    '',
    'Se voce so quer tirar o acesso, use Desativar — e reversivel.',
  ].join(String.fromCharCode(10));
  if (!window.confirm(aviso)) return;

  const digitado = window.prompt(`Para confirmar, digite o nome da pessoa: ${usuario.nome}`);
  if (digitado === null) return;
  if (digitado.trim().toLowerCase() !== String(usuario.nome ?? '').trim().toLowerCase()) {
    informar('Nome nao confere. Nada foi excluido.');
    return;
  }

  const motivo = window.prompt('Motivo (opcional, fica na auditoria):') ?? null;

  try {
    await pedirJson(`/api/usuarios/${Number(usuario.id)}`, { metodo: 'DELETE', corpo: { motivo } });
    informar(`Conta de ${usuario.nome} excluida.`);
    await carregarUsuarios();
  } catch (erro) {
    informar(`Nao consegui excluir: ${erro.detalhe || erro.message}`);
  }
}

function montarLinhaDeUsuario(usuario) {
  const linha = document.createElement('li');
  linha.className = `usuario situacao-${usuario.situacao}`;

  const identidade = document.createElement('div');
  identidade.className = 'usuario-identidade';

  const nome = document.createElement('b');
  nome.textContent = usuario.nome + (usuario.master ? ' · master' : '');
  const email = document.createElement('small');
  email.textContent = usuario.email;
  identidade.append(nome, email);

  const selos = document.createElement('div');
  selos.className = 'selos';

  const situacao = document.createElement('span');
  situacao.className = `etiqueta sit-${usuario.situacao}`;
  situacao.textContent = ROTULOS_DE_SITUACAO[usuario.situacao] || usuario.situacao;
  selos.append(situacao);

  if (usuario.totp_ativo) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta';
    selo.textContent = '2FA';
    selos.append(selo);
  }
  if (usuario.google_vinculado) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta';
    selo.textContent = 'Google';
    selos.append(selo);
  }
  // Migration 047: colaborador (não vê a clínica) e as equipes de agente.
  if (usuario.acesso_clinica === false) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta';
    selo.textContent = 'Colaborador (só agentes)';
    selos.append(selo);
    if (!(usuario.equipes ?? []).length) {
      const aviso = document.createElement('span');
      aviso.className = 'etiqueta sit-recusado';
      aviso.textContent = 'Não vê nada: coloque numa equipe de agente';
      selos.append(aviso);
    }
  }
  for (const equipe of usuario.equipes ?? []) {
    const selo = document.createElement('span');
    selo.className = 'etiqueta agente';
    selo.textContent = `Equipe: ${equipe.nome ?? `agente #${Number(equipe.id)}`}`;
    selos.append(selo);
  }

  const acoes = document.createElement('div');
  acoes.className = 'usuario-acoes';

  // A conta do master não é alterável — nem por ele mesmo.
  if (!usuario.master) {
    const papel = document.createElement('select');
    papel.className = 'acao';
    papel.setAttribute('aria-label', `Papel de ${usuario.nome}`);
    for (const [valor, rotulo] of Object.entries(ROTULOS_DE_PAPEL)) {
      const opcao = document.createElement('option');
      opcao.value = valor;
      opcao.textContent = rotulo;
      opcao.selected = usuario.papel === valor;
      papel.append(opcao);
    }
    papel.addEventListener('change', () => agirNoUsuario(usuario.id, 'papel', { papel: papel.value }));
    acoes.append(papel);

    // "Vê a clínica" (migration 047). O administrador sempre vê: sem chave.
    if (usuario.papel !== 'admin') {
      const marca = document.createElement('label');
      marca.className = 'marcador';
      marca.title = 'Desmarcado = só as conversas dos agentes em que a pessoa estiver na Equipe.';
      const caixa = document.createElement('input');
      caixa.type = 'checkbox';
      caixa.checked = usuario.acesso_clinica !== false;
      caixa.setAttribute('aria-label', `${usuario.nome} vê a clínica`);
      caixa.addEventListener('change', () => agirNoUsuario(usuario.id, 'acesso-clinica', { acesso_clinica: caixa.checked }));
      const texto = document.createElement('span');
      texto.textContent = 'Vê a clínica';
      marca.append(caixa, texto);
      acoes.append(marca);
    }

    const botoes = usuario.situacao === 'pendente'
      ? [['Liberar', 'ativo', 'primario'], ['Recusar', 'recusado', 'acao']]
      : usuario.situacao === 'ativo'
        ? [['Desativar', 'desativado', 'acao']]
        : [['Liberar', 'ativo', 'primario']];

    for (const [rotulo, situacaoNova, classe] of botoes) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = classe;
      botao.textContent = rotulo;
      botao.addEventListener('click', () => agirNoUsuario(usuario.id, 'situacao', { situacao: situacaoNova }));
      acoes.append(botao);
    }

    // Excluir de vez (pedido de 12/09/2026). So em conta ja desativada: quem
    // ainda trabalha na clinica se desativa primeiro, e o primeiro passo ja
    // tira o acesso — que e a urgencia real quando alguem sai. Dois passos
    // para um ato sem volta.
    const podeExcluir = usuario.situacao !== 'ativo' && !usuario.master
      && Number(usuario.id) !== Number(usuarioAtual?.id);
    if (podeExcluir) {
      const excluir = document.createElement('button');
      excluir.type = 'button';
      excluir.className = 'perigo';
      excluir.textContent = 'Excluir';
      excluir.setAttribute('aria-label', `Excluir a conta de ${usuario.nome}`);
      excluir.addEventListener('click', () => excluirUsuario(usuario));
      acoes.append(excluir);
    }
  }

  // Resumo por equipe (docs/RESUMOS.md): a pausa por pessoa, e o aviso de quem
  // deveria receber e não recebe. O número nunca vem para a tela.
  const recebeResumo = document.createElement('label');
  recebeResumo.className = 'marcador';
  recebeResumo.title = 'Resumo da equipe no WhatsApp da pessoa, a cada 2 horas.';
  const caixaDoResumo = document.createElement('input');
  caixaDoResumo.type = 'checkbox';
  caixaDoResumo.checked = usuario.recebe_resumo !== false;
  caixaDoResumo.setAttribute('aria-label', `${usuario.nome} recebe resumos`);
  caixaDoResumo.addEventListener('change', () => agirNoUsuario(usuario.id, 'recebe-resumo', { recebe_resumo: caixaDoResumo.checked }));
  const textoDoResumo = document.createElement('span');
  textoDoResumo.textContent = 'Recebe resumos';
  recebeResumo.append(caixaDoResumo, textoDoResumo);
  acoes.append(recebeResumo);

  // WhatsApp e autorização (P1-06): abre o cartão do admin. O número em claro
  // só existe lá; a lista nunca o recebe.
  const botaoWhatsapp = document.createElement('button');
  botaoWhatsapp.type = 'button';
  botaoWhatsapp.className = 'acao';
  botaoWhatsapp.textContent = 'WhatsApp';
  botaoWhatsapp.setAttribute('aria-label', `WhatsApp de ${usuario.nome}`);
  botaoWhatsapp.addEventListener('click', () => abrirWhatsappDoUsuario(usuario.id));
  acoes.append(botaoWhatsapp);

  const estariaNumaEquipe = usuario.papel === 'admin' || usuario.acesso_clinica !== false || (usuario.equipes ?? []).length > 0;
  if (usuario.recebe_resumo !== false && estariaNumaEquipe
    && ['sem_whatsapp', 'whatsapp_nao_autorizado'].includes(usuario.motivo_sem_resumo)) {
    const aviso = document.createElement('span');
    aviso.className = 'etiqueta sit-recusado';
    aviso.textContent = usuario.motivo_sem_resumo === 'sem_whatsapp'
      ? 'Não recebe resumos: sem WhatsApp no cadastro'
      : 'Não recebe resumos: WhatsApp sem autorização';
    selos.append(aviso);
  }

  linha.append(identidade, selos, acoes);
  return linha;
}

/**
 * Gera uma senha temporária e a mostra uma única vez.
 *
 * Ela não é guardada em lugar nenhum — nem em claro no banco, nem na
 * auditoria. Quem administra copia, entrega pessoalmente, e a troca é exigida
 * no primeiro acesso. Fechada a janela, só gerando outra.
 */
async function redefinirSenhaDe(usuario) {
  const confirmado = confirm(
    `Gerar uma senha temporária para ${usuario.nome}?

`
    + 'A senha atual deixa de valer, as sessões abertas caem, e a troca será '
    + 'exigida no primeiro acesso.',
  );
  if (!confirmado) return;

  try {
    const resposta = await pedirJson(`/api/usuarios/${usuario.id}/senha`, { metodo: 'POST' });
    window.alert(
      `Senha temporária de ${usuario.nome}:

${resposta.senha_temporaria}

`
      + 'Anote agora: ela não aparece de novo. Entregue pessoalmente.',
    );
    await carregarUsuarios();
  } catch (erro) {
    window.alert(`Não foi possível redefinir: ${erro.message}`);
  }
}

// WhatsApp de uma pessoa da equipe (docs/RESUMOS.md). O número vai pela edição
// completa já existente (PUT /api/usuarios/:id, validação de `whatsappValido`); a
// autorização, pela rota de P1-06 (POST /api/usuarios/:id/whatsapp-particular),
// que grava e audita quem autorizou e quando. O número em claro só existe neste
// formulário do admin; na lista e no painel, nunca.
let whatsappEmEdicao = null;

function desenharWhatsappDoUsuario(ficha) {
  const cartao = seletor('#cartao-whatsapp-usuario');
  if (!cartao) return;
  whatsappEmEdicao = Number(ficha.id);
  cartao.hidden = false;
  definirTexto('#whatsapp-usuario-titulo', `WhatsApp de ${ficha.nome ?? 'usuário'}`);
  seletor('#whatsapp-usuario-ddi').value = ficha.whatsapp_ddi ?? '55';
  seletor('#whatsapp-usuario-ddd').value = ficha.whatsapp_ddd ?? '';
  seletor('#whatsapp-usuario-numero').value = ficha.whatsapp_numero ?? '';
  const erro = seletor('#whatsapp-usuario-erro');
  erro.textContent = '';
  erro.hidden = true;

  const temNumero = Boolean(ficha.whatsapp_ddd && ficha.whatsapp_numero);
  const caixa = seletor('#whatsapp-usuario-autorizado');
  caixa.checked = ficha.whatsapp_particular_autorizado === true;
  caixa.disabled = !temNumero && !caixa.checked;
  definirTexto('#whatsapp-usuario-situacao', !temNumero
    ? 'Sem WhatsApp no cadastro: não recebe resumos.'
    : (caixa.checked ? 'WhatsApp cadastrado e autorizado.' : 'WhatsApp cadastrado, sem autorização: não recebe resumos.'));
  definirTexto('#whatsapp-usuario-registro', caixa.checked
    ? `Autorizado por ${ficha.whatsapp_particular_autorizado_por_nome ?? 'administrador'} em ${dataHoraDoPainelDoAgente(ficha.whatsapp_particular_autorizado_em) || '—'}.`
    : (temNumero ? 'Ainda não autorizado.' : 'Cadastre o número antes de autorizar.'));
}

async function abrirWhatsappDoUsuario(id) {
  const alvo = Number(id);
  whatsappEmEdicao = alvo;
  try {
    const { usuario: ficha } = await pedirJson(`/api/usuarios/${alvo}`);
    // Outra pessoa aberta enquanto esta carregava: a resposta velha é descartada.
    if (whatsappEmEdicao !== alvo) return;
    desenharWhatsappDoUsuario(ficha);
    seletor('#whatsapp-usuario-ddd')?.focus();
  } catch (erro) {
    definirTexto('#resumo-usuarios', erro.detalhe || 'Não foi possível abrir o WhatsApp desta pessoa.');
  }
}

/** Depois de gravar: a ficha de novo, a lista (avisos) e o painel "Quem recebe os resumos". */
async function depoisDeMudarWhatsapp(alvo) {
  const { usuario: ficha } = await pedirJson(`/api/usuarios/${alvo}`);
  if (whatsappEmEdicao === alvo) desenharWhatsappDoUsuario(ficha);
  await carregarUsuarios();
}

seletor('#form-whatsapp-usuario')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const alvo = whatsappEmEdicao;
  if (!alvo) return;
  const erro = seletor('#whatsapp-usuario-erro');
  erro.hidden = true;

  const ddd = seletor('#whatsapp-usuario-ddd').value.trim();
  const numero = seletor('#whatsapp-usuario-numero').value.trim();
  // DDD e número vazios = tirar o WhatsApp do cadastro (o DDI sozinho não é número).
  const whatsapp = !ddd && !numero
    ? { ddi: null, ddd: null, numero: null }
    : { ddi: seletor('#whatsapp-usuario-ddi').value.trim() || '55', ddd, numero };

  // Auditoria M3: trocar ou tirar o número retira a autorização no servidor — a tela avisa.
  const estavaAutorizado = seletor('#whatsapp-usuario-autorizado').checked;
  try {
    await pedirJson(`/api/usuarios/${alvo}`, { metodo: 'PUT', corpo: { whatsapp } });
    await depoisDeMudarWhatsapp(alvo);
    if (estavaAutorizado && whatsappEmEdicao === alvo && !seletor('#whatsapp-usuario-autorizado').checked) {
      definirTexto('#whatsapp-usuario-registro', 'Número alterado: a autorização foi retirada. Autorize de novo.');
    }
  } catch (falha) {
    erro.textContent = falha.detalhe || 'WhatsApp inválido: informe DDD (2 dígitos) e número (8 ou 9 dígitos).';
    erro.hidden = false;
  }
});

seletor('#whatsapp-usuario-autorizado')?.addEventListener('change', async (evento) => {
  const alvo = whatsappEmEdicao;
  const caixa = evento.target;
  if (!alvo) return;
  if (caixa.checked && !window.confirm('Confirma que a pessoa autorizou o uso deste WhatsApp para avisos e resumos? Fica registrado quem autorizou e quando.')) {
    caixa.checked = false;
    return;
  }
  try {
    await pedirJson(`/api/usuarios/${alvo}/whatsapp-particular`, { metodo: 'POST', corpo: { autorizado: caixa.checked } });
    await depoisDeMudarWhatsapp(alvo);
  } catch (falha) {
    caixa.checked = !caixa.checked;
    definirTexto('#whatsapp-usuario-registro', falha.detalhe || 'A autorização não pôde ser gravada.');
  }
});

seletor('#whatsapp-usuario-fechar')?.addEventListener('click', () => {
  whatsappEmEdicao = null;
  seletor('#cartao-whatsapp-usuario').hidden = true;
});

// Resumo por equipe (docs/RESUMOS.md): quem recebe o resumo de cada equipe. O
// número chega mascarado do servidor; nomes de pessoa e de agente só por textContent.
const MOTIVOS_SEM_RESUMO = {
  pausado: 'resumos pausados',
  sem_whatsapp: 'sem WhatsApp no cadastro',
  whatsapp_nao_autorizado: 'WhatsApp sem autorização de uso',
};

async function carregarPainelDeResumos() {
  const cartao = seletor('#cartao-resumos');
  const painel = seletor('#painel-resumos');
  if (!cartao || !painel || !usuarioAtual?.master) return;
  cartao.hidden = false;

  try {
    const dados = await pedirJson('/api/usuarios/resumos');
    painel.replaceChildren();
    let semNinguem = 0;

    for (const grupo of dados.grupos ?? []) {
      const bloco = document.createElement('div');
      bloco.className = 'grupo-resumo';
      const titulo = document.createElement('b');
      titulo.textContent = grupo.nome ?? 'Equipe';
      const detalhe = document.createElement('small');
      detalhe.textContent = grupo.sem_canal
        ? ' · agente sem WhatsApp ativo: o resumo não sai'
        : ` · sai pelo número ${grupo.sai_pelo_numero ?? ''}`;
      const lista = document.createElement('ul');
      if ((grupo.destinatarios ?? []).length === 0) {
        semNinguem += 1;
        const vazio = document.createElement('li');
        vazio.className = 'vazio';
        vazio.textContent = 'Ninguém recebe este resumo.';
        lista.append(vazio);
      }
      for (const destino of grupo.destinatarios ?? []) {
        const item = document.createElement('li');
        item.textContent = `${destino.nome} — ${destino.whatsapp ?? ''}`;
        lista.append(item);
      }
      bloco.append(titulo, detalhe, lista);
      painel.append(bloco);
    }

    if ((dados.sem_entrega ?? []).length > 0) {
      const fora = document.createElement('div');
      fora.className = 'grupo-resumo';
      const titulo = document.createElement('b');
      titulo.textContent = 'Deveriam receber e não recebem';
      const lista = document.createElement('ul');
      for (const pessoa of dados.sem_entrega) {
        const item = document.createElement('li');
        item.textContent = `${pessoa.nome} — ${MOTIVOS_SEM_RESUMO[pessoa.motivo] ?? pessoa.motivo}`;
        lista.append(item);
      }
      fora.append(titulo, lista);
      painel.append(fora);
    }

    definirTexto('#resumo-destinatarios', semNinguem > 0
      ? `${semNinguem} equipe(s) sem ninguém para receber o resumo`
      : `Um resumo por equipe a cada ${Number(dados.intervalo_min) || 120} minutos`);
  } catch (erro) {
    painel.replaceChildren();
    definirTexto('#resumo-destinatarios', erro.status === 403 ? 'Apenas o administrador vê.' : 'Não foi possível carregar.');
  }
}

async function agirNoUsuario(id, caminho, corpo) {
  try {
    await pedirJson(`/api/usuarios/${id}/${caminho}`, { metodo: 'POST', corpo });
    await carregarUsuarios();
  } catch (erro) {
    definirTexto('#resumo-usuarios', erro.detalhe || 'A ação não pôde ser concluída.');
  }
}

seletor('#abrir-novo-usuario')?.addEventListener('click', () => {
  const cartao = seletor('#cartao-novo-usuario');
  cartao.hidden = !cartao.hidden;
  if (!cartao.hidden) seletor('#novo-nome').focus();
});

seletor('#cancelar-novo-usuario')?.addEventListener('click', () => {
  seletor('#cartao-novo-usuario').hidden = true;
});

seletor('#form-novo-usuario')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const corpo = {
    nome: seletor('#novo-nome').value.trim(),
    email: seletor('#novo-email').value.trim(),
    senha: seletor('#novo-senha').value,
    papel: seletor('#novo-papel').value,
  };

  try {
    const { usuario: criado } = await pedirJson('/api/usuarios', { metodo: 'POST', corpo });
    // "Vê a clínica" desmarcado no cadastro: colaborador desde o primeiro acesso.
    const veAClinica = seletor('#novo-acesso-clinica');
    if (veAClinica && !veAClinica.checked && criado?.id && corpo.papel !== 'admin') {
      await pedirJson(`/api/usuarios/${Number(criado.id)}/acesso-clinica`, { metodo: 'POST', corpo: { acesso_clinica: false } });
    }
    evento.target.reset();
    seletor('#cartao-novo-usuario').hidden = true;
    await carregarUsuarios();
  } catch (erro) {
    definirTexto('#resumo-usuarios', erro.detalhe || 'Não foi possível criar a conta.');
  }
});

// ---------------------------------------------------------------------------
// Perfil — dados, senha e segundo fator.
// ---------------------------------------------------------------------------

function desenharPerfil() {
  if (!usuarioAtual) return;

  const nome = seletor('#perfil-nome');
  const telefone = seletor('#perfil-telefone');
  if (nome) nome.value = usuarioAtual.nome || '';
  if (telefone) telefone.value = usuarioAtual.telefone || '';

  definirTexto('#perfil-email', usuarioAtual.email || '—');
  definirTexto('#perfil-papel', ROTULOS_DE_PAPEL[usuarioAtual.papel] || usuarioAtual.papel);
  definirTexto('#perfil-google', usuarioAtual.google_vinculado ? 'Vinculada' : 'Não vinculada');

  const ativo = Boolean(usuarioAtual.totp_ativo);
  definirTexto(
    '#estado-2fa',
    ativo
      ? 'Ativo. O login pede um código do seu aplicativo autenticador.'
      : 'Desativado. Ative para exigir um código além da senha.',
  );
  seletor('#ativar-2fa').hidden = ativo;
  seletor('#desativar-2fa').hidden = !ativo;
  seletor('#bloco-ativar-2fa').hidden = true;

  const aviso = seletor('#aviso-trocar-senha');
  if (aviso) aviso.hidden = !usuarioAtual.precisa_trocar_senha;
}

function retornar(alvo, mensagem, erro = false) {
  const elemento = seletor(alvo);
  if (!elemento) return;
  elemento.hidden = false;
  elemento.textContent = mensagem;
  elemento.classList.toggle('retorno-erro', erro);
}

/** Relê a sessão do servidor: papel, 2FA e situação podem ter mudado. */
async function recarregarSessao() {
  try {
    const { usuario } = await pedirJson('/api/auth/sessao');
    usuarioAtual = usuario;
    desenharPerfil();
  } catch {
    // Sessão inválida: o interceptador de 401 já cuida do portão.
  }
}

seletor('#form-perfil')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  try {
    const { usuario } = await pedirJson('/api/perfil', {
      metodo: 'PUT',
      corpo: {
        nome: seletor('#perfil-nome').value.trim(),
        telefone: seletor('#perfil-telefone').value.trim() || null,
      },
    });
    usuarioAtual = usuario;
    definirTexto('#nome-usuario', usuario.nome);
    definirTexto('#avatar-usuario', iniciais(usuario.nome));
    retornar('#retorno-senha', 'Perfil atualizado.');
  } catch (erro) {
    retornar('#retorno-senha', erro.detalhe || 'Não foi possível salvar o perfil.', true);
  }
});

seletor('#form-trocar-senha')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  try {
    await pedirJson('/api/auth/senha', {
      metodo: 'POST',
      corpo: {
        senha_atual: seletor('#senha-atual').value,
        senha_nova: seletor('#senha-nova').value,
      },
    });

    evento.target.reset();
    retornar('#retorno-senha', 'Senha alterada. Entre novamente com a senha nova.');

    // Trocar a senha derruba as sessões, inclusive esta: voltar ao portão é o
    // comportamento honesto, em vez de deixar a tela quebrar na próxima ação.
    setTimeout(() => encerrarSessaoNaTela('Senha alterada. Entre com a senha nova.'), 1500);
  } catch (erro) {
    retornar('#retorno-senha', erro.status === 401
      ? 'Senha atual incorreta.'
      : erro.detalhe || 'Não foi possível trocar a senha.', true);
  }
});

seletor('#ativar-2fa')?.addEventListener('click', async () => {
  try {
    const { segredo } = await pedirJson('/api/auth/segundo-fator', { metodo: 'POST', corpo: {} });
    definirTexto('#segredo-2fa', segredo);
    seletor('#bloco-ativar-2fa').hidden = false;
    seletor('#codigo-2fa').focus();
  } catch (erro) {
    retornar('#retorno-2fa', erro.detalhe || 'Não foi possível preparar o segundo fator.', true);
  }
});

seletor('#form-confirmar-2fa')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  try {
    await pedirJson('/api/auth/segundo-fator/confirmar', {
      metodo: 'POST',
      corpo: { codigo: seletor('#codigo-2fa').value.trim() },
    });
    evento.target.reset();
    retornar('#retorno-2fa', 'Segundo fator ativado.');
    await recarregarSessao();
  } catch (erro) {
    retornar('#retorno-2fa', erro.detalhe || 'Código incorreto.', true);
  }
});

seletor('#desativar-2fa')?.addEventListener('click', async () => {
  const senha = seletor('#senha-atual')?.value;
  if (!senha) {
    retornar('#retorno-2fa', 'Digite sua senha no campo "Senha atual" para desativar.', true);
    return;
  }

  try {
    await pedirJson('/api/auth/segundo-fator/desativar', { metodo: 'POST', corpo: { senha } });
    retornar('#retorno-2fa', 'Segundo fator desativado.');
    await recarregarSessao();
  } catch (erro) {
    retornar('#retorno-2fa', erro.status === 401 ? 'Senha incorreta.' : 'Não foi possível desativar.', true);
  }
});

// --- Início ---

atualizarRelogio();
setInterval(atualizarRelogio, 30000);

(async () => {
  await carregarOpcoesDeEntrada();

  // Link de recuperação vindo do e-mail: abre direto o painel de senha nova.
  const parametros = new URLSearchParams(window.location.search);
  const token = parametros.get('recuperar');
  if (token) {
    tokenDeRecuperacao = token;
    // Tira o token da barra de endereços: ele não precisa ficar no histórico.
    window.history.replaceState({}, '', window.location.pathname);

    mostrarPortao();
    mostrarPainelDoPortao('redefinir');
    seletor('#redefinir-senha')?.focus();
    return;
  }

  // Login com Google: o backend redireciona de volta com tokens na URL.
  const accessTokenGoogle = parametros.get('access_token');
  const refreshTokenGoogle = parametros.get('refresh_token');
  if (accessTokenGoogle && refreshTokenGoogle) {
    accessToken = accessTokenGoogle;
    try {
      guardarRefresh(refreshTokenGoogle);
    } catch {}
    window.history.replaceState({}, '', window.location.pathname);
    mostrarAplicacao();
    return;
  }

  // Um F5 no meio do plantão não deve pedir senha de novo.
  if (lerRefresh() && await renovarSessao()) mostrarAplicacao();
  else mostrarPortao(lerEApagarAvisoDoPortao());
})();

// ---------------------------------------------------------------------------
// Agenda
//
// Grade semanal desenhada aqui mesmo, sem biblioteca de calendário. A tela lê
// e escreve pela API do próprio domínio; o conflito de horário quem impede é o
// banco, então esta camada trata 409 como resposta esperada, não como falha.
//
// Marcar tem dois passos de propósito: "Revisar" pede uma proposta (nada é
// gravado) e só "Confirmar e gravar" escreve. Oferecer e marcar na mesma ação é
// como a clínica acaba com consulta que o paciente não pediu.
// ---------------------------------------------------------------------------

const HORA_INICIAL = 7;   // a grade cobre 07h–20h: fora disso a clínica não atende
const HORA_FINAL = 20;

/**
 * Altura de uma hora, em px.
 *
 * Lida do CSS (`--altura-hora`) de propósito. Quando este número existia nos
 * dois lugares, a régua de horas à esquerda e os blocos de compromisso usavam
 * escalas diferentes: uma consulta das 10h aparecia na linha das 13h.
 */
function alturaDaHora() {
  const declarado = getComputedStyle(document.documentElement).getPropertyValue('--altura-hora');
  return Number.parseFloat(declarado) || 56;
}

const agendaEstado = {
  profissionais: [],
  profissionalId: null,
  inicioDaSemana: null,
  tipos: ['consulta'],
  proposta: null,        // token + resumo devolvidos por /api/agenda/propor
  contatoEscolhido: null,
  compromissoAberto: null,
  origemConversa: null,  // preenchido ao abrir a agenda de dentro de uma conversa
  paraMarcar: null,      // paciente trazido da conversa, aguardando escolha de horário
};

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function segundaDaSemana(data) {
  const inicio = new Date(data);
  inicio.setHours(0, 0, 0, 0);
  // getDay(): 0 = domingo. Recuar até segunda, tratando domingo como fim da semana.
  const recuo = (inicio.getDay() + 6) % 7;
  inicio.setDate(inicio.getDate() - recuo);
  return inicio;
}

function mesmoDia(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

const horaCurta = (data) => new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit', minute: '2-digit',
}).format(data);

const dataPorExtenso = (data) => new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit',
}).format(data);

/** Só o dia, para quando o horário aparece separado ao lado. */
const diaPorExtenso = (data) => new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long', day: '2-digit', month: 'long',
}).format(data);

/** Posição vertical em px de um instante dentro da faixa do dia. */
function alturaDe(data) {
  const minutos = (data.getHours() - HORA_INICIAL) * 60 + data.getMinutes();
  return (minutos / 60) * alturaDaHora();
}

async function carregarAgenda() {
  if (!agendaEstado.inicioDaSemana) agendaEstado.inicioDaSemana = segundaDaSemana(new Date());

  if (!agendaEstado.profissionais.length) {
    try {
      const [dadosProfissionais, vocabulario] = await Promise.all([
        pedirJson('/api/agenda/profissionais'),
        pedirJson('/api/agenda/vocabulario'),
      ]);
      agendaEstado.profissionais = dadosProfissionais.profissionais;
      agendaEstado.tipos = vocabulario.tipos;
      desenharSeletorDeProfissionais();
      preencherTiposDaProposta();
    } catch (erro) {
      seletor('#agenda-periodo').textContent = erro.status === 403
        ? 'Seu perfil não tem acesso à agenda.'
        : 'Não foi possível carregar a agenda.';
      return;
    }
  }

  await desenharSemana();
}

function desenharSeletorDeProfissionais() {
  const campo = seletor('#agenda-profissional');
  campo.textContent = '';

  if (!agendaEstado.profissionais.length) {
    campo.append(new Option('Nenhum profissional cadastrado', ''));
    return;
  }

  for (const profissional of agendaEstado.profissionais) {
    const rotulo = profissional.especialidade
      ? `${profissional.nome} · ${profissional.especialidade}`
      : profissional.nome;
    campo.append(new Option(rotulo + (profissional.ativo ? '' : ' (inativo)'), String(profissional.id)));
  }

  agendaEstado.profissionalId = agendaEstado.profissionalId ?? agendaEstado.profissionais[0].id;
  campo.value = String(agendaEstado.profissionalId);
}

async function desenharSemana() {
  const inicio = agendaEstado.inicioDaSemana;
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + 7);

  const periodo = seletor('#agenda-periodo');
  const ultimoDia = new Date(fim);
  ultimoDia.setDate(ultimoDia.getDate() - 1);
  periodo.textContent = `${inicio.toLocaleDateString('pt-BR')} a ${ultimoDia.toLocaleDateString('pt-BR')}`;

  // Quem chegou aqui pela conversa precisa saber por que a tela mudou.
  if (agendaEstado.paraMarcar) {
    const nome = agendaEstado.paraMarcar.contato?.nome || 'o paciente';
    periodo.textContent += ` · escolha o horário para ${nome}`;
  }

  desenharColunaDeHoras();

  if (!agendaEstado.profissionalId) {
    seletor('#agenda-dias').textContent = '';
    periodo.textContent += ' · cadastre um profissional para usar a agenda';
    return;
  }

  let dados = { agendamentos: [], bloqueios: [] };
  try {
    const parametros = new URLSearchParams({
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      profissional: String(agendaEstado.profissionalId),
    });
    dados = await pedirJson(`/api/agenda?${parametros}`);
  } catch {
    periodo.textContent += ' · não foi possível carregar os compromissos';
  }

  const colunas = seletor('#agenda-dias');
  colunas.textContent = '';
  const hoje = new Date();

  for (let indice = 0; indice < 7; indice += 1) {
    const dia = new Date(inicio);
    dia.setDate(dia.getDate() + indice);
    colunas.append(desenharDia(dia, dados, mesmoDia(dia, hoje)));
  }
}

function desenharColunaDeHoras() {
  const coluna = seletor('#agenda-horas');
  coluna.textContent = '';
  for (let hora = HORA_INICIAL; hora < HORA_FINAL; hora += 1) {
    const marca = document.createElement('span');
    marca.textContent = `${String(hora).padStart(2, '0')}:00`;
    coluna.append(marca);
  }
}

function desenharDia(dia, dados, ehHoje) {
  const coluna = document.createElement('div');
  coluna.className = `dia-agenda${ehHoje ? ' hoje' : ''}`;

  const titulo = document.createElement('div');
  titulo.className = 'titulo-dia';
  titulo.textContent = `${DIAS_CURTOS[dia.getDay()]} ${dia.getDate()}`;
  coluna.append(titulo);

  const altura = alturaDaHora();
  const faixa = document.createElement('div');
  faixa.className = 'faixa-dia';
  faixa.style.height = `${(HORA_FINAL - HORA_INICIAL) * altura}px`;

  // Linhas de hora e meia hora, e uma vaga clicável a cada 30 minutos.
  for (let meia = 0; meia < (HORA_FINAL - HORA_INICIAL) * 2; meia += 1) {
    const topo = (meia / 2) * altura;

    const linha = document.createElement('div');
    linha.className = `linha-hora${meia % 2 ? ' meia' : ''}`;
    linha.style.top = `${topo}px`;
    faixa.append(linha);

    const inicioDaVaga = new Date(dia);
    inicioDaVaga.setHours(HORA_INICIAL + Math.floor(meia / 2), (meia % 2) * 30, 0, 0);

    const vaga = document.createElement('button');
    vaga.type = 'button';
    vaga.className = 'vaga';
    vaga.style.top = `${topo}px`;
    vaga.style.height = `${altura / 2}px`;
    vaga.setAttribute('aria-label', `Marcar em ${dataPorExtenso(inicioDaVaga)}`);
    // `paraMarcar` vem de "Marcar horário" dentro de uma conversa: traz o
    // paciente e o vínculo. Ele sobrevive a cancelar o painel — quem clicou na
    // vaga errada volta, clica na certa e continua marcando para a mesma pessoa.
    // Só sai do estado quando algo é de fato gravado.
    vaga.addEventListener('click', () => abrirProposta(inicioDaVaga, agendaEstado.paraMarcar ?? {}));
    faixa.append(vaga);
  }

  for (const bloqueio of dados.bloqueios ?? []) {
    const desenho = desenharBloqueio(bloqueio, dia);
    if (desenho) faixa.append(desenho);
  }
  for (const agendamento of dados.agendamentos ?? []) {
    const desenho = desenharCompromisso(agendamento, dia);
    if (desenho) faixa.append(desenho);
  }

  coluna.append(faixa);
  return coluna;
}

/** Recorta um período ao dia da coluna; devolve null se não o toca. */
function recortarAoDia(inicioBruto, fimBruto, dia) {
  const inicioDoDia = new Date(dia);
  inicioDoDia.setHours(HORA_INICIAL, 0, 0, 0);
  const fimDoDia = new Date(dia);
  fimDoDia.setHours(HORA_FINAL, 0, 0, 0);

  const inicio = new Date(inicioBruto);
  const fim = new Date(fimBruto);
  if (fim <= inicioDoDia || inicio >= fimDoDia) return null;

  return {
    inicio: inicio < inicioDoDia ? inicioDoDia : inicio,
    fim: fim > fimDoDia ? fimDoDia : fim,
    inicioReal: inicio,
    fimReal: fim,
  };
}

function desenharCompromisso(agendamento, dia) {
  const recorte = recortarAoDia(agendamento.inicio, agendamento.fim, dia);
  if (!recorte) return null;

  // Piso de 20px: uma consulta de 15 minutos ainda precisa ser clicável.
  const altura = Math.max(20, alturaDe(recorte.fim) - alturaDe(recorte.inicio) - 2);

  const bloco = document.createElement('button');
  bloco.type = 'button';
  // Abaixo de 34px não cabem duas linhas de texto; o layout muda para uma só.
  bloco.className = `compromisso ${agendamento.status}${altura < 34 ? ' curto' : ''}`;
  bloco.style.top = `${alturaDe(recorte.inicio)}px`;
  bloco.style.height = `${altura}px`;

  const nome = document.createElement('strong');
  nome.textContent = agendamento.contato_nome ?? 'Paciente';
  const quando = document.createElement('span');
  quando.textContent = altura < 34
    ? horaCurta(recorte.inicioReal)
    : `${horaCurta(recorte.inicioReal)} · ${agendamento.tipo}`;
  bloco.append(nome, quando);

  bloco.addEventListener('click', () => abrirCompromisso(agendamento));
  return bloco;
}

function desenharBloqueio(bloqueio, dia) {
  const recorte = recortarAoDia(bloqueio.inicio, bloqueio.fim, dia);
  if (!recorte) return null;

  const bloco = document.createElement('div');
  bloco.className = 'bloqueio-agenda';
  bloco.style.top = `${alturaDe(recorte.inicio)}px`;
  bloco.style.height = `${Math.max(12, alturaDe(recorte.fim) - alturaDe(recorte.inicio))}px`;
  bloco.textContent = bloqueio.motivo ?? 'Bloqueado';
  return bloco;
}

// --- Proposta -------------------------------------------------------------

function preencherTiposDaProposta() {
  const campo = seletor('#proposta-tipo');
  campo.textContent = '';

  // "bloqueio" existe no vocabulário do domínio, mas aqui se marca consulta para
  // um paciente: oferecê-lo nesta lista só serviria para alguém marcar a Marina
  // como bloqueio de agenda. Bloqueio se cria pela rota própria, sem contato.
  for (const tipo of agendaEstado.tipos.filter((item) => item !== 'bloqueio')) {
    campo.append(new Option(tipo, tipo));
  }
}

function abrirProposta(inicio, { contato = null, conversaId = null, leadId = null } = {}) {
  const profissional = agendaEstado.profissionais.find((p) => p.id === Number(agendaEstado.profissionalId));
  const duracao = profissional?.duracao_min ?? 30;

  const fim = new Date(inicio);
  fim.setMinutes(fim.getMinutes() + duracao);

  agendaEstado.proposta = null;
  agendaEstado.contatoEscolhido = contato;
  agendaEstado.origemConversa = conversaId ? { conversaId, leadId } : null;
  agendaEstado.horarioProposto = { inicio, fim };

  seletor('#proposta-horario').textContent =
    `${diaPorExtenso(inicio)} · ${horaCurta(inicio)} às ${horaCurta(fim)}`
    + ` · ${profissional?.nome ?? 'profissional'}`;
  seletor('#proposta-busca').value = contato ? (contato.nome ?? contato.telefone ?? '') : '';
  seletor('#proposta-observacoes').value = '';
  seletor('#proposta-sugestoes').hidden = true;
  seletor('#proposta-confirmacao').hidden = true;
  seletor('#proposta-botoes').hidden = false;
  esconderErroDaProposta();
  mostrarContatoEscolhido();

  seletor('#cortina-agenda').hidden = false;
  seletor(contato ? '#proposta-tipo' : '#proposta-busca').focus();
}

function fecharProposta() {
  seletor('#cortina-agenda').hidden = true;
  agendaEstado.proposta = null;
  agendaEstado.contatoEscolhido = null;
}

function mostrarContatoEscolhido() {
  const alvo = seletor('#proposta-escolhido');
  const contato = agendaEstado.contatoEscolhido;
  if (!contato) {
    alvo.hidden = true;
    return;
  }
  alvo.hidden = false;
  alvo.textContent = `${contato.nome ?? 'Sem nome'} · ${contato.telefone ?? 'sem telefone'}`;
}

function mostrarErroDaProposta(mensagem) {
  const alvo = seletor('#proposta-erro');
  alvo.textContent = mensagem;
  alvo.hidden = false;
}

function esconderErroDaProposta() {
  seletor('#proposta-erro').hidden = true;
}

let buscaEmEspera = null;

async function buscarContatosDaProposta(termo) {
  const lista = seletor('#proposta-sugestoes');
  if (termo.trim().length < 2) {
    lista.hidden = true;
    return;
  }

  try {
    const { contatos } = await pedirJson(`/api/contatos?busca=${encodeURIComponent(termo)}`);
    lista.textContent = '';

    if (!contatos.length) {
      lista.hidden = true;
      return;
    }

    for (const contato of contatos) {
      const item = document.createElement('li');
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.textContent = contato.nome ?? 'Sem nome';
      const telefone = document.createElement('small');
      telefone.textContent = contato.telefone ?? 'sem telefone';
      botao.append(telefone);
      botao.addEventListener('click', () => {
        agendaEstado.contatoEscolhido = contato;
        seletor('#proposta-busca').value = contato.nome ?? contato.telefone ?? '';
        lista.hidden = true;
        mostrarContatoEscolhido();
      });
      item.append(botao);
      lista.append(item);
    }
    lista.hidden = false;
  } catch {
    lista.hidden = true;
  }
}

/** Passo 1: pede a proposta. Nada é gravado — só o servidor valida e reserva o texto. */
async function pedirProposta(evento) {
  evento.preventDefault();
  esconderErroDaProposta();

  if (!agendaEstado.contatoEscolhido) {
    mostrarErroDaProposta('Escolha o paciente na lista antes de continuar.');
    return;
  }

  const { inicio, fim } = agendaEstado.horarioProposto;
  const corpo = {
    profissional_id: Number(agendaEstado.profissionalId),
    contato_id: agendaEstado.contatoEscolhido.id,
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
    tipo: seletor('#proposta-tipo').value,
  };
  if (agendaEstado.origemConversa) {
    corpo.conversa_id = agendaEstado.origemConversa.conversaId;
    corpo.lead_id = agendaEstado.origemConversa.leadId ?? null;
  }

  try {
    agendaEstado.proposta = await pedirJson('/api/agenda/propor', { metodo: 'POST', corpo });

    seletor('#proposta-frase').textContent = agendaEstado.proposta.confirmar;
    seletor('#proposta-confirmacao').hidden = false;
    seletor('#proposta-botoes').hidden = true;
    seletor('#proposta-confirmar').focus();
  } catch (erro) {
    mostrarErroDaProposta(explicarErroDeAgenda(erro));
  }
}

/** Passo 2: grava. Só o que foi proposto, e só depois de alguém ler a frase. */
async function confirmarProposta() {
  const botao = seletor('#proposta-confirmar');
  botao.disabled = true;

  try {
    await pedirJson('/api/agenda/confirmar', {
      metodo: 'POST',
      corpo: {
        token: agendaEstado.proposta.token,
        observacoes: seletor('#proposta-observacoes').value.trim() || null,
      },
    });

    const conversaDeOrigem = agendaEstado.origemConversa?.conversaId ?? null;

    // Gravou: o contexto trazido da conversa cumpriu seu papel.
    agendaEstado.paraMarcar = null;
    fecharProposta();

    await desenharSemana();
    if (conversaDeOrigem) await carregarAgendaDaConversa(conversaDeOrigem);
  } catch (erro) {
    seletor('#proposta-confirmacao').hidden = true;
    seletor('#proposta-botoes').hidden = false;
    mostrarErroDaProposta(explicarErroDeAgenda(erro));
  } finally {
    botao.disabled = false;
  }
}

/**
 * Traduz o erro da API.
 *
 * 409 é resposta esperada, não falha: significa que alguém marcou o mesmo
 * horário no intervalo entre a tela carregar e a confirmação chegar.
 */
function explicarErroDeAgenda(erro) {
  if (erro.status === 409) return 'Esse horário acabou de ser ocupado. Escolha outro.';
  if (erro.status === 403) return 'Seu perfil não pode marcar compromissos.';
  if (erro.detalhe) return erro.detalhe;
  return 'Não foi possível concluir. Tente de novo.';
}

// --- Compromisso já gravado -----------------------------------------------

function abrirCompromisso(agendamento) {
  agendaEstado.compromissoAberto = agendamento;

  const inicio = new Date(agendamento.inicio);
  const fim = new Date(agendamento.fim);
  const detalhe = seletor('#detalhe-compromisso');
  detalhe.textContent = '';

  const linhas = [
    ['Paciente', agendamento.contato_nome ?? '—'],
    ['Quando', `${dataPorExtenso(inicio)} às ${horaCurta(fim)}`],
    ['Tipo', agendamento.tipo],
    ['Situação', agendamento.status],
  ];
  if (agendamento.observacoes) linhas.push(['Observações', agendamento.observacoes]);
  if (agendamento.cancelado_motivo) linhas.push(['Motivo do cancelamento', agendamento.cancelado_motivo]);

  for (const [rotulo, valor] of linhas) {
    const chave = document.createElement('dt');
    chave.textContent = rotulo;
    const dado = document.createElement('dd');
    dado.textContent = valor;
    detalhe.append(chave, dado);
  }

  seletor('#compromisso-erro').hidden = true;
  desenharAcoesDoCompromisso(agendamento);
  seletor('#cortina-compromisso').hidden = false;
  seletor('#fechar-compromisso').focus();
}

function desenharAcoesDoCompromisso(agendamento) {
  const area = seletor('#acoes-compromisso');
  area.textContent = '';

  if (agendamento.status === 'cancelado') {
    const aviso = document.createElement('p');
    aviso.className = 'vazio';
    aviso.textContent = 'Compromisso cancelado. O horário está livre de novo.';
    area.append(aviso);
    return;
  }

  const acoes = [];
  if (agendamento.status === 'agendado') acoes.push(['Marcar confirmado', () => mudarStatus('confirmado')]);
  if (['agendado', 'confirmado'].includes(agendamento.status)) {
    acoes.push(['Compareceu', () => mudarStatus('compareceu')]);
    acoes.push(['Faltou', () => mudarStatus('faltou')]);
  }
  acoes.push(['Ver conversa', abrirConversaDoCompromisso]);

  for (const [rotulo, acao] of acoes) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = rotulo;
    botao.addEventListener('click', acao);
    area.append(botao);
  }

  // Cancelar fica por último e destacado: é a ação que a pessoa não deve
  // acertar por engano ao mirar em outra.
  const cancelar = document.createElement('button');
  cancelar.type = 'button';
  cancelar.className = 'perigo';
  cancelar.textContent = 'Cancelar compromisso';
  cancelar.addEventListener('click', cancelarCompromisso);
  area.append(cancelar);
}

async function mudarStatus(status) {
  const { id } = agendaEstado.compromissoAberto;
  try {
    await pedirJson(`/api/agenda/${id}/status`, { metodo: 'POST', corpo: { status } });
    seletor('#cortina-compromisso').hidden = true;
    await desenharSemana();
  } catch (erro) {
    const alvo = seletor('#compromisso-erro');
    alvo.textContent = explicarErroDeAgenda(erro);
    alvo.hidden = false;
  }
}

async function cancelarCompromisso() {
  const { id } = agendaEstado.compromissoAberto;
  const motivo = seletor('#proposta-observacoes')?.value || null;

  try {
    await pedirJson(`/api/agenda/${id}/cancelar`, { metodo: 'POST', corpo: { motivo } });
    seletor('#cortina-compromisso').hidden = true;
    await desenharSemana();
  } catch (erro) {
    const alvo = seletor('#compromisso-erro');
    alvo.textContent = explicarErroDeAgenda(erro);
    alvo.hidden = false;
  }
}

function abrirConversaDoCompromisso() {
  const { conversa_id: conversaId } = agendaEstado.compromissoAberto;
  seletor('#cortina-compromisso').hidden = true;

  if (!conversaId) return;
  abrirTela('conversas');
  abrirConversa(conversaId);
}

// --- Agenda vista de dentro da conversa -----------------------------------

async function carregarAgendaDaConversa(conversaId) {
  const area = seletor('#agenda-da-conversa');
  if (!area) return;

  try {
    const dados = await pedirJson(`/api/conversas/${conversaId}/agenda`);
    area.textContent = '';

    const titulo = document.createElement('h4');
    titulo.textContent = 'Agenda deste paciente';
    area.append(titulo);

    const futuros = dados.agendamentos
      .filter((item) => item.status !== 'cancelado' && new Date(item.fim) >= new Date())
      .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));

    if (!futuros.length) {
      const vazio = document.createElement('p');
      vazio.className = 'vazio';
      vazio.textContent = 'Nenhum compromisso futuro.';
      area.append(vazio);
    } else {
      const lista = document.createElement('ul');
      for (const item of futuros) {
        const linha = document.createElement('li');
        const quando = document.createElement('span');
        quando.className = 'quando';
        quando.textContent = dataPorExtenso(new Date(item.inicio));
        linha.append(quando, document.createTextNode(` · ${item.tipo} · ${item.status}`));
        lista.append(linha);
      }
      area.append(lista);
    }

    const marcar = document.createElement('button');
    marcar.type = 'button';
    marcar.className = 'secundario';
    marcar.textContent = 'Marcar horário';
    marcar.addEventListener('click', () => {
      // Abre a agenda com o paciente já escolhido, em vez de propor um horário
      // arbitrário: "agora + 30 minutos" quase sempre cai fora do atendimento, e
      // a pessoa levaria uma recusa antes de conseguir escolher.
      agendaEstado.paraMarcar = {
        contato: dados.contato ?? { id: dados.contato_id, nome: null, telefone: null },
        conversaId,
        leadId: dados.lead_id,
      };
      abrirTela('agenda');
    });
    area.append(marcar);
    area.hidden = false;
  } catch {
    area.hidden = true;
  }
}

// --- Ligações da tela ------------------------------------------------------

seletor('#agenda-profissional').addEventListener('change', (evento) => {
  agendaEstado.profissionalId = Number(evento.target.value) || null;
  desenharSemana();
});

seletor('#semana-anterior').addEventListener('click', () => {
  agendaEstado.inicioDaSemana.setDate(agendaEstado.inicioDaSemana.getDate() - 7);
  desenharSemana();
});

seletor('#semana-proxima').addEventListener('click', () => {
  agendaEstado.inicioDaSemana.setDate(agendaEstado.inicioDaSemana.getDate() + 7);
  desenharSemana();
});

seletor('#semana-hoje').addEventListener('click', () => {
  agendaEstado.inicioDaSemana = segundaDaSemana(new Date());
  desenharSemana();
});

seletor('#forma-proposta').addEventListener('submit', pedirProposta);
seletor('#proposta-confirmar').addEventListener('click', confirmarProposta);
seletor('#proposta-cancelar').addEventListener('click', fecharProposta);
seletor('#fechar-proposta').addEventListener('click', fecharProposta);
seletor('#fechar-compromisso').addEventListener('click', () => {
  seletor('#cortina-compromisso').hidden = true;
});

seletor('#proposta-voltar').addEventListener('click', () => {
  // Voltar descarta a proposta: o token vale para aquele horário, e mexer nos
  // campos depois de propor deixaria a frase confirmada divergindo do que grava.
  agendaEstado.proposta = null;
  seletor('#proposta-confirmacao').hidden = true;
  seletor('#proposta-botoes').hidden = false;
});

seletor('#proposta-busca').addEventListener('input', (evento) => {
  agendaEstado.contatoEscolhido = null;
  mostrarContatoEscolhido();
  clearTimeout(buscaEmEspera);
  const termo = evento.target.value;
  buscaEmEspera = setTimeout(() => buscarContatosDaProposta(termo), 250);
});

// Esc fecha o painel aberto: quem atende usa teclado com o telefone na mão.
document.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Escape') return;
  if (!seletor('#cortina-agenda').hidden) fecharProposta();
  if (!seletor('#cortina-compromisso').hidden) seletor('#cortina-compromisso').hidden = true;
});

// Clicar fora do painel fecha, como em qualquer modal.
for (const id of ['#cortina-agenda', '#cortina-compromisso']) {
  seletor(id).addEventListener('click', (evento) => {
    if (evento.target !== evento.currentTarget) return;
    if (id === '#cortina-agenda') fecharProposta();
    else seletor('#cortina-compromisso').hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Serena: estado real, interruptor, prompt versionado e regras.
//
// O estado vem em quatro peças de propósito. "OpenClaw offline" e "Serena
// desligada pela equipe" pedem ações opostas — chamar o suporte contra clicar
// em "ligar" — e a tela antiga mostrava as duas como "não configurado".
// ---------------------------------------------------------------------------

function informar(mensagem) { window.alert(mensagem); }

let serenaPainel = null;
let promptEmEdicao = null;
let regraEmEdicao = null;

function pintarEstado(alvo, texto, tom) {
  const elemento = seletor(alvo);
  if (!elemento) return;
  elemento.textContent = texto;
  elemento.dataset.tom = tom;
}

function desenharEstadoDaSerena(dados) {
  const { openclaw, whatsapp, serena, entrega } = dados;

  const rotuloOpenclaw = { online: 'Online', offline: 'Offline', nao_configurado: 'Não configurado' };
  pintarEstado('#serena-openclaw', rotuloOpenclaw[openclaw.estado] ?? openclaw.estado,
    openclaw.estado === 'online' ? 'ok' : (openclaw.estado === 'offline' ? 'ruim' : 'neutro'));
  const detalheOpenclaw = seletor('#serena-openclaw-detalhe');
  if (detalheOpenclaw) {
    detalheOpenclaw.textContent = openclaw.gateway
      ? `gateway ${new URL(openclaw.gateway).host}`
      : 'sem gateway configurado';
  }

  pintarEstado('#serena-whatsapp', whatsapp.estado === 'conectado' ? 'Conectado' : 'Desconectado',
    whatsapp.estado === 'conectado' ? 'ok' : 'ruim');
  const numero = seletor('#serena-numero');
  if (numero) numero.textContent = whatsapp.numero ? formatarTelefone(whatsapp.numero) : (whatsapp.motivo ?? '—');

  pintarEstado('#serena-interruptor-estado', serena.ativa ? 'Ligada' : 'Desligada',
    serena.ativa ? 'ok' : 'alerta');
  const alterado = seletor('#serena-alterado');
  if (alterado) {
    alterado.textContent = serena.alterado_em
      ? `por ${serena.alterado_por ?? 'sistema'} em ${new Date(serena.alterado_em).toLocaleString('pt-BR')}`
      : 'nunca alterado';
  }

  pintarEstado('#serena-entrega', entrega.modo === 'real' ? 'Real' : 'Dry-run',
    entrega.modo === 'real' ? 'ok' : 'alerta');
  const detalheEntrega = seletor('#serena-entrega-detalhe');
  if (detalheEntrega) detalheEntrega.textContent = entrega.significado ?? '—';

  // Comando 5 / frente 12: desejado (o que a configuração manda agora) ao
  // lado do efetivo (o que o canal do OpenClaw está de fato aplicando). Só
  // existe com política de canal configurada (Arquitetura A) — em
  // Arquitetura B (crm_despacha, o modo efetivo hoje) a barreira que decide
  // é a do CRM, não uma política sincronizada no canal, e o servidor manda
  // `null` em vez de fingir uma comparação que não é aplicável.
  const coerencia = serena.desejado_vs_efetivo;
  if (coerencia) {
    const bate = coerencia.desejado === coerencia.aplicado;
    pintarEstado('#serena-coerencia', bate ? 'Coerente' : 'DIVERGENTE', bate ? 'ok' : 'ruim');
    const detalheCoerencia = seletor('#serena-coerencia-detalhe');
    if (detalheCoerencia) {
      detalheCoerencia.textContent = `desejado: ${coerencia.desejado ? 'atender' : 'calar'} · `
        + `efetivo: ${coerencia.aplicado ? 'atendendo' : 'calado'}`;
    }
  } else {
    pintarEstado('#serena-coerencia', 'Não aplicável', 'neutro');
    const detalheCoerencia = seletor('#serena-coerencia-detalhe');
    if (detalheCoerencia) detalheCoerencia.textContent = 'sem política de canal (Arquitetura B / Evolution)';
  }

  const pilula = seletor('#estado-serena');
  if (pilula) {
    pilula.textContent = serena.ativa ? 'Ligada' : 'Desligada';
    pilula.dataset.tom = serena.ativa ? 'ok' : 'alerta';
  }

  const motivo = seletor('#serena-motivo-atual');
  if (motivo) {
    motivo.hidden = Boolean(serena.ativa) || !serena.motivo;
    motivo.textContent = serena.motivo ? `Motivo do desligamento: ${serena.motivo}` : '';
  }

  desenharCanaisDaSerena(serena.canais_desligados ?? [], serena.ativa);
}

/**
 * As caixas de canal (048). Marcado = responde.
 *
 * Desenhar a partir do servidor a cada carga, e não do que o usuário clicou,
 * é o que impede a tela de afirmar "Instagram ligado" quando a gravação falhou
 * — o mesmo cuidado do botão de parada de emergência.
 */
function desenharCanaisDaSerena(canaisDesligados, ativa = true) {
  const desligados = new Set((canaisDesligados ?? []).map((canal) => String(canal).toLowerCase()));
  for (const [canal, id] of [['whatsapp', '#serena-canal-whatsapp'], ['instagram', '#serena-canal-instagram']]) {
    const caixa = seletor(id);
    if (caixa) caixa.checked = !desligados.has(canal);
  }
  // Com a automação desligada nenhum canal responde: o bloco inteiro fica
  // esmaecido para não afirmar "responde nos dois" enquanto ela está muda.
  const bloco = seletor('#serena-canais');
  if (bloco) bloco.dataset.inerte = String(ativa === false);
  const aviso = seletor('#serena-canais-aviso');
  if (aviso) aviso.hidden = ativa !== false;
}

/** Lê as caixas e manda a lista inteira — o servidor substitui, não soma. */
async function salvarCanaisDaSerena(caixaQueMudou) {
  const canaisDesligados = [];
  for (const [canal, id] of [['whatsapp', '#serena-canal-whatsapp'], ['instagram', '#serena-canal-instagram']]) {
    const caixa = seletor(id);
    if (caixa && !caixa.checked) canaisDesligados.push(canal);
  }

  const caixas = ['#serena-canal-whatsapp', '#serena-canal-instagram'].map((id) => seletor(id)).filter(Boolean);
  for (const caixa of caixas) caixa.disabled = true;
  try {
    const resposta = await pedirJson('/api/serena/canais', {
      metodo: 'PUT', corpo: { canais_desligados: canaisDesligados },
    });
    desenharCanaisDaSerena(resposta.canais_desligados ?? []);
    informar(canaisDesligados.length === 0
      ? 'A Serena responde em todos os canais.'
      : `A Serena parou de responder em: ${canaisDesligados.join(', ')}.`);
  } catch (erro) {
    // A tela não adivinha o que aconteceu: relê do servidor. Desfazer o clique
    // mentiria quando a gravação passou e só a resposta se perdeu.
    carregarSerena().catch(() => {
      if (caixaQueMudou) caixaQueMudou.checked = !caixaQueMudou.checked;
    });
    informar(`Não consegui mudar o canal: ${erro.detalhe || erro.message}`);
  } finally {
    for (const caixa of caixas) caixa.disabled = false;
  }
}

for (const id of ['#serena-canal-whatsapp', '#serena-canal-instagram']) {
  seletor(id)?.addEventListener('change', (evento) => salvarCanaisDaSerena(evento.target));
}

function formatarTelefone(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length < 12) return valor ?? '—';
  const semPais = digitos.slice(2);
  return `+55 ${semPais.slice(0, 2)} ${semPais.slice(2, -4)}-${semPais.slice(-4)}`;
}

function desenharVersoes(versoes, podeGerenciar) {
  const lista = seletor('#serena-versoes');
  if (!lista) return;

  if (versoes.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma versão criada.</li>';
    return;
  }

  lista.innerHTML = versoes.map((versao) => `
    <li class="${versao.publicado ? 'publicada' : ''}">
      <div>
        <strong>v${versao.versao} — ${escapar(versao.titulo)}</strong>
        <small>${versao.publicado ? 'no ar' : 'rascunho'} · ${versao.criado_por ?? 'sistema'} ·
          ${new Date(versao.criado_em).toLocaleDateString('pt-BR')}</small>
      </div>
      <div class="linha-acoes">
        ${podeGerenciar && !versao.publicado ? `
          <button type="button" class="secundario" data-editar-prompt="${versao.id}">Editar</button>
          <button type="button" class="primario" data-publicar-prompt="${versao.id}">Publicar</button>` : ''}
      </div>
    </li>`).join('');
}

function desenharRegras(regras, podeGerenciar) {
  const lista = seletor('#serena-regras');
  if (!lista) return;

  if (regras.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma regra cadastrada.</li>';
    return;
  }

  const rotulos = {
    barreira: 'Barreira', encaminhamento: 'Encaminhamento',
    fluxo: 'Fluxo', estilo: 'Estilo', geral: 'Geral',
  };

  lista.innerHTML = regras.map((regra) => `
    <li class="${regra.ativa ? '' : 'desligada'}">
      <div>
        <strong>${escapar(regra.nome)} <span class="pilula pequena">${rotulos[regra.categoria] ?? regra.categoria}</span></strong>
        <small>${escapar(regra.conteudo)}</small>
      </div>
      <div class="linha-acoes">
        ${podeGerenciar ? `
          <button type="button" class="secundario" data-regra-ativa="${regra.id}" data-valor="${regra.ativa ? 'false' : 'true'}">
            ${regra.ativa ? 'Desligar' : 'Ligar'}
          </button>
          <button type="button" class="secundario" data-editar-regra="${regra.id}">Editar</button>
          <button type="button" class="perigo" data-remover-regra="${regra.id}">Apagar</button>` : ''}
      </div>
    </li>`).join('');
}

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = String(texto ?? '');
  return div.innerHTML;
}


// ---------------------------------------------------------------------------
// Seções da tela da Serena (12/09/2026)
//
// Eram oito cartões abertos ao mesmo tempo; agora é um por vez. A escolha fica
// guardada: quem passa o dia no Centro operacional não quer voltar para o
// WhatsApp a cada carga da página.

const SECAO_SERENA_PADRAO = 'canal-card';
const CHAVE_SECAO_SERENA = 'crmclinica:serena:secao';

// Seções que só existem para quem gerencia a Serena. Antes da navegação por
// botões elas nasciam `hidden` e a tela não tinha como revelá-las; com um botão
// para cada uma, abrir passou a ser um clique — e abrir É mostrar. Sem esta
// lista, quem atende paciente veria o Centro operacional (nome do usuário do
// banco, serviços parados) e o Horário já preenchido.
//
// A permissão continua sendo do servidor: as ações batem em 403 de qualquer
// jeito. Isto é a tela voltando a esconder o que escondia.
const SECOES_SO_DE_QUEM_GERENCIA = new Set(['diagnostico-card', 'serena-teste-card', 'serena-horario-card']);
let podeGerenciarSerena = false;

/** Guarda a permissão e tira da barra os botões que não são dessa pessoa. */
function aplicarPermissaoNasSecoesDaSerena(pode) {
  podeGerenciarSerena = pode === true;
  for (const botao of document.querySelectorAll('[data-secao-serena]')) {
    const restrita = SECOES_SO_DE_QUEM_GERENCIA.has(botao.dataset.secaoSerena);
    botao.hidden = restrita && !podeGerenciarSerena;
  }
}

function abrirSecaoDaSerena(id, { lembrar = true } = {}) {
  const paineis = [...document.querySelectorAll('[data-painel-serena]')];
  if (paineis.length === 0) return;

  // Um id restrito (digitado, ou guardado no localStorage de quando a pessoa
  // tinha outra permissão) cai no padrão em vez de abrir — ou de deixar a tela
  // sem nenhum painel, que era o outro final possível.
  const permitido = (painel) => !SECOES_SO_DE_QUEM_GERENCIA.has(painel) || podeGerenciarSerena;
  const existe = paineis.some((painel) => painel.id === id);
  const alvo = existe && permitido(id) ? id : SECAO_SERENA_PADRAO;

  for (const painel of paineis) painel.hidden = painel.id !== alvo;

  // Cartoes que pertencem ao mesmo assunto (Versoes, ao lado do Prompt)
  // aparecem junto. O editor de prompt tambem tem `data-segue`, mas quem
  // decide se ele abre e o clique em editar — aqui so garantimos que ele nao
  // sobre numa secao a que nao pertence.
  for (const extra of document.querySelectorAll('[data-segue]')) {
    if (extra.dataset.segue !== alvo) extra.hidden = true;
    else if (!extra.id || extra.id !== 'serena-editor') extra.hidden = false;
  }

  for (const botao of document.querySelectorAll('[data-secao-serena]')) {
    const ativo = botao.dataset.secaoSerena === alvo;
    if (ativo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }

  if (lembrar) {
    // localStorage pode falhar (janela anônima, site bloqueado): a tela não
    // pode cair por causa de uma preferência.
    try { localStorage.setItem(CHAVE_SECAO_SERENA, alvo); } catch { }
  }
}

/**
 * O ponto de cada botão.
 *
 * Verde = no ar, vermelho = parado, cinza = não se aplica (nada a ligar ali).
 * O par verde/vermelho é a convenção que todo mundo lê sem pensar; num painel
 * de operação, inverter custaria mais do que economiza.
 */
// Os nomes abaixo são os da resposta de GET /api/serena (src/servidor/rotas-serena.js).
// A primeira versão inventou `dados.canal`, `prompt_publicado` e
// `horario.atendendo_agora` — nenhum existe, então as três luzes ficavam
// vermelhas com tudo funcionando. testes/luzes-serena.test.js roda esta função
// contra a resposta REAL da rota, que é o que pega esse tipo de erro.
function desenharLuzesDaSerena(dados = {}) {
  const horario = dados?.horario ?? {};
  const estado = {
    whatsapp: dados?.whatsapp?.estado === 'conectado' ? 'ok' : 'parado',
    // Centro operacional e Testar não têm liga/desliga: são ferramentas.
    diagnostico: 'neutro',
    teste: 'neutro',
    voz: 'neutro',
    // `atendendo` já combina interruptor, pausa, plantão e grade — o servidor
    // resolve essa precedência e a tela não a reimplementa.
    horario: horario.atendendo === true ? 'ok'
      : (horario.agenda?.ativa ? 'parado' : 'neutro'),
    prompt: dados?.prompt_ativo ? 'ok' : 'parado',
    regras: (dados?.regras ?? []).filter((regra) => regra.ativa).length > 0 ? 'ok' : 'neutro',
  };

  for (const [nome, valor] of Object.entries(estado)) {
    const luz = seletor(`[data-luz="${nome}"]`);
    if (!luz) continue;
    luz.dataset.estado = valor;
    const botao = luz.closest('[data-secao-serena]');
    if (botao) {
      const rotulo = (botao.textContent || '').trim();
      const legenda = valor === 'ok' ? 'no ar' : valor === 'parado' ? 'parado' : '';
      botao.title = legenda ? `${rotulo}: ${legenda}` : rotulo;
    }
  }
}

for (const botao of document.querySelectorAll('[data-secao-serena]')) {
  botao.addEventListener('click', () => abrirSecaoDaSerena(botao.dataset.secaoSerena));
}

async function carregarSerena() {
  try {
    const dados = await pedirJson('/api/serena');
    serenaPainel = dados;

    desenharEstadoDaSerena(dados);

    const controle = seletor('#serena-controle');
    if (controle) controle.hidden = !dados.pode_gerenciar;

    // A permissão vem ANTES de escolher a seção: é ela que diz quais botões
    // existem para esta pessoa e qual seção pode abrir.
    aplicarPermissaoNasSecoesDaSerena(dados.pode_gerenciar);

    // A seção guardada vale entre visitas; sem ela, quem trabalha no Centro
    // operacional voltaria ao WhatsApp a cada carga.
    let guardada = null;
    try { guardada = localStorage.getItem(CHAVE_SECAO_SERENA); } catch { }
    abrirSecaoDaSerena(guardada || SECAO_SERENA_PADRAO, { lembrar: false });

    desenharLuzesDaSerena(dados);

    // Mesmo gate do cartão: escolher canal é mexer no atendimento.
    const canais = seletor('#serena-canais');
    if (canais) canais.hidden = !dados.pode_gerenciar;

    // Os cartões restritos (Horário, Testar, Centro operacional) NÃO são
    // revelados aqui. Quem decide qual painel está aberto é a navegação
    // (abrirSecaoDaSerena, logo acima); `hidden = !pode_gerenciar` punha os
    // três de volta na tela para o admin — e a tela voltava a ser a pilha de
    // cartões abertos que a navegação veio substituir. Esconder quem não pode
    // já é feito por SECOES_SO_DE_QUEM_GERENCIA + abrirSecaoDaSerena.
    if (dados.pode_gerenciar) {
      // As duas listas precisam existir antes do primeiro uso da seção: quem
      // vai testar escolhe o modelo primeiro, não depois de já ter conversado.
      carregarModelosDoTeste().catch(() => {});
      carregarSeletorDeIaDoDiagnostico().catch(() => {});
    }
    desenharHorario(dados.horario ?? null);
    for (const alvo of ['#serena-prompt-acoes', '#serena-regras-acoes']) {
      const bloco = seletor(alvo);
      if (bloco) bloco.hidden = !dados.pode_gerenciar;
    }

    const versao = seletor('#serena-versao');
    if (versao) versao.textContent = dados.prompt_ativo ? `v${dados.prompt_ativo.versao}` : '—';

    const titulo = seletor('#serena-prompt-titulo');
    if (titulo) {
      titulo.textContent = dados.prompt_ativo
        ? `${dados.prompt_ativo.titulo} — publicado em ${new Date(dados.prompt_ativo.publicado_em).toLocaleString('pt-BR')}`
        : 'Nenhuma versão publicada.';
    }

    const efetivo = seletor('#serena-prompt-efetivo');
    if (efetivo) efetivo.textContent = dados.prompt_efetivo ?? '—';

    await carregarEstadoDaVoz();
    desenharVersoes(dados.versoes ?? [], dados.pode_gerenciar);
    desenharRegras(dados.regras ?? [], dados.pode_gerenciar);

    // Sem await: esta consulta atravessa o gateway e pode demorar até 30s se a
    // instância da clínica estiver fora. Segurar versões e regras por causa dela
    // deixaria o painel inteiro em branco por um dado que é um detalhe da tela.
    desenharEstadoDoCanal().catch(() => {});
  } catch (erro) {
    pintarEstado('#serena-openclaw', 'Indisponível', 'ruim');
    informar(`Não foi possível carregar a Serena: ${erro.message}`);
  }
}

// ---------------------------------------------------------------- voz

let clienteDeVoz = null;
let sessaoDeVozId = null;
let estadoDaVoz = null;

const ROTULOS_DA_VOZ = {
  pedindo_microfone: 'aguardando permissão do microfone…',
  ouvindo: 'ouvindo — pode falar',
  falando: 'fala detectada…',
  processando: 'processando…',
  respondendo: 'Serena está respondendo…',
  encerrada: 'sessão encerrada',
};

function desenharEstadoDaVoz() {
  const estado = seletor('#serena-voz-estado');
  const detalhe = seletor('#serena-voz-detalhe');
  const iniciar = seletor('#serena-voz-iniciar');
  const consentiu = seletor('#serena-voz-consentimento')?.checked === true;
  if (!estado || !detalhe || !iniciar) return;

  const pronta = estadoDaVoz?.pronta === true;
  estado.textContent = pronta ? 'pronto' : (estadoDaVoz?.ativa ? 'indisponível' : 'desligado');
  estado.dataset.tom = pronta ? 'ok' : 'alerta';
  iniciar.disabled = !pronta || !consentiu || Boolean(clienteDeVoz);
  if (!clienteDeVoz) {
    detalhe.textContent = pronta
      ? `Perfil ${estadoDaVoz.perfil}; sessão limitada a ${Math.round(estadoDaVoz.limite_segundos / 60)} min. Use fone de ouvido.`
      : (estadoDaVoz?.prompt_publicado === false
        ? 'Publique um prompt para liberar o teste.'
        : 'Configure e ligue o gateway de voz para liberar o teste.');
  }
}

async function carregarEstadoDaVoz() {
  try {
    estadoDaVoz = await pedirJson('/api/serena/voz/status');
  } catch {
    estadoDaVoz = { ativa: false, pronta: false };
  }
  desenharEstadoDaVoz();
}

function adicionarTranscricaoDaVoz(papel, texto) {
  const lista = seletor('#serena-voz-transcricao');
  if (!lista) return;
  if (lista.querySelector('.vazio')) lista.innerHTML = '';
  const item = document.createElement('li');
  const autor = document.createElement('strong');
  autor.textContent = papel === 'serena' ? 'Serena: ' : 'Você: ';
  item.append(autor, document.createTextNode(String(texto)));
  lista.append(item);
  lista.scrollTop = lista.scrollHeight;
}

async function iniciarVoz() {
  const consentimento = seletor('#serena-voz-consentimento')?.checked === true;
  if (!consentimento) return;
  const detalhe = seletor('#serena-voz-detalhe');
  try {
    const sessao = await pedirJson('/api/serena/voz/sessoes', {
      metodo: 'POST', corpo: { consentimento: true },
    });
    sessaoDeVozId = sessao.sessao_id;
    clienteDeVoz = new window.SerenaVozCliente({
      aoEstado(estado) { if (detalhe) detalhe.textContent = ROTULOS_DA_VOZ[estado] ?? estado; },
      aoTurno: adicionarTranscricaoDaVoz,
      aoErro(erro) { if (detalhe) detalhe.textContent = erro.message; },
    });
    seletor('#serena-voz-iniciar').disabled = true;
    seletor('#serena-voz-parar').hidden = false;
    await clienteDeVoz.iniciar(sessao.websocket_url);
  } catch (erro) {
    if (detalhe) detalhe.textContent = erro.detalhe || erro.message;
    await pararVoz();
  }
}

async function pararVoz() {
  const cliente = clienteDeVoz;
  const sessaoId = sessaoDeVozId;
  clienteDeVoz = null;
  sessaoDeVozId = null;
  if (cliente) await cliente.parar().catch(() => {});
  if (sessaoId) {
    await pedirJson(`/api/serena/voz/sessoes/${encodeURIComponent(sessaoId)}/encerrar`, { metodo: 'POST' }).catch(() => {});
  }
  const parar = seletor('#serena-voz-parar');
  if (parar) parar.hidden = true;
  desenharEstadoDaVoz();
}

seletor('#serena-voz-consentimento')?.addEventListener('change', desenharEstadoDaVoz);
seletor('#serena-voz-iniciar')?.addEventListener('click', iniciarVoz);
seletor('#serena-voz-parar')?.addEventListener('click', pararVoz);

/**
 * `botao`, quando informado, fica desabilitado e com o texto "Aplicando…"
 * enquanto o comando ainda não foi confirmado pelo servidor — clique duplo
 * não pode virar dois comandos concorrentes, e "Aplicando…" é o único estado
 * honesto entre "cliquei" e "o servidor confirmou".
 */
async function alternarSerena(ativa, botao = null) {
  // O motivo é só para auditoria (o backend aceita `null` sem reclamar — ver
  // definirAtiva em src/dominio/serena-servico.js). Antes disto, cancelar ou
  // deixar o popup em branco fazia a função `return` aqui, sem chamar a API,
  // sem mensagem de erro nenhuma: quem clicava em "Desligar" via o botão
  // "aplicar" e nada acontecer, com a Serena continuando ligada — reportado
  // por Edson em produção. Desligar é a ação que existe para parar a
  // automação na frente de um paciente; ela não pode depender de o popup
  // nativo do navegador ter sido preenchido do jeito certo.
  const motivoDigitado = ativa ? null : prompt('Motivo do desligamento (opcional — ajuda a auditoria depois):');
  const motivo = motivoDigitado?.trim() ? motivoDigitado.trim() : null;

  const textoOriginal = botao?.textContent;
  if (botao) {
    botao.disabled = true;
    botao.textContent = 'Aplicando…';
  }
  try {
    await pedirJson('/api/serena/estado', { metodo: 'POST', corpo: { ativa, motivo } });
    // "Comando recebido" não é "Serena efetivamente parada": uma resposta que
    // já estava em geração pode ter sido enviada antes de este comando
    // chegar à barreira final. O texto não promete parada retroativa.
    informar(ativa
      ? 'Comando recebido: Serena ligada.'
      : 'Comando recebido: Serena desligada a partir de agora. Uma resposta que já estava sendo gerada no momento do clique pode ainda ter sido entregue — a barreira de controle bloqueia o que não foi enviado, não o que já saiu.');
    await carregarSerena();
    // O botão de emergência do menu espelha o mesmo interruptor.
    desenharParadaDeEmergencia(ativa);
  } catch (erro) {
    informar(`Não foi possível alterar: ${erro.message}`);
  } finally {
    if (botao) {
      botao.disabled = false;
      if (textoOriginal !== undefined) botao.textContent = textoOriginal;
    }
  }
}

function abrirEditorDePrompt(prompt = null) {
  promptEmEdicao = prompt;
  const editor = seletor('#serena-editor');
  if (!editor) return;

  editor.hidden = false;
  seletor('#serena-editor-titulo').textContent = prompt ? `Editar v${prompt.versao}` : 'Nova versão do prompt';
  seletor('#prompt-titulo').value = prompt?.titulo ?? '';
  seletor('#prompt-conteudo').value = prompt?.conteudo ?? (serenaPainel?.prompt_ativo?.conteudo ?? '');
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function abrirEditorDeRegra(regra = null) {
  regraEmEdicao = regra;
  const form = seletor('#form-regra');
  if (!form) return;

  form.hidden = false;
  seletor('#regra-nome').value = regra?.nome ?? '';
  seletor('#regra-categoria').value = regra?.categoria ?? 'geral';
  seletor('#regra-ordem').value = regra?.ordem ?? 100;
  seletor('#regra-conteudo').value = regra?.conteudo ?? '';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Instagram: regras de gatilho de comentário (palavra -> DM + resposta pública).
// ---------------------------------------------------------------------------

let instagramPainel = null;
let gatilhoEmEdicao = null;

function resumirTexto(texto, limite = 60) {
  const t = String(texto ?? '');
  return t.length > limite ? `${t.slice(0, limite)}…` : t;
}

async function carregarInstagram() {
  try {
    const dados = await pedirJson('/api/instagram');
    instagramPainel = dados;

    const acoes = seletor('#instagram-regras-acoes');
    if (acoes) acoes.hidden = !dados.pode_gerenciar;

    desenharGatilhos(dados.regras ?? [], dados.pode_gerenciar);
    desenharMetricasInstagram(dados.metricas ?? null);
  } catch (erro) {
    informar(`Não foi possível carregar o Instagram: ${erro.message}`);
  }
}


// ---------------------------------------------------------------------------
// Gráficos (12/09/2026) — SVG à mão, porque a CSP do projeto não deixa entrar
// biblioteca de fora e três formas não justificam uma dependência.

/**
 * Soma as linhas do mesmo dia.
 *
 * `leads.por_dia` vem com uma linha por dia E POR ORIGEM (vw_leads_por_dia,
 * ORDER BY dia, origem). Plotar linha a linha desenhava 30 dias × 3 origens =
 * 90 pontos serrilhados, com o mesmo dia repetido três vezes e nenhum deles
 * mostrando o total daquele dia.
 */
function totalPorDia(linhas) {
  const soma = new Map();
  for (const linha of linhas ?? []) {
    if (!linha?.dia) continue;
    const dia = String(linha.dia).slice(0, 10);
    soma.set(dia, (soma.get(dia) ?? 0) + (Number(linha.total) || 0));
  }
  return [...soma.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dia, total]) => ({ dia, total }));
}

/**
 * Põe as etapas na ordem do funil e separa as que não fazem parte da descida.
 *
 * A consulta devolve `ORDER BY estagio` — ordem alfabética: agendado,
 * convertido, novo, perdido, qualificando. Desenhar o funil nessa ordem faz o
 * gráfico anunciar conversões inventadas ("Novos: 900% de quem estava em
 * convertido") e põe "perdido" no meio da descida. A ordem verdadeira é a de
 * src/dominio/leads.js; "perdido" é terminal e sai do cálculo de queda.
 */
const ORDEM_DO_FUNIL = ['novo', 'qualificando', 'agendado', 'convertido'];
const ESTAGIOS_TERMINAIS = ['perdido'];

function ordenarFunil(etapas, { rotulo = 'estagio' } = {}) {
  const porEstagio = new Map((etapas ?? []).filter(Boolean).map((etapa) => [String(etapa[rotulo]), etapa]));
  // Etapa sem nenhum lead não vem na consulta; entra como zero para o funil
  // não pular degrau.
  const descida = ORDEM_DO_FUNIL.map((estagio) => porEstagio.get(estagio) ?? { [rotulo]: estagio, total: 0 });
  const terminais = ESTAGIOS_TERMINAIS.map((estagio) => porEstagio.get(estagio)).filter(Boolean);
  // Qualquer estágio que apareça no banco e não esteja em nenhuma das listas
  // continua sendo mostrado — no fim, sem queda calculada.
  const conhecidos = new Set([...ORDEM_DO_FUNIL, ...ESTAGIOS_TERMINAIS]);
  const sobras = [...porEstagio.values()].filter((etapa) => !conhecidos.has(String(etapa[rotulo])));
  return { descida, fora: [...terminais, ...sobras] };
}

/** Um nó SVG com atributos, sem innerHTML — a CSP não aceita HTML solto. */
function svgEl(nome, atributos = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', nome);
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor !== null && valor !== undefined) el.setAttribute(chave, String(valor));
  }
  return el;
}

/**
 * Linha do tempo: um ponto por dia.
 *
 * Área preenchida sob a linha porque o que importa aqui é volume, não valor
 * exato — e o último ponto ganha um círculo, que é onde o olho procura "como
 * estamos agora".
 */
function graficoDeLinha(pontos, { rotuloValor = 'total' } = {}) {
  const dados = (pontos ?? []).filter((ponto) => ponto && ponto.dia);
  if (dados.length === 0) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio';
    vazio.textContent = 'Sem dados no período.';
    return vazio;
  }

  const L = 560;
  const A = 160;
  const margem = { cima: 14, baixo: 26, lado: 34 };
  const maximo = Math.max(...dados.map((d) => Number(d[rotuloValor]) || 0), 1);
  const largura = L - margem.lado * 2;
  const altura = A - margem.cima - margem.baixo;

  const x = (i) => margem.lado + (dados.length === 1 ? largura / 2 : (i * largura) / (dados.length - 1));
  const y = (v) => margem.cima + altura - ((Number(v) || 0) / maximo) * altura;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${L} ${A}`, class: 'grafico', role: 'img',
    'aria-label': `Evolução por dia. Maior valor: ${maximo}.`,
  });

  // Três linhas de grade: o suficiente para estimar altura sem virar papel
  // quadriculado.
  for (const fracao of [0, 0.5, 1]) {
    const linhaY = margem.cima + altura * fracao;
    svg.append(svgEl('line', {
      x1: margem.lado, x2: L - margem.lado, y1: linhaY, y2: linhaY, class: 'grade',
    }));
    const marca = svgEl('text', { x: margem.lado - 8, y: linhaY + 4, class: 'eixo', 'text-anchor': 'end' });
    marca.textContent = String(Math.round(maximo * (1 - fracao)));
    svg.append(marca);
  }

  const caminho = dados.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[rotuloValor]).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', {
    d: `${caminho} L ${x(dados.length - 1).toFixed(1)} ${margem.cima + altura} L ${x(0).toFixed(1)} ${margem.cima + altura} Z`,
    class: 'area',
  }));
  svg.append(svgEl('path', { d: caminho, class: 'linha' }));

  const ultimo = dados.length - 1;
  svg.append(svgEl('circle', { cx: x(ultimo), cy: y(dados[ultimo][rotuloValor]), r: 4, class: 'ponto' }));

  // Só primeiro e último rótulo: com 30 dias, todos viram borrão.
  for (const i of [...new Set([0, ultimo])]) {
    const texto = svgEl('text', {
      x: x(i), y: A - 8, class: 'eixo',
      'text-anchor': i === 0 ? 'start' : 'end',
    });
    texto.textContent = String(dados[i].dia).slice(5).split('-').reverse().join('/');
    svg.append(texto);
  }

  return svg;
}

/**
 * Funil: cada etapa como uma faixa, com a queda para a seguinte.
 *
 * Barras lado a lado tratam as etapas como categorias independentes. O funil
 * mostra o que se quer saber: quantos sobraram de uma etapa para a outra.
 */
function graficoDeFunil(etapas, { rotulo = 'estagio', valor = 'total' } = {}) {
  const { descida, fora } = ordenarFunil(etapas, { rotulo });
  // Só a descida calcula queda; "perdido" entra depois, sem porcentagem, para
  // não parecer um degrau do caminho.
  const dados = [...descida, ...fora];
  const quantasDaDescida = descida.length;
  if ((etapas ?? []).length === 0) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio';
    vazio.textContent = 'Sem leads no funil.';
    return vazio;
  }

  const topo = Math.max(...dados.map((d) => Number(d[valor]) || 0), 1);
  const lista = document.createElement('ol');
  lista.className = 'funil';

  dados.forEach((etapa, i) => {
    const total = Number(etapa[valor]) || 0;
    const fatia = Math.max((total / topo) * 100, total > 0 ? 6 : 2);

    const item = document.createElement('li');

    const cabecalho = document.createElement('div');
    cabecalho.className = 'funil-topo';
    const nome = document.createElement('span');
    nome.textContent = String(etapa[rotulo] ?? '—');
    const numero = document.createElement('b');
    numero.textContent = String(total);
    cabecalho.append(nome, numero);

    const trilho = document.createElement('div');
    trilho.className = 'funil-trilho';
    const barra = document.createElement('div');
    barra.className = 'funil-barra';
    barra.style.width = `${fatia.toFixed(1)}%`;
    trilho.append(barra);

    item.append(cabecalho, trilho);

    // A queda para a etapa seguinte é a informação que o funil existe para dar
    // — e só faz sentido dentro da descida.
    const anterior = i > 0 && i < quantasDaDescida ? Number(dados[i - 1][valor]) || 0 : null;
    if (anterior !== null && anterior > 0) {
      const queda = document.createElement('small');
      queda.className = 'funil-queda';
      const passou = Math.round((total / anterior) * 100);
      queda.textContent = `${passou}% de quem estava em "${dados[i - 1][rotulo]}"`;
      item.append(queda);
    }

    lista.append(item);
  });

  return lista;
}

function desenharMetricasInstagram(metricas) {
  definirTexto('#ig-metrica-total', metricas ? String(metricas.total_comentarios) : '—');
  definirTexto('#ig-metrica-com-gatilho', metricas ? String(metricas.com_gatilho) : '—');
  definirTexto('#ig-metrica-resposta-publica', metricas ? String(metricas.resposta_publica_enviada) : '—');
  definirTexto('#ig-metrica-dm', metricas ? String(metricas.dm_enviada) : '—');

  const lista = seletor('#instagram-metricas-por-regra');
  if (!lista) return;

  const porRegra = metricas?.por_regra ?? [];
  if (porRegra.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma regra cadastrada ainda.</li>';
    return;
  }

  lista.innerHTML = porRegra.map((linha) => `
    <li class="${linha.ativa ? '' : 'desligada'}">
      <div>
        <strong>${escapar(linha.nome)}</strong>
        <small>${linha.total} comentário(s) processado(s)${linha.ativa ? '' : ' · regra desligada'}</small>
      </div>
    </li>`).join('');
}

function desenharGatilhos(regras, podeGerenciar) {
  const lista = seletor('#instagram-regras');
  if (!lista) return;

  if (regras.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma regra cadastrada.</li>';
    return;
  }

  lista.innerHTML = regras.map((gatilho) => `
    <li class="${gatilho.ativa ? '' : 'desligada'}">
      <div>
        <strong>${escapar(gatilho.nome)} <span class="pilula pequena">${escapar(gatilho.palavra_gatilho)}</span></strong>
        <small>Pública: ${escapar(resumirTexto(gatilho.mensagem_publica))} · DM: ${escapar(resumirTexto(gatilho.mensagem_dm))}</small>
      </div>
      <div class="linha-acoes">
        ${podeGerenciar ? `
          <button type="button" class="secundario" data-gatilho-ativo="${gatilho.id}" data-valor="${gatilho.ativa ? 'false' : 'true'}">
            ${gatilho.ativa ? 'Desligar' : 'Ligar'}
          </button>
          <button type="button" class="secundario" data-editar-gatilho="${gatilho.id}">Editar</button>
          <button type="button" class="perigo" data-remover-gatilho="${gatilho.id}">Apagar</button>` : ''}
      </div>
    </li>`).join('');
}

/**
 * Perfis do Instagram no seletor da regra (049).
 *
 * A lista sai dos agentes que TÊM canal de Instagram cadastrado — é esse
 * cadastro que liga o perfil ao agente. Sem nenhum, o campo nem aparece: o
 * único perfil é o da clínica, e escolher entre um só confundiria.
 */
function desenharPerfisDoGatilho(agenteIdAtual) {
  const campo = seletor('#gatilho-perfil-campo');
  const seletorPerfil = seletor('#gatilho-perfil');
  if (!campo || !seletorPerfil) return;

  const comInstagram = (agentesPainel?.agentes ?? [])
    .filter((agente) => (agente.canais ?? []).some((canal) => canal.canal === 'instagram'));

  campo.hidden = comInstagram.length === 0;
  seletorPerfil.innerHTML = '<option value="">Clínica (Serena)</option>'
    + comInstagram.map((agente) =>
      `<option value="${Number(agente.id)}">${escapar(agente.nome)}</option>`).join('');
  seletorPerfil.value = agenteIdAtual === null || agenteIdAtual === undefined ? '' : String(agenteIdAtual);
}

function abrirEditorDeGatilho(gatilho = null) {
  gatilhoEmEdicao = gatilho;
  const form = seletor('#form-gatilho');
  if (!form) return;

  form.hidden = false;
  seletor('#gatilho-nome').value = gatilho?.nome ?? '';
  seletor('#gatilho-palavra').value = gatilho?.palavra_gatilho ?? '';
  seletor('#gatilho-mensagem-publica').value = gatilho?.mensagem_publica ?? '';
  seletor('#gatilho-mensagem-dm').value = gatilho?.mensagem_dm ?? '';
  seletor('#gatilho-cta-whatsapp').checked = gatilho ? gatilho.cta_whatsapp === true : true;
  desenharPerfisDoGatilho(gatilho?.agente_id ?? null);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Agentes configuráveis (docs/AGENTES.md): lista, editor por abas e teste.
//
// A tela só fala com /api/agentes*; quem valida é o servidor (regras.js). O
// que a pessoa não pode mudar aparece desabilitado (fieldset) em vez de deixar
// o clique descobrir o 403. Ligar um agente pede confirmação: a partir dali
// ele responde clientes de verdade.
// ---------------------------------------------------------------------------

// `desativado` é o que Pausar grava (a 046 não tem "pausado"): na tela é "Pausado",
// o mesmo nome do Controle da automação.
const ROTULO_STATUS_AGENTE = { ativo: 'Atendendo', treinamento: 'Em treinamento', desativado: 'Pausado' };
const TOM_STATUS_AGENTE = { ativo: 'ok', treinamento: 'alerta', desativado: 'alerta' };
const ROTULO_TIPO_TREINAMENTO = { texto: 'Texto', website: 'Website', documento: 'Documento', video: 'Vídeo' };
const BOOLEANAS_DO_AGENTE = [
  'transferir_para_humano', 'resumo_ao_transferir', 'usar_emojis', 'assinar_nome',
  'restringir_temas', 'dividir_resposta', 'consultar_dados_contato', 'busca_inteligente',
];
const MINUTOS_DE_INATIVIDADE = [
  [2, '2 minutos'], [5, '5 minutos'], [10, '10 minutos'], [15, '15 minutos'], [30, '30 minutos'],
  [60, '1 hora'], [120, '2 horas'], [240, '4 horas'], [480, '8 horas'], [1440, '1 dia'],
  [2880, '2 dias'], [4320, '3 dias'], [5760, '4 dias'], [7200, '5 dias'], [8640, '6 dias'], [10080, '7 dias'],
];
const LIMITE_TREINAMENTO_CARACTERES = 50000;

let agentesPainel = null;
let agenteAberto = null;
let conversaDeTesteDoAgente = [];

// `escapar` passa por textContent/innerHTML, que não escapa aspas: serve para
// texto, não para valor de atributo. Tudo que vai entre aspas usa este.
function escaparAtributo(texto) {
  return escapar(texto).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mensagemDeErroDoAgente(erro) {
  return erro?.detalhe || erro?.message || 'erro desconhecido';
}

async function carregarAgentes() {
  if (!podeFazer('agentes:ler')) return;
  // Estado da Serena ainda desconhecido (a leitura do interruptor falhou na
  // abertura da sessao): pergunta de novo, senao a linha dela ficaria sem
  // pilula ate alguem recarregar a pagina.
  if (serenaNoAr === null) sincronizarParadaDeEmergencia();
  const abertoAoEntrar = agenteAberto?.agente?.id ?? null;
  try {
    agentesPainel = await pedirJson('/api/agentes');
    const acoes = seletor('#agentes-acoes');
    if (acoes) acoes.hidden = !agentesPainel.pode_gerenciar;
    desenharListaDeAgentes(agentesPainel.agentes ?? []);
    if (abertoAoEntrar && agenteAberto?.agente?.id === abertoAoEntrar) await abrirAgente(abertoAoEntrar);
  } catch (erro) {
    informar(`Não foi possível carregar os agentes: ${mensagemDeErroDoAgente(erro)}`);
  }
}

/** Linha da Serena na lista: ela não está na tabela `agentes` (é o motor da
 *  clínica), mas quem opera precisa ver os dois no mesmo lugar. */
function linhaDaSerena() {
  const desconhecido = serenaNoAr === null;
  const pilula = ` <span class="pilula pequena" data-pilula-serena data-tom="${serenaNoAr ? 'ok' : 'alerta'}"${desconhecido ? ' hidden' : ''}>${serenaNoAr ? 'Atendendo' : 'Parada'}</span>`;
  return `
    <li>
      <div>
        <strong>Serena${pilula}</strong>
        <small>Agente da clínica · WhatsApp e Instagram da Clínica Dr. Edson Barroso</small>
      </div>
      <div class="linha-acoes">
        <button type="button" class="secundario" data-abrir-serena="1">Abrir</button>
      </div>
    </li>`;
}

/** Mantém a pílula da Serena igual ao botão de parada, sem redesenhar a lista. */
function desenharEstadoDaSerenaNaLista() {
  const pilula = seletor('[data-pilula-serena]');
  if (!pilula || serenaNoAr === null) return;
  pilula.dataset.tom = serenaNoAr ? 'ok' : 'alerta';
  pilula.textContent = serenaNoAr ? 'Atendendo' : 'Parada';
  pilula.hidden = false;
}

/** Um item de menu por agente cadastrado, ao lado da Serena. Clicar abre a tela
 *  Agentes já com aquele agente aberto — era o caminho de quatro cliques que
 *  fazia parecer que o Alpins "não estava no CRM". */
/** Marca no menu qual agente está aberto (null = nenhum, volta para a lista). */
function destacarAgenteNoMenu(id) {
  const alvo = id === null || id === undefined ? null : String(Number(id));
  for (const botao of document.querySelectorAll('#menu-agentes [data-abrir-agente-menu]')) {
    if (botao.dataset.abrirAgenteMenu === alvo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }
  const lista = seletor('#item-agentes button');
  if (!lista) return;
  if (alvo) lista.removeAttribute('aria-current');
  else if (seletor('#agentes')?.hidden === false) lista.setAttribute('aria-current', 'page');
}

function desenharMenuDeAgentes(agentes) {
  const grupo = seletor('#menu-agentes');
  const ancora = seletor('#item-agentes');
  if (!grupo || !ancora) return;

  // Quem está com o foco num item que vai ser recriado volta a tê-lo depois.
  const focado = document.activeElement?.dataset?.abrirAgenteMenu ?? null;

  for (const antigo of grupo.querySelectorAll('[data-agente-menu]')) antigo.remove();

  for (const agente of agentes) {
    const item = document.createElement('li');
    item.dataset.agenteMenu = String(Number(agente.id));
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.dataset.tela = 'agentes';
    botao.dataset.abrirAgenteMenu = String(Number(agente.id));
    // Mesmo sprite dos itens fixos: um agente criado pela tela não pode
    // parecer de outra família que a Serena.
    const icone = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icone.setAttribute('class', 'icone-menu');
    icone.setAttribute('aria-hidden', 'true');
    const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    uso.setAttribute('href', '#i-agente');
    icone.append(uso);
    const nome = String(agente.nome ?? '');
    botao.title = nome;
    botao.append(icone, ` ${nome.length > 24 ? `${nome.slice(0, 23)}…` : nome}`);
    // Cor só quando há o que avisar: agente que não está atendendo ganha ponto
    // âmbar; o que está no ar fica igual aos demais itens do menu. O ponto é
    // decoração — quem diz o estado é o texto ao lado, lido só por leitor de
    // tela (o `title` do ponto não era anunciado nem alcançável por teclado).
    if (agente.status !== 'ativo') {
      const aviso = document.createElement('b');
      aviso.className = 'aviso-menu';
      aviso.setAttribute('aria-hidden', 'true');
      aviso.textContent = '•';
      const estado = document.createElement('span');
      estado.className = 'oculto-visual';
      estado.textContent = ` — ${ROTULO_STATUS_AGENTE[agente.status] ?? agente.status}`;
      botao.append(aviso, estado);
    }
    if (escopoAtual && !veClinica()) item.hidden = true;
    item.append(botao);
    grupo.insertBefore(item, ancora);
  }

  destacarAgenteNoMenu(agenteAberto?.agente?.id ?? null);
  if (focado) seletor(`[data-abrir-agente-menu="${CSS.escape(focado)}"]`)?.focus();
}

function desenharListaDeAgentes(agentes) {
  const lista = seletor('#lista-agentes');
  if (!lista) return;

  desenharMenuDeAgentes(agentes);

  if (agentes.length === 0) {
    lista.innerHTML = `${linhaDaSerena()}<li class="vazio">Nenhum outro agente cadastrado.</li>`;
    return;
  }

  lista.innerHTML = linhaDaSerena() + agentes.map((agente) => {
    const canais = (agente.canais ?? []).map((canal) => `${canal.canal}: ${canal.instancia}`).join(', ') || 'sem canal';
    return `
    <li class="${agente.status === 'ativo' ? '' : 'desligada'}">
      <div>
        <strong>${escapar(agente.nome)} <span class="pilula pequena" data-tom="${TOM_STATUS_AGENTE[agente.status] ?? ''}">${escapar(ROTULO_STATUS_AGENTE[agente.status] ?? agente.status)}</span></strong>
        <small>${escapar(agente.descricao ?? agente.slug)} · ${escapar(canais)}</small>
      </div>
      <div class="linha-acoes">
        <button type="button" class="secundario" data-abrir-agente="${Number(agente.id)}">Abrir</button>
      </div>
    </li>`;
  }).join('');
}

async function abrirAgente(id) {
  try {
    const dados = await pedirJson(`/api/agentes/${Number(id)}`);
    const trocouDeAgente = agenteAberto?.agente?.id !== dados.agente.id;
    agenteAberto = dados;
    if (trocouDeAgente) {
      conversaDeTesteDoAgente = [];
      // Como na Serena: quem configura cai em "Testar o agente"; quem só
      // acompanha (o teste gasta IA e é de quem gerencia), no comportamento no ar.
      selecionarAbaDoAgente(dados.pode_gerenciar ? 'teste' : 'perfil');
      // B2: nada do agente anterior fica na tela nem clicável enquanto a
      // operação do novo não chega.
      zerarOperacaoDoAgente();
      zerarWhatsappDoAgente();
    }
    destacarAgenteNoMenu(dados.agente.id);
    desenharLuzesDoAgente(dados);
    preencherEditorDeAgente();
    carregarEquipeDoAgente();
    const editor = seletor('#agente-editor');
    editor.hidden = false;
    if (trocouDeAgente) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Sem `await`: o painel de operação espera a Evolution e não pode travar o editor.
    carregarOperacaoDoAgente();
  } catch (erro) {
    informar(`Não foi possível abrir o agente: ${mensagemDeErroDoAgente(erro)}`);
  }
}

/**
 * O ponto de estado de cada aba do agente.
 *
 * Mesma leitura da tela da Serena: verde no ar, vermelho parado, cinza quando
 * não há o que ligar. Aqui "parado" quase sempre quer dizer "falta
 * configurar" — é o que a pessoa precisa ver antes de ligar um agente.
 */
/** Pinta uma luz da barra de abas do agente e explica o estado no title. */
function acenderLuzDoAgente(nome, valor) {
  const luz = seletor(`[data-luz-agente="${nome}"]`);
  if (!luz) return;
  luz.dataset.estado = valor;
  const aba = luz.closest('[data-aba-agente]');
  if (!aba) return;
  const rotulo = (aba.textContent || '').trim();
  const legenda = valor === 'ok' ? 'configurado' : valor === 'parado' ? 'falta configurar' : '';
  aba.title = legenda ? `${rotulo}: ${legenda}` : rotulo;
}

function desenharLuzesDoAgente(dados = {}) {
  const agente = dados.agente ?? {};
  const canais = dados.canais ?? agente.canais ?? [];
  const treinamentos = dados.treinamentos ?? [];
  const configuracoes = agente.configuracoes ?? {};

  const estado = {
    // Ferramenta: não tem liga/desliga.
    teste: 'neutro',
    horario: configuracoes.horario?.ativa ? 'ok' : 'neutro',
    // O comportamento é o que o agente diz ao cliente: sem ele, o agente não
    // tem identidade e não deveria atender.
    perfil: String(agente.comportamento ?? '').trim() ? 'ok' : 'parado',
    treinamentos: treinamentos.length > 0 ? 'ok' : 'neutro',
    trabalho: 'neutro',
    configuracoes: 'neutro',
    inatividade: (agente.acoes_inatividade ?? []).some((acao) => acao.ativa !== false) ? 'ok' : 'neutro',
    // Sem canal o agente não recebe nem responde nada.
    canais: canais.length > 0 ? 'ok' : 'parado',
  };

  for (const [nome, valor] of Object.entries(estado)) acenderLuzDoAgente(nome, valor);

  // Enquanto a equipe não chega, a luz dela fica neutra em vez de mentir que
  // falta configurar.
  acenderLuzDoAgente('equipe', 'neutro');
}

function selecionarAbaDoAgente(nome) {
  for (const aba of document.querySelectorAll('[data-aba-agente]')) {
    const ativa = aba.dataset.abaAgente === nome;
    aba.classList.toggle('selecionada', ativa);
    aba.setAttribute('aria-selected', String(ativa));
    // `aria-current` é o que o estilo das seções usa para pintar o item
    // aberto — o mesmo desenho da tela da Serena.
    if (ativa) aba.setAttribute('aria-current', 'page');
    else aba.removeAttribute('aria-current');
  }
  for (const painel of document.querySelectorAll('[data-painel-agente]')) {
    painel.hidden = painel.dataset.painelAgente !== nome;
  }
}

function preencherEditorDeAgente() {
  const { agente, treinamentos = [], historico = [], pode_gerenciar: pode } = agenteAberto;

  definirTexto('#agente-editor-titulo', agente.nome);
  definirTexto('#agente-editor-resumo', `${agente.slug}${agente.descricao ? ` · ${agente.descricao}` : ''}`);
  const pilula = seletor('#agente-status-pilula');
  if (pilula) {
    pilula.textContent = ROTULO_STATUS_AGENTE[agente.status] ?? agente.status;
    pilula.dataset.tom = TOM_STATUS_AGENTE[agente.status] ?? '';
  }

  for (const conjunto of document.querySelectorAll('#agente-editor .agente-campos')) conjunto.disabled = !pode;
  // O teste gasta uma chamada de IA por mensagem: é parte de configurar.
  const abaTeste = seletor('[data-aba-agente="teste"]');
  if (abaTeste) abaTeste.hidden = !pode;

  seletor('#agente-nome').value = agente.nome ?? '';
  seletor('#agente-descricao').value = agente.descricao ?? '';
  seletor('#agente-comunicacao').value = agente.comunicacao;
  seletor('#agente-comportamento').value = agente.comportamento ?? '';
  atualizarContadorDoComportamento();
  preencherModelosDoAgente(agente);
  desenharHistoricoDoComportamento(historico, pode);

  seletor('#agente-finalidade').value = agente.finalidade;
  seletor('#agente-empresa-nome').value = agente.empresa_nome ?? '';
  seletor('#agente-empresa-site').value = agente.empresa_site ?? '';
  seletor('#agente-empresa-descricao').value = agente.empresa_descricao ?? '';

  desenharTreinamentosDoAgente(treinamentos, pode);
  alternarCamposDeTreinamento();

  const configuracoes = agente.configuracoes ?? {};
  for (const chave of BOOLEANAS_DO_AGENTE) {
    const caixa = seletor(`#agente-cfg-${chave}`);
    if (caixa) caixa.checked = configuracoes[chave] === true;
  }
  seletor('#agente-cfg-fuso').value = configuracoes.fuso ?? '';
  seletor('#agente-cfg-tempo_resposta_segundos').value = configuracoes.tempo_resposta_segundos ?? '';
  seletor('#agente-cfg-limite_interacoes').value = configuracoes.limite_interacoes ?? '';
  seletor('#agente-cfg-acao_limite').value = configuracoes.acao_limite ?? 'transferir';
  seletor('#agente-cfg-horario').value = configuracoes.horario ? JSON.stringify(configuracoes.horario, null, 2) : '';

  desenharLinhasDeInatividade(agente.acoes_inatividade ?? [], pode);
  desenharLinhasDeCanais(agente.canais ?? [], pode);
  desenharConversaDeTesteDoAgente();
}

function preencherModelosDoAgente(agente) {
  const campo = seletor('#agente-modelo');
  if (!campo) return;

  const atual = agente.provedor || agente.modelo ? `${agente.provedor ?? ''}|${agente.modelo ?? ''}` : '';
  let encontrado = atual === '';
  const opcoes = ['<option value="">Padrão do catálogo</option>'];
  for (const grupo of agentesPainel?.catalogo ?? []) {
    for (const modelo of grupo.modelos ?? []) {
      const valor = `${grupo.provedor}|${modelo.modelo}`;
      if (valor === atual) encontrado = true;
      const rotulo = `${modelo.rotulo ?? modelo.modelo} (${grupo.provedor}${grupo.disponivel ? '' : ', sem chave no servidor'})`;
      opcoes.push(`<option value="${escaparAtributo(valor)}"${grupo.disponivel ? '' : ' disabled'}>${escapar(rotulo)}</option>`);
    }
  }
  // Modelo gravado que saiu do catálogo continua visível: sumir com ele da
  // lista faria o próximo "salvar" trocar o modelo sem ninguém ter decidido.
  if (!encontrado) {
    opcoes.push(`<option value="${escaparAtributo(atual)}">${escapar(`${agente.modelo ?? '?'} (${agente.provedor ?? '?'}, fora do catálogo)`)}</option>`);
  }
  campo.innerHTML = opcoes.join('');
  campo.value = atual;
}

function atualizarContadorDoComportamento() {
  const campo = seletor('#agente-comportamento');
  definirTexto('#agente-comportamento-contador', `${campo?.value.length ?? 0}/20000`);
}

function desenharHistoricoDoComportamento(historico, pode) {
  const lista = seletor('#agente-historico');
  if (!lista) return;

  if (historico.length === 0) {
    lista.innerHTML = '<li class="vazio">Sem versões anteriores.</li>';
    return;
  }

  lista.innerHTML = historico.map((versao, indice) => {
    const quando = versao.criado_em ? new Date(versao.criado_em).toLocaleString('pt-BR') : 'data desconhecida';
    return `
    <li>
      <div>
        <strong>${indice === 0 ? 'Versão atual' : `Versão de ${escapar(quando)}`}</strong>
        <small>${escapar(resumirTexto(versao.comportamento, 140))}</small>
      </div>
      <div class="linha-acoes">
        ${pode && indice > 0 ? `<button type="button" class="secundario" data-restaurar-comportamento="${Number(versao.id)}">Restaurar</button>` : ''}
      </div>
    </li>`;
  }).join('');
}

function desenharTreinamentosDoAgente(treinamentos, pode) {
  const lista = seletor('#agente-treinamentos');
  if (!lista) return;
  definirTexto('#agente-treinamentos-total', `Treinamentos cadastrados (${treinamentos.length})`);

  if (treinamentos.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhum treinamento.</li>';
    return;
  }

  lista.innerHTML = treinamentos.map((treinamento) => {
    const tipo = ROTULO_TIPO_TREINAMENTO[treinamento.tipo] ?? treinamento.tipo;
    return `
    <li class="${treinamento.status === 'erro' ? 'desligada' : ''}">
      <div>
        <strong>${escapar(treinamento.titulo || tipo)} <span class="pilula pequena">${escapar(tipo)}</span></strong>
        <small>${escapar(resumirTexto(treinamento.conteudo, 180))}${treinamento.origem ? ` · ${escapar(treinamento.origem)}` : ''}</small>
      </div>
      <div class="linha-acoes">
        ${pode ? `<button type="button" class="perigo" data-remover-treinamento="${Number(treinamento.id)}">Remover</button>` : ''}
      </div>
    </li>`;
  }).join('');
}

function alternarCamposDeTreinamento() {
  const tipo = seletor('#agente-treino-tipo')?.value ?? 'texto';
  for (const bloco of document.querySelectorAll('[data-campo-treino]')) {
    bloco.hidden = bloco.dataset.campoTreino !== tipo;
  }
}

function opcoesDeMinutos(selecionado) {
  const conhecido = MINUTOS_DE_INATIVIDADE.some(([valor]) => valor === selecionado);
  const lista = conhecido ? MINUTOS_DE_INATIVIDADE : [[selecionado, `${selecionado} minutos`], ...MINUTOS_DE_INATIVIDADE];
  return lista
    .map(([valor, rotulo]) => `<option value="${Number(valor)}"${valor === selecionado ? ' selected' : ''}>${escapar(rotulo)}</option>`)
    .join('');
}

function desenharLinhasDeInatividade(acoes, pode = agenteAberto?.pode_gerenciar) {
  const lista = seletor('#agente-inatividade-linhas');
  if (!lista) return;

  if (acoes.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhuma ação: a conversa fica aberta até alguém agir.</li>';
    return;
  }

  lista.innerHTML = acoes.map((acao, indice) => `
    <li class="linha-inatividade">
      <span>Se o cliente não responder em</span>
      <select data-campo="apos_minutos" aria-label="Tempo sem resposta">${opcoesDeMinutos(Number(acao.apos_minutos))}</select>
      <span>o agente deve</span>
      <select data-campo="acao" aria-label="Ação">
        <option value="finalizar"${acao.acao === 'finalizar' ? ' selected' : ''}>Finalizar atendimento</option>
        <option value="interagir"${acao.acao === 'interagir' ? ' selected' : ''}>Interagir com o cliente</option>
      </select>
      <input type="text" data-campo="instrucao" maxlength="512" aria-label="Instrução" placeholder="Instrução (obrigatória em Interagir)" value="${escaparAtributo(acao.instrucao ?? '')}">
      ${pode ? `<button type="button" class="perigo" data-remover-inatividade="${indice}">Remover</button>` : ''}
    </li>`).join('');
}

function lerLinhasDeInatividade() {
  return [...document.querySelectorAll('#agente-inatividade-linhas .linha-inatividade')].map((linha) => ({
    apos_minutos: Number(linha.querySelector('[data-campo="apos_minutos"]').value),
    acao: linha.querySelector('[data-campo="acao"]').value,
    instrucao: linha.querySelector('[data-campo="instrucao"]').value.trim() || null,
  }));
}

function desenharLinhasDeCanais(canais, pode = agenteAberto?.pode_gerenciar) {
  const lista = seletor('#agente-canais-linhas');
  if (!lista) return;

  if (canais.length === 0) {
    lista.innerHTML = '<li class="vazio">Nenhum canal: o agente não recebe nem envia mensagens.</li>';
    return;
  }

  lista.innerHTML = canais.map((canal, indice) => `
    <li class="linha-canal">
      <select data-campo="canal" aria-label="Canal">
        <option value="whatsapp"${canal.canal === 'whatsapp' ? ' selected' : ''}>WhatsApp</option>
        <option value="instagram"${canal.canal === 'instagram' ? ' selected' : ''}>Instagram</option>
      </select>
      <input type="text" data-campo="instancia" maxlength="100" aria-label="Nome da instância" placeholder="nome da instância (ex.: alpins)" value="${escaparAtributo(canal.instancia ?? '')}">
      <label class="marcador"><input type="checkbox" data-campo="ativo"${canal.ativo === false ? '' : ' checked'}> ativo</label>
      ${pode ? `<button type="button" class="perigo" data-remover-canal="${indice}">Remover</button>` : ''}
    </li>`).join('');
}

function lerLinhasDeCanais() {
  return [...document.querySelectorAll('#agente-canais-linhas .linha-canal')].map((linha) => ({
    canal: linha.querySelector('[data-campo="canal"]').value,
    instancia: linha.querySelector('[data-campo="instancia"]').value.trim(),
    ativo: linha.querySelector('[data-campo="ativo"]').checked,
  }));
}

function desenharConversaDeTesteDoAgente() {
  const registro = seletor('#agente-teste-log');
  if (!registro) return;

  if (conversaDeTesteDoAgente.length === 0) {
    registro.innerHTML = '<li data-autor="aviso">Escreva a primeira mensagem como se fosse o cliente.</li>';
    return;
  }

  registro.innerHTML = conversaDeTesteDoAgente.map((item) => {
    const autor = item.autor === 'cliente' || item.autor === 'agente' ? item.autor : 'aviso';
    return `<li data-autor="${autor}">${escapar(item.texto)}</li>`;
  }).join('');
  registro.scrollTop = registro.scrollHeight;
}

async function salvarAgenteAberto(campos) {
  if (!agenteAberto) return false;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}`, { metodo: 'PUT', corpo: campos });
    await carregarAgentes();
    return true;
  } catch (erro) {
    informar(`Não foi possível salvar o agente: ${mensagemDeErroDoAgente(erro)}`);
    return false;
  }
}

seletor('#agente-novo')?.addEventListener('click', () => {
  seletor('#form-agente-novo').hidden = false;
  seletor('#agente-novo-nome').focus();
});

seletor('#agente-novo-cancelar')?.addEventListener('click', () => {
  const formulario = seletor('#form-agente-novo');
  formulario.reset();
  seletor('#agente-novo-slug').dataset.editado = '';
  formulario.hidden = true;
});

// O identificador sai do nome enquanto a pessoa não mexe nele à mão.
seletor('#agente-novo-nome')?.addEventListener('input', () => {
  const campoSlug = seletor('#agente-novo-slug');
  if (campoSlug.dataset.editado === 'sim') return;
  campoSlug.value = seletor('#agente-novo-nome').value
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
});
seletor('#agente-novo-slug')?.addEventListener('input', (evento) => { evento.target.dataset.editado = 'sim'; });

seletor('#form-agente-novo')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    const { agente } = await pedirJson('/api/agentes', {
      metodo: 'POST',
      corpo: { nome: seletor('#agente-novo-nome').value.trim(), slug: seletor('#agente-novo-slug').value.trim() },
    });
    evento.target.reset();
    seletor('#agente-novo-slug').dataset.editado = '';
    evento.target.hidden = true;
    await carregarAgentes();
    await abrirAgente(agente.id);
  } catch (erro) {
    informar(`Não foi possível criar o agente: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#lista-agentes')?.addEventListener('click', (evento) => {
  if (evento.target.closest('[data-abrir-serena]')) {
    abrirTela('serena');
    return;
  }
  const botao = evento.target.closest('[data-abrir-agente]');
  if (botao) abrirAgente(botao.dataset.abrirAgente);
});

// Delegação: os itens por agente do menu nascem depois do carregamento da
// página, então não podem depender do laço que registra os itens fixos.
seletor('#menu-agentes')?.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-abrir-agente-menu]');
  if (!botao) return;
  agenteAberto = null;
  abrirTela('agentes');
  abrirAgente(botao.dataset.abrirAgenteMenu);
});

// "Todos os agentes" é destino de navegação, não só o rótulo do grupo: com um
// agente aberto, ele fecha o editor e devolve a lista.
seletor('#item-agentes button')?.addEventListener('click', () => {
  agenteAberto = null;
  conversaDeTesteDoAgente = [];
  const editor = seletor('#agente-editor');
  if (editor) editor.hidden = true;
  destacarAgenteNoMenu(null);
});

seletor('#agente-fechar')?.addEventListener('click', () => {
  agenteAberto = null;
  conversaDeTesteDoAgente = [];
  seletor('#agente-editor').hidden = true;
  destacarAgenteNoMenu(null);
});

for (const aba of document.querySelectorAll('[data-aba-agente]')) {
  aba.addEventListener('click', () => {
    selecionarAbaDoAgente(aba.dataset.abaAgente);
    if (aba.dataset.abaAgente === 'equipe') carregarEquipeDoAgente();
  });
}

seletor('#agente-comportamento')?.addEventListener('input', atualizarContadorDoComportamento);

seletor('#agente-aba-perfil')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;

  // Pausar e retomar moram no Controle da automação, com confirmação própria:
  // salvar o comportamento nunca muda quem responde o cliente.
  const [provedor, modelo] = seletor('#agente-modelo').value.split('|');
  await salvarAgenteAberto({
    nome: seletor('#agente-nome').value,
    descricao: seletor('#agente-descricao').value,
    comunicacao: seletor('#agente-comunicacao').value,
    comportamento: seletor('#agente-comportamento').value,
    provedor: provedor || null,
    modelo: modelo || null,
  });
});

seletor('#agente-historico')?.addEventListener('click', async (evento) => {
  const botao = evento.target.closest('[data-restaurar-comportamento]');
  if (!botao || !agenteAberto) return;
  if (!window.confirm('Restaurar esta versão do comportamento? A versão atual continua no histórico.')) return;
  try {
    const agenteId = Number(agenteAberto.agente.id);
    await pedirJson(`/api/agentes/${agenteId}/comportamento/${Number(botao.dataset.restaurarComportamento)}/restaurar`, { metodo: 'POST' });
    await carregarAgentes();
  } catch (erro) {
    informar(`Não foi possível restaurar: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-aba-trabalho')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  await salvarAgenteAberto({
    finalidade: seletor('#agente-finalidade').value,
    empresa_nome: seletor('#agente-empresa-nome').value,
    empresa_site: seletor('#agente-empresa-site').value,
    empresa_descricao: seletor('#agente-empresa-descricao').value,
  });
});

seletor('#agente-treino-tipo')?.addEventListener('change', alternarCamposDeTreinamento);

seletor('#agente-aba-treinamentos')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;

  const tipo = seletor('#agente-treino-tipo').value;
  const titulo = seletor('#agente-treino-titulo').value.trim() || null;
  let corpo;
  if (tipo === 'website') {
    corpo = { tipo, titulo, url: seletor('#agente-treino-url').value.trim() };
  } else if (tipo === 'documento') {
    const arquivo = seletor('#agente-treino-arquivo').files?.[0];
    if (!arquivo) {
      informar('Escolha um arquivo .txt ou .md.');
      return;
    }
    const conteudo = (await arquivo.text()).trim();
    if (conteudo.length > LIMITE_TREINAMENTO_CARACTERES) {
      informar(`O arquivo tem ${conteudo.length} caracteres; o limite por treinamento é ${LIMITE_TREINAMENTO_CARACTERES}. Divida em partes.`);
      return;
    }
    corpo = { tipo, titulo: titulo || arquivo.name.slice(0, 200), conteudo, origem: arquivo.name.slice(0, 500) };
  } else {
    corpo = { tipo: 'texto', titulo, conteudo: seletor('#agente-treino-conteudo').value };
  }

  const botao = seletor('#agente-treino-cadastrar');
  botao.disabled = true;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/treinamentos`, { metodo: 'POST', corpo });
    evento.target.reset();
    alternarCamposDeTreinamento();
    await carregarAgentes();
  } catch (erro) {
    informar(`Não foi possível cadastrar o treinamento: ${mensagemDeErroDoAgente(erro)}`);
  } finally {
    botao.disabled = false;
  }
});

seletor('#agente-treinamentos')?.addEventListener('click', async (evento) => {
  const botao = evento.target.closest('[data-remover-treinamento]');
  if (!botao || !agenteAberto) return;
  if (!window.confirm('Remover este treinamento? O agente deixa de usar esse conhecimento.')) return;
  try {
    const agenteId = Number(agenteAberto.agente.id);
    await pedirJson(`/api/agentes/${agenteId}/treinamentos/${Number(botao.dataset.removerTreinamento)}`, { metodo: 'DELETE' });
    await carregarAgentes();
  } catch (erro) {
    informar(`Não foi possível remover o treinamento: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-aba-configuracoes')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const configuracoes = {};
  for (const chave of BOOLEANAS_DO_AGENTE) configuracoes[chave] = seletor(`#agente-cfg-${chave}`).checked;
  configuracoes.tempo_resposta_segundos = Number(seletor('#agente-cfg-tempo_resposta_segundos').value || 0);
  const limite = seletor('#agente-cfg-limite_interacoes').value.trim();
  configuracoes.limite_interacoes = limite === '' ? null : Number(limite);
  configuracoes.acao_limite = seletor('#agente-cfg-acao_limite').value;

  // Fuso e horário têm aba própria (Horário de atendimento); o servidor mescla
  // configurações parciais, então salvar aqui não apaga a grade.
  await salvarAgenteAberto({ configuracoes });
});

seletor('#agente-aba-horario')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const configuracoes = { fuso: seletor('#agente-cfg-fuso').value.trim() };
  const horario = seletor('#agente-cfg-horario').value.trim();
  if (horario) {
    try {
      configuracoes.horario = JSON.parse(horario);
    } catch {
      informar('O horário não é um JSON válido — confira aspas, vírgulas e colchetes.');
      return;
    }
  } else {
    configuracoes.horario = null;
  }

  await salvarAgenteAberto({ configuracoes });
});

seletor('#agente-inatividade-adicionar')?.addEventListener('click', () => {
  const atuais = lerLinhasDeInatividade();
  const usados = new Set(atuais.map((acao) => acao.apos_minutos));
  const livre = MINUTOS_DE_INATIVIDADE.map(([valor]) => valor).find((valor) => !usados.has(valor)) ?? 10080;
  desenharLinhasDeInatividade([...atuais, { apos_minutos: livre, acao: 'finalizar', instrucao: null }]);
});

seletor('#agente-inatividade-linhas')?.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-remover-inatividade]');
  if (!botao) return;
  const atuais = lerLinhasDeInatividade();
  atuais.splice(Number(botao.dataset.removerInatividade), 1);
  desenharLinhasDeInatividade(atuais);
});

seletor('#agente-aba-inatividade')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/inatividade`, {
      metodo: 'PUT', corpo: { acoes: lerLinhasDeInatividade() },
    });
    await carregarAgentes();
  } catch (erro) {
    informar(`Não foi possível salvar as ações de inatividade: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-canal-adicionar')?.addEventListener('click', () => {
  desenharLinhasDeCanais([...lerLinhasDeCanais(), { canal: 'whatsapp', instancia: '', ativo: true }]);
});

seletor('#agente-canais-linhas')?.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-remover-canal]');
  if (!botao) return;
  const atuais = lerLinhasDeCanais();
  atuais.splice(Number(botao.dataset.removerCanal), 1);
  desenharLinhasDeCanais(atuais);
});

seletor('#agente-aba-canais')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/canais`, {
      metodo: 'PUT', corpo: { canais: lerLinhasDeCanais() },
    });
    await carregarAgentes();
  } catch (erro) {
    informar(`Não foi possível salvar os canais: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-teste-form')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;

  const campo = seletor('#agente-teste-mensagem');
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = '';
  conversaDeTesteDoAgente.push({ autor: 'cliente', texto });
  desenharConversaDeTesteDoAgente();

  const botao = seletor('#agente-teste-enviar');
  botao.disabled = true;
  try {
    const mensagens = conversaDeTesteDoAgente.filter((item) => item.autor !== 'aviso').slice(-30);
    const resultado = await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/teste`, {
      metodo: 'POST', corpo: { mensagens },
    });
    const partes = resultado.partes ?? [];
    for (const parte of partes) conversaDeTesteDoAgente.push({ autor: 'agente', texto: parte });
    if (partes.length === 0) conversaDeTesteDoAgente.push({ autor: 'aviso', texto: 'O agente não gerou resposta.' });
    if (resultado.transferir) {
      conversaDeTesteDoAgente.push({
        autor: 'aviso',
        texto: `O agente pediu transferência para a equipe${resultado.motivo ? `: ${resultado.motivo}` : ''}.`,
      });
    }
  } catch (erro) {
    conversaDeTesteDoAgente.push({ autor: 'aviso', texto: `Falha no teste: ${mensagemDeErroDoAgente(erro)}` });
  } finally {
    botao.disabled = false;
    desenharConversaDeTesteDoAgente();
  }
});

seletor('#agente-teste-recomecar')?.addEventListener('click', () => {
  conversaDeTesteDoAgente = [];
  desenharConversaDeTesteDoAgente();
});

// --- Painel de operação do agente, no desenho da tela da Serena ---
//
// Estado (agente, WhatsApp, entrega, aguardando), quem espera a equipe, o
// WhatsApp do agente e o Controle da automação (Pausar/Retomar). Nada aqui
// mostra conteúdo de mensagem: a API do painel não devolve.

const ROTULO_WHATSAPP_DO_AGENTE = {
  conectado: ['Conectado', 'ok'],
  desconectado: ['Desconectado', 'ruim'],
  conectando: ['Conectando…', 'alerta'],
  inexistente: ['Instância não existe', 'ruim'],
  desconhecido: ['Estado desconhecido', 'alerta'],
  sem_canal: ['Sem canal', 'alerta'],
  nao_configurado: ['Evolution não configurada', 'alerta'],
  erro: ['Sem resposta da Evolution', 'ruim'],
};

const DESCRICAO_WHATSAPP_DO_AGENTE = {
  conectado: 'O celular do agente está vinculado. As respostas saem por ele.',
  desconectado: 'O celular não está vinculado: o agente não recebe nem envia. Conecte com o código ou o QR.',
  conectando: 'A Evolution está tentando conectar. Se demorar, gere um novo código.',
  inexistente: 'A instância não existe na Evolution — ela precisa ser criada no servidor.',
  sem_canal: 'O agente não tem canal de WhatsApp. Cadastre a instância na aba Canais.',
  nao_configurado: 'O servidor não tem a Evolution API configurada.',
  erro: 'Não foi possível consultar a Evolution agora. Tente Atualizar.',
};

const NUMEROS_DO_AGENTE = [
  ['conversas_novas', 'Conversas novas'],
  ['agente_respondida', 'Respostas do agente'],
  ['transferida_para_humano', 'Transferidas para a equipe'],
  ['agente_escalonada', 'Escalonadas por falha'],
  ['agente_automacao_silenciada', 'Recebidas sem resposta (pausado ou fora do horário)'],
  ['agente_resposta_nao_entregue', 'Falhas de entrega'],
];

function dataHoraDoPainelDoAgente(instante) {
  if (!instante) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  }).format(new Date(instante));
}

/** "desde 11/09 14:30, por Dra. Ana, motivo: almoço" — o que a Serena mostra ao lado do interruptor. */
function descreverMudancaDoAgente(alteracao) {
  if (!alteracao) return '';
  return [
    alteracao.em ? `desde ${dataHoraDoPainelDoAgente(alteracao.em)}` : null,
    alteracao.por ? `por ${alteracao.por}` : null,
    alteracao.motivo ? `motivo: ${alteracao.motivo}` : null,
  ].filter(Boolean).join(', ');
}

/**
 * Operação e WhatsApp saem juntos, mas cada um é desenhado quando chega (B2):
 * a Evolution lenta não pode segurar o Controle da automação. O contador fica
 * na própria função (declaração hoisted, sem depender da ordem do script).
 */
async function carregarOperacaoDoAgente() {
  if (!agenteAberto) return;
  const id = Number(agenteAberto.agente.id);
  carregarOperacaoDoAgente.pedido = (carregarOperacaoDoAgente.pedido || 0) + 1;
  const pedido = carregarOperacaoDoAgente.pedido;
  // Resposta de pedido velho não pinta nada: outro agente aberto (ou fechado),
  // ou um "Atualizar" mais novo já saiu.
  const vale = () => pedido === carregarOperacaoDoAgente.pedido
    && Boolean(agenteAberto) && Number(agenteAberto.agente.id) === id;

  const operacao = pedirJson(`/api/agentes/${id}/operacao`)
    .then((dados) => { if (vale()) desenharOperacaoDoAgente(dados); })
    .catch((erro) => { if (vale()) mostrarFalhaDaOperacaoDoAgente(erro); });
  const whatsapp = pedirJson(`/api/agentes/${id}/whatsapp`)
    .then((dados) => { if (vale()) desenharWhatsappDoAgente(dados); })
    .catch((erro) => { if (vale()) desenharWhatsappDoAgente({ estado: 'erro', erro: mensagemDeErroDoAgente(erro) }); });
  atualizarSeloDeAgentes();
  await Promise.all([operacao, whatsapp]);
}

function desabilitarControleDoAgente() {
  for (const alvo of ['#agente-pausar', '#agente-retomar', '#agente-pausa-motivo']) {
    const controle = seletor(alvo);
    if (controle) controle.disabled = true;
  }
}

/** Painel sem dado de agente nenhum: ao trocar de agente nada do anterior fica na tela nem clicável. */
function zerarOperacaoDoAgente() {
  for (const alvo of ['#agente-op-agente', '#agente-op-entrega', '#agente-op-aguardando']) {
    pintarEstado(alvo, 'verificando…', 'neutro');
  }
  for (const alvo of ['#agente-op-agente-detalhe', '#agente-op-entrega-detalhe', '#agente-op-aguardando-detalhe', '#agente-controle-estado']) {
    definirTexto(alvo, '—');
  }
  for (const alvo of ['#agente-aguardando', '#agente-conversas-recentes']) {
    const lista = seletor(alvo);
    if (lista) lista.innerHTML = '<li class="vazio">carregando…</li>';
  }
  const numeros = seletor('#agente-numeros');
  if (numeros) numeros.innerHTML = '<dd>—</dd>';
  desabilitarControleDoAgente();
}

function zerarWhatsappDoAgente() {
  pintarEstado('#agente-op-whatsapp', 'verificando…', 'neutro');
  definirTexto('#agente-op-whatsapp-detalhe', '—');
  definirTexto('#agente-whatsapp-descricao', 'verificando a conexão…');
  seletor('#agente-whatsapp-acoes').hidden = true;
  seletor('#agente-whatsapp-form').hidden = true;
  seletor('#agente-whatsapp-pareamento').hidden = true;
}

/** Sem operação não há Controle: erro visível e botões desabilitados, nunca estado velho. */
function mostrarFalhaDaOperacaoDoAgente(erro) {
  zerarOperacaoDoAgente();
  pintarEstado('#agente-op-agente', 'Indisponível', 'ruim');
  definirTexto('#agente-op-agente-detalhe', mensagemDeErroDoAgente(erro));
  definirTexto('#agente-controle-estado', 'Não foi possível carregar o estado do agente — o Controle fica desabilitado até Atualizar.');
  desabilitarControleDoAgente();
}

function desenharOperacaoDoAgente(operacao) {
  const { agente, status_alterado: alteracao, numeros, aguardando = [], conversas = [], pode_gerenciar: pode } = operacao;
  // Só a operação DO agente aberto reabilita o Controle (B2).
  for (const alvo of ['#agente-pausar', '#agente-retomar', '#agente-pausa-motivo']) seletor(alvo).disabled = false;
  const atendendo = agente.status === 'ativo';
  const rotulo = atendendo ? 'Atendendo' : agente.status === 'treinamento' ? 'Em treinamento' : 'Pausado';
  const quando = descreverMudancaDoAgente(alteracao);

  pintarEstado('#agente-op-agente', rotulo, atendendo ? 'ok' : 'alerta');
  definirTexto('#agente-op-agente-detalhe', quando || (atendendo ? 'respondendo clientes' : 'não responde clientes'));
  definirTexto('#agente-controle-estado', `${rotulo}${quando ? ` (${quando})` : ''}.`);

  seletor('#agente-controle-acoes').hidden = !pode;
  seletor('#agente-pausar').hidden = !atendendo;
  seletor('#agente-pausa-motivo').hidden = !atendendo;
  seletor('#agente-retomar').hidden = atendendo;

  const respondida = numeros?.por_acao?.agente_respondida;
  const falha = numeros?.por_acao?.agente_resposta_nao_entregue;
  const falhaMaisRecente = Boolean(falha?.ultima)
    && (!respondida?.ultima || new Date(falha.ultima) > new Date(respondida.ultima));
  if (falhaMaisRecente) pintarEstado('#agente-op-entrega', 'Falha na última entrega', 'ruim');
  else if (respondida?.ultima) pintarEstado('#agente-op-entrega', 'Entregando', 'ok');
  else pintarEstado('#agente-op-entrega', 'Sem respostas ainda', 'neutro');
  definirTexto('#agente-op-entrega-detalhe', [
    respondida?.ultima ? `última resposta ${haQuanto(respondida.ultima)}` : null,
    falha?.ultima ? `última falha ${haQuanto(falha.ultima)}` : null,
  ].filter(Boolean).join(' · ') || '—');

  // A lista vem com teto de 20: "20+" em vez de fingir que são exatamente 20.
  const esperando = aguardando.length >= 20 ? '20+' : String(aguardando.length);
  pintarEstado('#agente-op-aguardando', esperando, aguardando.length > 0 ? 'ruim' : 'ok');
  definirTexto('#agente-op-aguardando-detalhe', aguardando.length > 0
    ? 'cliente(s) pediram a equipe e estão sem responsável'
    : 'ninguém esperando a equipe');

  desenharConversasDoPainelDoAgente('#agente-aguardando', aguardando, 'Ninguém aguardando a equipe.');
  desenharConversasDoPainelDoAgente('#agente-conversas-recentes', conversas, 'Nenhuma conversa ainda.');
  desenharNumerosDoAgente(numeros);
}

function desenharConversasDoPainelDoAgente(alvo, conversas, vazio) {
  const lista = seletor(alvo);
  if (!lista) return;
  if (conversas.length === 0) {
    lista.innerHTML = `<li class="vazio">${escapar(vazio)}</li>`;
    return;
  }
  lista.innerHTML = conversas.map((conversa) => {
    const quem = conversa.contato_nome || conversa.contato_telefone || `Conversa ${Number(conversa.id)}`;
    const detalhe = [
      conversa.status,
      conversa.assumida_por_humano ? 'com a equipe' : null,
      conversa.responsavel_nome,
      conversa.ultima_msg_em ? haQuanto(conversa.ultima_msg_em) : 'sem mensagens',
    ].filter(Boolean).join(' · ');
    return `
    <li>
      <div>
        <strong>${escapar(quem)}</strong>
        <small>${escapar(detalhe)}</small>
      </div>
      <div class="linha-acoes">
        <button type="button" class="secundario" data-abrir-conversa-do-agente="${Number(conversa.id)}">Abrir conversa</button>
      </div>
    </li>`;
  }).join('');
}

function desenharNumerosDoAgente(numeros) {
  const lista = seletor('#agente-numeros');
  if (!lista) return;
  lista.innerHTML = NUMEROS_DO_AGENTE.map(([chave, rotulo]) => {
    const valor = chave === 'conversas_novas' ? numeros?.conversas_novas : numeros?.por_acao?.[chave];
    return `<dt>${escapar(rotulo)}</dt><dd>${Number(valor?.hoje ?? 0)} hoje · ${Number(valor?.semana ?? 0)} em 7 dias</dd>`;
  }).join('');
}

function desenharWhatsappDoAgente(estado) {
  const [rotulo, tom] = ROTULO_WHATSAPP_DO_AGENTE[estado?.estado] ?? ['Estado desconhecido', 'alerta'];
  pintarEstado('#agente-op-whatsapp', rotulo, tom);
  definirTexto('#agente-op-whatsapp-detalhe', [
    estado?.instancia ? `instância ${estado.instancia}` : null,
    estado?.numero ? `+${estado.numero}` : null,
    estado?.perfil,
    estado?.instancia && estado?.canal_ativo === false ? 'canal desligado na aba Canais' : null,
    estado?.erro,
  ].filter(Boolean).join(' · ') || '—');
  definirTexto('#agente-whatsapp-descricao', DESCRICAO_WHATSAPP_DO_AGENTE[estado?.estado] ?? 'Estado desconhecido.');

  const podeConectar = Boolean(agenteAberto?.pode_gerenciar)
    && ['desconectado', 'conectando', 'desconhecido'].includes(estado?.estado);
  seletor('#agente-whatsapp-acoes').hidden = !podeConectar;
  if (estado?.estado === 'conectado') {
    seletor('#agente-whatsapp-form').hidden = true;
    seletor('#agente-whatsapp-pareamento').hidden = true;
  }
}

function desenharPareamentoDoAgente(resultado) {
  const caixa = seletor('#agente-whatsapp-pareamento');
  if (resultado.ja_conectado) {
    caixa.hidden = true;
    informar('O WhatsApp do agente já está conectado.');
    carregarOperacaoDoAgente();
    return;
  }
  // O servidor já filtra; conferir de novo aqui custa nada e o valor vai para um img.src.
  const qrValido = typeof resultado.qr === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(resultado.qr);
  // B6: sem código e sem QR não há o que "usar abaixo" — diz que está
  // indisponível e aponta o caminho alternativo (manager da Evolution).
  const temCaminho = Boolean(resultado.codigo_pareamento) || qrValido;
  definirTexto('#agente-whatsapp-codigo', resultado.codigo_pareamento || (qrValido ? 'use o QR abaixo' : 'indisponível'));
  seletor('#agente-whatsapp-instrucao').hidden = !resultado.codigo_pareamento;
  seletor('#agente-whatsapp-sem-codigo').hidden = temCaminho;
  const qr = seletor('#agente-whatsapp-qr');
  if (qrValido) {
    qr.src = resultado.qr;
    qr.hidden = false;
  } else {
    qr.removeAttribute('src');
    qr.hidden = true;
  }
  caixa.hidden = false;
}

/** Abre a conversa na tela Conversas, na fila "Todos" e sem filtro que a esconda. */
async function abrirConversaDoAgente(conversaId) {
  filaAtual = 'todos';
  for (const aba of document.querySelectorAll('.aba[data-fila]')) {
    const ativa = aba.dataset.fila === 'todos';
    aba.classList.toggle('selecionada', ativa);
    aba.setAttribute('aria-selected', String(ativa));
  }
  // Abre na aba do próprio agente (migration 047), que é onde a conversa está.
  if (agenteAberto) escopoDaListaDeConversas = String(Number(agenteAberto.agente.id));
  desenharAbasDeEscopoDasConversas();
  abrirTela('conversas');
  await abrirConversa(conversaId);
}

/** Selo do menu Agentes: quantos clientes de agente aguardam a equipe. */
async function atualizarSeloDeAgentes() {
  const selo = seletor('#contador-agentes');
  if (!selo || !podeFazer('agentes:ler')) return;
  try {
    const dados = await pedirJson('/api/agentes/aguardando');
    const total = Number(dados.total) || 0;
    selo.textContent = String(total);
    selo.hidden = total === 0;
    // O numero sozinho nao diz nada a quem ouve a tela: o rotulo invisivel vai junto.
    const rotulo = seletor('#contador-agentes-rotulo');
    if (rotulo) {
      rotulo.textContent = total === 1
        ? ' cliente de agente aguardando a equipe'
        : ' clientes de agentes aguardando a equipe';
      rotulo.hidden = total === 0;
    }
  } catch {
    selo.hidden = true;
    const rotulo = seletor('#contador-agentes-rotulo');
    if (rotulo) rotulo.hidden = true;
  }
}

// Declarada como função (e não `let`) de propósito: é chamada quando a sessão
// abre, e o intervalo fica guardado nela mesma, sem depender da ordem do script.
function iniciarSeloDeAgentes() {
  if (!podeFazer('agentes:ler')) return;
  atualizarSeloDeAgentes();
  if (!iniciarSeloDeAgentes.intervalo) iniciarSeloDeAgentes.intervalo = setInterval(atualizarSeloDeAgentes, 60000);
}

seletor('#agente-op-atualizar')?.addEventListener('click', () => carregarOperacaoDoAgente());

// ---------------------------------------------------------------------------
// Equipe do agente (migration 047): quem vê e responde as conversas dele.
// ---------------------------------------------------------------------------

async function carregarEquipeDoAgente() {
  if (!agenteAberto) return;
  const id = Number(agenteAberto.agente.id);
  const lista = seletor('#agente-equipe-lista');
  const formulario = seletor('#agente-equipe-form');
  if (!lista) return;
  // Resposta de outro agente (troca no meio da espera) é descartada — lição do BN1.
  const aindaEste = () => agenteAberto && Number(agenteAberto.agente.id) === id;
  lista.innerHTML = '<li class="vazio">carregando…</li>';
  if (formulario) formulario.hidden = true;
  try {
    const dados = await pedirJson(`/api/agentes/${id}/equipe`);
    if (!aindaEste()) return;
    desenharEquipeDoAgente(dados);
    if (dados.pode_gerenciar) await preencherCandidatosDaEquipe(dados.membros ?? []);
    if (!aindaEste()) return;
    if (formulario) formulario.hidden = !dados.pode_gerenciar;
  } catch (erro) {
    if (!aindaEste()) return;
    lista.innerHTML = `<li class="vazio">${escapar(`Não foi possível carregar a equipe: ${mensagemDeErroDoAgente(erro)}`)}</li>`;
  }
}

function desenharEquipeDoAgente({ membros = [], pode_gerenciar: pode = false } = {}) {
  const lista = seletor('#agente-equipe-lista');
  if (!lista) return;

  // A luz da aba Equipe é acesa aqui, e não junto das outras: a equipe vem de
  // /api/agentes/:id/equipe, que é uma requisição separada da do agente. Sem
  // equipe ninguém recebe o resumo nem vê as conversas dele.
  acenderLuzDoAgente('equipe', membros.length > 0 ? 'ok' : 'parado');
  if (membros.length === 0) {
    lista.innerHTML = '<li class="vazio">Ninguém na equipe ainda: só o administrador vê as conversas deste agente, e ninguém recebe o resumo dele.</li>';
    return;
  }
  lista.innerHTML = membros.map((membro) => `
    <li>
      <div>
        <strong>${escapar(membro.nome ?? membro.email ?? 'sem nome')}</strong>
        <small>${escapar(ROTULOS_DE_PAPEL[membro.papel] ?? membro.papel)} · ${escapar(membro.acesso_clinica ? 'vê a clínica' : 'Colaborador (só agentes)')}</small>
      </div>
      ${pode ? `<div class="linha-acoes"><button type="button" class="perigo" data-remover-membro="${Number(membro.usuario_id)}">Tirar da equipe</button></div>` : ''}
    </li>`).join('');
}

/**
 * Quem pode entrar: conta ativa e fora da equipe — admin inclusive. O admin vê as
 * conversas de todo agente sem estar na equipe, mas o RESUMO do agente só vai
 * para a equipe dele (docs/RESUMOS.md). Produção, 11/09: todas as contas eram
 * admin e a lista vinha vazia, então ninguém recebia o resumo do Alpins.
 */
async function preencherCandidatosDaEquipe(membros) {
  const campo = seletor('#agente-equipe-usuario');
  if (!campo) return;
  let usuarios = [];
  try {
    usuarios = (await pedirJson('/api/usuarios')).usuarios ?? [];
  } catch {
    usuarios = [];
  }
  const naEquipe = new Set(membros.map((membro) => Number(membro.usuario_id)));
  const candidatos = usuarios.filter((usuario) => usuario.situacao === 'ativo' && !naEquipe.has(Number(usuario.id)));
  campo.innerHTML = candidatos.length
    ? candidatos.map((usuario) => `<option value="${Number(usuario.id)}">${escapar(usuario.nome)} — ${escapar(ROTULOS_DE_PAPEL[usuario.papel] ?? usuario.papel)}${usuario.acesso_clinica === false ? ' · colaborador' : ''}${usuario.papel === 'admin' ? ' · já vê tudo; entra para receber o resumo' : ''}</option>`).join('')
    : '<option value="" disabled selected>Todas as contas ativas já estão na equipe</option>';
}

seletor('#agente-equipe-form')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;
  const id = Number(agenteAberto.agente.id);
  const usuarioId = Number(seletor('#agente-equipe-usuario')?.value);
  if (!usuarioId) return;
  try {
    await pedirJson(`/api/agentes/${id}/equipe`, { metodo: 'POST', corpo: { usuario_id: usuarioId } });
    if (agenteAberto && Number(agenteAberto.agente.id) === id) await carregarEquipeDoAgente();
  } catch (erro) {
    informar(`Não foi possível colocar na equipe: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-equipe-lista')?.addEventListener('click', async (evento) => {
  const botao = evento.target.closest('[data-remover-membro]');
  if (!botao || !agenteAberto) return;
  const id = Number(agenteAberto.agente.id);
  if (!window.confirm('Tirar esta pessoa da equipe? Ela deixa de ver as conversas deste agente na hora.')) return;
  try {
    await pedirJson(`/api/agentes/${id}/equipe/${Number(botao.dataset.removerMembro)}`, { metodo: 'DELETE' });
    if (agenteAberto && Number(agenteAberto.agente.id) === id) await carregarEquipeDoAgente();
  } catch (erro) {
    informar(`Não foi possível tirar da equipe: ${mensagemDeErroDoAgente(erro)}`);
  }
});

for (const alvo of ['#agente-aguardando', '#agente-conversas-recentes']) {
  seletor(alvo)?.addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-abrir-conversa-do-agente]');
    if (botao) abrirConversaDoAgente(Number(botao.dataset.abrirConversaDoAgente));
  });
}

seletor('#agente-pausar')?.addEventListener('click', async () => {
  if (!agenteAberto) return;
  if (!window.confirm('Pausar o agente? Ele para de responder clientes até alguém retomar. As mensagens continuam sendo gravadas.')) return;
  const botao = seletor('#agente-pausar');
  botao.disabled = true;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/pausar`, {
      metodo: 'POST', corpo: { motivo: seletor('#agente-pausa-motivo').value.trim() || null },
    });
    seletor('#agente-pausa-motivo').value = '';
    // No sucesso quem reabilita é a operação nova do agente (B2).
    await carregarAgentes();
  } catch (erro) {
    botao.disabled = false;
    informar(`Não foi possível pausar o agente: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-retomar')?.addEventListener('click', async () => {
  if (!agenteAberto) return;
  const confirmou = window.confirm('Retomar o agente faz ele responder clientes de verdade pelo WhatsApp dele.\n\n'
    + 'ANTES: o atendimento desse número no GPTMaker (ou em qualquer outra plataforma) está DESLIGADO? '
    + 'Com os dois ligados, o cliente recebe resposta dupla.\n\n'
    + 'As respostas já foram conferidas em "Testar o agente"? Confirmar?');
  if (!confirmou) return;
  const botao = seletor('#agente-retomar');
  botao.disabled = true;
  try {
    await pedirJson(`/api/agentes/${Number(agenteAberto.agente.id)}/retomar`, { metodo: 'POST' });
    // No sucesso quem reabilita é a operação nova do agente (B2).
    await carregarAgentes();
  } catch (erro) {
    botao.disabled = false;
    informar(`Não foi possível retomar o agente: ${mensagemDeErroDoAgente(erro)}`);
  }
});

seletor('#agente-whatsapp-conectar')?.addEventListener('click', () => {
  seletor('#agente-whatsapp-form').hidden = false;
  seletor('#agente-whatsapp-numero').focus();
});

seletor('#agente-whatsapp-cancelar')?.addEventListener('click', () => {
  seletor('#agente-whatsapp-form').hidden = true;
});

seletor('#agente-whatsapp-form')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (!agenteAberto) return;
  const botao = seletor('#agente-whatsapp-gerar');
  botao.disabled = true;
  // BN1: guarda de quem é o pedido. Trocar de agente durante a espera (até 5 s)
  // desenharia o código da instância de um agente no painel de outro — e a
  // pessoa parearia o celular errado.
  const id = Number(agenteAberto.agente.id);
  try {
    const numero = seletor('#agente-whatsapp-numero').value.trim();
    const resultado = await pedirJson(`/api/agentes/${id}/whatsapp/conectar`, {
      metodo: 'POST', corpo: numero ? { numero } : {},
    });
    if (!agenteAberto || Number(agenteAberto.agente.id) !== id) return;
    desenharPareamentoDoAgente(resultado);
    // A pessoa digita o código no celular: confere o estado de novo daqui a pouco.
    setTimeout(() => carregarOperacaoDoAgente(), 30000);
  } catch (erro) {
    informar(`Não foi possível gerar o código: ${mensagemDeErroDoAgente(erro)}`);
  } finally {
    botao.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Contatos: a base de pacientes. Excluir é soft delete — o histórico fica.
// ---------------------------------------------------------------------------

let contatoEmEdicao = null;

/** Selos automáticos de origem (decisão 11/09): "Clínica" e o nome de cada agente. */
function selosDoContatoEmHtml(selos) {
  if (!selos) return '';
  const itens = [
    ...(selos.clinica ? [{ rotulo: 'Clínica', agente: false }] : []),
    ...(selos.agentes ?? []).map((agente) => ({ rotulo: agente.nome ?? `agente #${Number(agente.id)}`, agente: true })),
  ];
  return itens.map((item) => `<span class="etiqueta${item.agente ? ' agente' : ''}">${escapar(item.rotulo)}</span>`).join(' ');
}

/** Filtro de origem: "Clínica" só para quem a vê; agentes vêm da própria resposta. */
function prepararFiltroDeOrigemDosContatos(agentes) {
  const campo = seletor('#contatos-origem');
  if (!campo) return;
  const escolhido = campo.value;
  const opcoes = [
    ['', 'Todas as origens'],
    ...(veClinica() ? [['clinica', 'Clínica']] : []),
    ...agentes.map((agente) => [String(Number(agente.id)), agente.nome]),
  ];
  campo.textContent = '';
  for (const [valor, rotulo] of opcoes) {
    const opcao = document.createElement('option');
    opcao.value = valor;
    opcao.textContent = rotulo;
    opcao.selected = valor === escolhido;
    campo.append(opcao);
  }
}

seletor('#contatos-origem')?.addEventListener('change', () => carregarContatos());

async function carregarContatos() {
  const busca = seletor('#contatos-busca')?.value ?? '';
  const excluidos = seletor('#contatos-excluidos')?.checked ? 'sim' : 'nao';
  const origem = seletor('#contatos-origem')?.value ?? '';

  try {
    const dados = await pedirJson(`/api/contatos/gestao?busca=${encodeURIComponent(busca)}&excluidos=${excluidos}${origem ? `&origem=${encodeURIComponent(origem)}` : ''}`);
    prepararFiltroDeOrigemDosContatos(dados.agentes ?? []);
    const lista = seletor('#lista-contatos');
    const total = seletor('#contatos-total');

    if (total) total.textContent = `${dados.total} contato(s)`;
    if (!lista) return;

    // A coluna de agendamentos só existe para quem vê a clínica: a API não
    // manda o campo para os demais (lista branca, achado M1), e uma coluna
    // vazia diria "nenhum agendamento" onde o certo é "você não vê isso".
    //
    // Quem decide é a RESPOSTA, não `veClinica()`. As duas concordam no caminho
    // normal, mas podem divergir: se /api/conversas/escopo falha, o fallback
    // assume clínica (app.js, prepararEscopoDaSessao) — aí a coluna apareceria
    // e as linhas viriam com uma célula a menos, torcendo a tabela inteira.
    const temAgendamentos = dados.contatos.some((contato) => contato.agendamentos !== undefined);
    const colunaAgendamentos = seletor('#coluna-agendamentos');
    if (colunaAgendamentos) colunaAgendamentos.hidden = !temAgendamentos;
    const colunas = temAgendamentos ? 5 : 4;

    if (dados.contatos.length === 0) {
      lista.innerHTML = `<tr><td colspan="${colunas}" class="vazio">Nenhum contato encontrado.</td></tr>`;
      return;
    }

    lista.innerHTML = dados.contatos.map((contato) => `
      <tr class="${contato.excluido ? 'desligada' : ''}">
        <td>
          <strong>${escapar(contato.nome ?? 'sem nome')}</strong> ${selosDoContatoEmHtml(contato.selos)}
          ${contato.recebe_lembretes === false ? '<small>não recebe lembretes</small>' : ''}
          ${contato.excluido ? `<small>excluído em ${new Date(contato.excluido_em).toLocaleDateString('pt-BR')}</small>` : ''}
        </td>
        <td class="telefone" data-rotulo="Telefone">${escapar(contato.telefone)}</td>
        <td class="numero" data-rotulo="Conversas">${contato.conversas ?? 0}</td>
        ${contato.agendamentos !== undefined ? `<td class="numero" data-rotulo="Agendamentos" data-agendamentos>${Number(contato.agendamentos) || 0}</td>` : ''}
        <td class="celula-acoes">
          ${contato.excluido
            ? `<button type="button" class="secundario" data-restaurar-contato="${contato.id}">Restaurar</button>`
            : `<button type="button" class="secundario" data-ver-contato="${contato.id}">Histórico</button>
               ${veClinica() ? `<button type="button" class="secundario" data-editar-contato="${contato.id}">Editar</button>
               <button type="button" class="perigo" data-excluir-contato="${contato.id}">Excluir</button>` : ''}`}
        </td>
      </tr>`).join('');
  } catch (erro) {
    informar(`Não foi possível carregar os contatos: ${erro.message}`);
  }
}

function abrirEditorDeContato(contato = null) {
  contatoEmEdicao = contato;
  const editor = seletor('#contato-editor');
  if (!editor) return;

  editor.hidden = false;
  seletor('#contato-editor-titulo').textContent = contato ? 'Editar contato' : 'Novo contato';
  seletor('#contato-nome').value = contato?.nome ?? '';
  seletor('#contato-telefone').value = contato?.telefone ?? '';
  seletor('#contato-email').value = contato?.email ?? '';
  seletor('#contato-observacoes').value = contato?.observacoes ?? '';
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function verHistoricoDoContato(id) {
  try {
    const dados = await pedirJson(`/api/contatos/${id}`);
    const { contato, historico } = dados;
    const origens = [
      ...(contato.selos?.clinica ? ['Clínica'] : []),
      ...(contato.selos?.agentes ?? []).map((agente) => agente.nome ?? `agente #${agente.id}`),
    ];
    // Só as conversas que a pessoa vê chegam aqui (o servidor recorta a prévia).
    const linhas = [
      `${contato.nome ?? 'sem nome'} — ${contato.telefone}`,
      ...(origens.length ? [`Origem: ${origens.join(', ')}`] : []),
      '',
      `Conversas: ${historico.conversas.length}`,
      ...historico.conversas.slice(0, 5).map((c) => `  · ${c.agente_nome ?? 'Clínica'} · ${c.status} — ${c.previa ?? 'sem mensagem'}`),
      ...(veClinica() ? [
        '',
        `Agendamentos: ${historico.agendamentos.length}`,
        ...historico.agendamentos.slice(0, 5).map((a) => `  · ${new Date(a.inicio).toLocaleString('pt-BR')} — ${a.status}`),
      ] : []),
    ];
    alert(linhas.join('\n'));
  } catch (erro) {
    informar(`Não foi possível abrir o histórico: ${erro.message}`);
  }
}

// ---------------------------------------------------------------------------
// Bloqueio de contato: telefones desviados do atendimento automático.
// ---------------------------------------------------------------------------

let bloqueioEmEdicao = null;

async function carregarBloqueios() {
  try {
    const dados = await pedirJson('/api/bloqueios');
    const lista = seletor('#lista-bloqueios');
    const total = seletor('#bloqueios-total');

    if (total) total.textContent = `${dados.total} bloqueio(s)`;
    if (!lista) return;

    if (dados.bloqueios.length === 0) {
      lista.innerHTML = '<li class="vazio">Nenhum bloqueio cadastrado.</li>';
      return;
    }

    lista.innerHTML = dados.bloqueios.map((bloqueio) => `
      <li>
        <div>
          <strong>${escapar(bloqueio.nome ?? 'sem nome')}</strong>
          <small>${escapar(bloqueio.telefone)} — ${escapar(bloqueio.motivo ?? '')}</small>
        </div>
        <div class="linha-acoes">
          <button type="button" class="secundario" data-editar-bloqueio="${bloqueio.id}">Editar</button>
          <button type="button" class="perigo" data-remover-bloqueio="${bloqueio.id}">Remover</button>
        </div>
      </li>`).join('');
  } catch (erro) {
    informar(`Não foi possível carregar os bloqueios: ${erro.message}`);
  }
}

function abrirEditorDeBloqueio(bloqueio = null) {
  bloqueioEmEdicao = bloqueio;
  const editor = seletor('#bloqueio-editor');
  if (!editor) return;

  editor.hidden = false;
  seletor('#bloqueio-editor-titulo').textContent = bloqueio ? 'Editar bloqueio' : 'Novo bloqueio';
  seletor('#bloqueio-nome').value = bloqueio?.nome ?? '';
  seletor('#bloqueio-telefone').value = bloqueio?.telefone ?? '';
  seletor('#bloqueio-motivo').value = bloqueio?.motivo ?? '';
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------- eventos

document.addEventListener('click', async (evento) => {
  const alvo = evento.target.closest('button');
  if (!alvo) return;

  try {
    if (alvo.id === 'serena-ligar') await alternarSerena(true, alvo);
    if (alvo.id === 'serena-desligar') await alternarSerena(false, alvo);
    if (alvo.id === 'serena-novo-prompt') abrirEditorDePrompt(null);
    if (alvo.id === 'serena-cancelar-editor') seletor('#serena-editor').hidden = true;
    if (alvo.id === 'serena-nova-regra') abrirEditorDeRegra(null);
    if (alvo.id === 'serena-cancelar-regra') seletor('#form-regra').hidden = true;

    if (alvo.dataset.publicarPrompt) {
      await pedirJson(`/api/serena/prompts/${alvo.dataset.publicarPrompt}/publicar`, { metodo: 'POST' });
      informar('Versão publicada.');
      await carregarSerena();
    }
    if (alvo.dataset.editarPrompt) {
      const versoes = await pedirJson('/api/serena/prompts');
      const alvoPrompt = (versoes.versoes ?? []).find((v) => String(v.id) === alvo.dataset.editarPrompt);
      abrirEditorDePrompt(alvoPrompt ?? null);
    }
    if (alvo.dataset.regraAtiva) {
      await pedirJson(`/api/serena/regras/${alvo.dataset.regraAtiva}/ativa`, { metodo: 'POST', corpo: { ativa: alvo.dataset.valor === 'true' } });
      await carregarSerena();
    }
    if (alvo.dataset.editarRegra) {
      const regra = (serenaPainel?.regras ?? []).find((r) => String(r.id) === alvo.dataset.editarRegra);
      abrirEditorDeRegra(regra ?? null);
    }
    if (alvo.dataset.removerRegra) {
      if (!confirm('Apagar esta regra? O conteúdo fica registrado na auditoria.')) return;
      await pedirJson(`/api/serena/regras/${alvo.dataset.removerRegra}`, { metodo: 'DELETE' });
      informar('Regra apagada.');
      await carregarSerena();
    }

    if (alvo.id === 'instagram-nova-regra') abrirEditorDeGatilho(null);
    if (alvo.id === 'instagram-cancelar-regra') seletor('#form-gatilho').hidden = true;
    if (alvo.dataset.gatilhoAtivo) {
      await pedirJson(`/api/instagram/regras/${alvo.dataset.gatilhoAtivo}/ativa`, { metodo: 'POST', corpo: { ativa: alvo.dataset.valor === 'true' } });
      await carregarInstagram();
    }
    if (alvo.dataset.editarGatilho) {
      const gatilho = (instagramPainel?.regras ?? []).find((r) => String(r.id) === alvo.dataset.editarGatilho);
      abrirEditorDeGatilho(gatilho ?? null);
    }
    if (alvo.dataset.removerGatilho) {
      if (!confirm('Apagar esta regra de gatilho?')) return;
      await pedirJson(`/api/instagram/regras/${alvo.dataset.removerGatilho}`, { metodo: 'DELETE' });
      informar('Regra apagada.');
      await carregarInstagram();
    }

    if (alvo.id === 'contato-novo') abrirEditorDeContato(null);
    if (alvo.id === 'contato-cancelar') seletor('#contato-editor').hidden = true;
    if (alvo.dataset.verContato) await verHistoricoDoContato(alvo.dataset.verContato);
    if (alvo.dataset.editarContato) {
      const dados = await pedirJson(`/api/contatos/${alvo.dataset.editarContato}`);
      abrirEditorDeContato(dados.contato);
    }
    if (alvo.dataset.excluirContato) {
      const motivo = prompt('Motivo da exclusão (opcional):') ?? null;
      if (!confirm('Excluir este contato? O histórico é preservado e a exclusão pode ser desfeita.')) return;
      await pedirJson(`/api/contatos/${alvo.dataset.excluirContato}`, { metodo: 'DELETE', corpo: { motivo } });
      informar('Contato excluído. O histórico foi preservado.');
      await carregarContatos();
    }
    if (alvo.dataset.restaurarContato) {
      await pedirJson(`/api/contatos/${alvo.dataset.restaurarContato}/restaurar`, { metodo: 'POST' });
      informar('Contato restaurado.');
      await carregarContatos();
    }

    if (alvo.id === 'bloqueio-novo') abrirEditorDeBloqueio(null);
    if (alvo.id === 'bloqueio-cancelar') seletor('#bloqueio-editor').hidden = true;
    if (alvo.dataset.editarBloqueio) {
      const dados = await pedirJson('/api/bloqueios');
      const alvoBloqueio = (dados.bloqueios ?? []).find((b) => String(b.id) === alvo.dataset.editarBloqueio);
      abrirEditorDeBloqueio(alvoBloqueio ?? null);
    }
    if (alvo.dataset.removerBloqueio) {
      if (!confirm('Remover este bloqueio? O contato volta a receber resposta automática normal.')) return;
      await pedirJson(`/api/bloqueios/${alvo.dataset.removerBloqueio}`, { metodo: 'DELETE' });
      informar('Bloqueio removido.');
      await carregarBloqueios();
    }
  } catch (erro) {
    informar(erro.message);
  }
});

document.addEventListener('submit', async (evento) => {
  const form = evento.target;

  if (form.id === 'form-prompt') {
    evento.preventDefault();
    const corpo = {
      titulo: seletor('#prompt-titulo').value,
      conteudo: seletor('#prompt-conteudo').value,
    };
    try {
      if (promptEmEdicao) {
        await pedirJson(`/api/serena/prompts/${promptEmEdicao.id}`, {
          metodo: 'PUT', corpo: corpo,
        });
      } else {
        await pedirJson('/api/serena/prompts', {
          metodo: 'POST', corpo: corpo,
        });
      }
      seletor('#serena-editor').hidden = true;
      informar('Rascunho salvo. Publique quando quiser colocá-lo no ar.');
      await carregarSerena();
    } catch (erro) {
      informar(erro.message);
    }
    return;
  }

  if (form.id === 'form-regra') {
    evento.preventDefault();
    const corpo = {
      nome: seletor('#regra-nome').value,
      categoria: seletor('#regra-categoria').value,
      ordem: Number(seletor('#regra-ordem').value),
      conteudo: seletor('#regra-conteudo').value,
    };
    try {
      if (regraEmEdicao) {
        await pedirJson(`/api/serena/regras/${regraEmEdicao.id}`, {
          metodo: 'PUT', corpo: corpo,
        });
      } else {
        await pedirJson('/api/serena/regras', {
          metodo: 'POST', corpo: corpo,
        });
      }
      form.hidden = true;
      await carregarSerena();
    } catch (erro) {
      informar(erro.message);
    }
    return;
  }

  if (form.id === 'form-gatilho') {
    evento.preventDefault();
    const corpo = {
      nome: seletor('#gatilho-nome').value,
      palavra_gatilho: seletor('#gatilho-palavra').value,
      mensagem_publica: seletor('#gatilho-mensagem-publica').value,
      mensagem_dm: seletor('#gatilho-mensagem-dm').value,
      cta_whatsapp: seletor('#gatilho-cta-whatsapp').checked,
      // Vazio = clínica. O campo só existe quando há mais de um perfil.
      agente_id: seletor('#gatilho-perfil')?.value ? Number(seletor('#gatilho-perfil').value) : null,
    };
    try {
      if (gatilhoEmEdicao) {
        await pedirJson(`/api/instagram/regras/${gatilhoEmEdicao.id}`, {
          metodo: 'PUT', corpo: corpo,
        });
      } else {
        await pedirJson('/api/instagram/regras', {
          metodo: 'POST', corpo: corpo,
        });
      }
      form.hidden = true;
      await carregarInstagram();
    } catch (erro) {
      informar(erro.message);
    }
    return;
  }

  if (form.id === 'form-contato') {
    evento.preventDefault();
    const corpo = {
      nome: seletor('#contato-nome').value,
      telefone: seletor('#contato-telefone').value,
      email: seletor('#contato-email').value || null,
      observacoes: seletor('#contato-observacoes').value || null,
    };
    try {
      if (contatoEmEdicao) {
        await pedirJson(`/api/contatos/${contatoEmEdicao.id}`, {
          metodo: 'PUT', corpo: corpo,
        });
      } else {
        await pedirJson('/api/contatos', {
          metodo: 'POST', corpo: corpo,
        });
      }
      seletor('#contato-editor').hidden = true;
      informar('Contato salvo.');
      await carregarContatos();
    } catch (erro) {
      informar(erro.message);
    }
  }

  if (form.id === 'form-bloqueio') {
    evento.preventDefault();
    const corpo = {
      nome: seletor('#bloqueio-nome').value,
      telefone: seletor('#bloqueio-telefone').value,
      motivo: seletor('#bloqueio-motivo').value,
    };
    try {
      if (bloqueioEmEdicao) {
        await pedirJson(`/api/bloqueios/${bloqueioEmEdicao.id}`, { metodo: 'PUT', corpo: corpo });
      } else {
        await pedirJson('/api/bloqueios', { metodo: 'POST', corpo: corpo });
      }
      seletor('#bloqueio-editor').hidden = true;
      informar('Bloqueio salvo.');
      await carregarBloqueios();
    } catch (erro) {
      informar(erro.message);
    }
  }
});

for (const alvo of ['#contatos-busca', '#contatos-excluidos']) {
  const campo = seletor(alvo);
  if (campo) campo.addEventListener('change', () => carregarContatos());
}


// ---------------------------------------------------------------------------
// Horário de atendimento, pausa e plantão.
//
// A tela nunca recalcula "a Serena está atendendo?". Esse campo vem pronto do
// servidor (`horario.atendendo`), porque reimplementar aqui a precedência entre
// interruptor, pausa, plantão e grade é como as duas versões passam a discordar
// — e a que o usuário lê é a errada.
// ---------------------------------------------------------------------------

const DIAS_DA_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const FUSO_DA_CLINICA = 'America/Sao_Paulo';

function desenharHorario(horario) {
  const resumo = seletor('#horario-resumo');
  if (resumo) resumo.textContent = frasePara(horario);

  const despausar = seletor('#serena-despausar');
  const pausar = seletor('#serena-pausar');
  if (despausar) despausar.hidden = !horario?.pausada;
  if (pausar) pausar.hidden = Boolean(horario?.pausada);

  const marcador = seletor('#horario-ativo');
  if (marcador) marcador.checked = horario?.agenda?.ativa === true;

  desenharGradeDeHorario(horario?.agenda ?? null);
}

/** A frase do topo. É o que a equipe lê antes de decidir se precisa agir. */
function frasePara(horario) {
  if (!horario) return '—';

  const ate = (instante) => new Date(instante).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  if (horario.pausada) return `pausada até ${ate(horario.pausada_ate)} — não responde ninguém`;
  if (!horario.atendendo && !horario.dentro_do_horario) return 'fora do horário — não responde agora';
  if (!horario.atendendo) return 'não está atendendo';
  if (horario.em_plantao) return `atendendo em plantão até ${ate(horario.ligada_ate)}`;
  return horario.agenda?.ativa ? 'atendendo, dentro do horário' : 'atendendo — sem limite de horário';
}

/**
 * Uma linha editável para um intervalo: início, fim e o botão de remover.
 * Cada linha carrega o dia no dataset — é assim que `lerGradeDaTela` sabe a
 * quem ela pertence sem depender da ordem no DOM.
 */
function desenharJanelaDaGrade(dia, inicio = '', fim = '') {
  const linha = criarElemento('div', { classe: 'horario-janela' });
  linha.dataset.dia = String(dia);

  for (const [classe, valor] of [['inicio', inicio], ['fim', fim]]) {
    const campo = document.createElement('input');
    campo.type = 'time';
    campo.className = `horario-${classe}`;
    campo.dataset.dia = String(dia);
    campo.value = valor;
    linha.append(campo);
  }

  const remover = document.createElement('button');
  remover.type = 'button';
  remover.className = 'acao horario-remover';
  remover.textContent = '×';
  remover.dataset.dia = String(dia);
  remover.setAttribute('aria-label', `Remover este intervalo (${DIAS_DA_SEMANA[dia]})`);
  linha.append(remover);

  return linha;
}

/**
 * O bloco de um dia inteiro: nome, uma linha por intervalo (TODOS — nenhum
 * vira nota de texto) e um botão para adicionar mais um.
 *
 * Sem intervalo nenhum, ainda desenha uma linha vazia: é o que deixa o dia
 * pronto para receber um horário sem precisar clicar em "+ intervalo"
 * primeiro — o caso mais comum (um intervalo por dia) continua sendo o mais
 * rápido de preencher.
 */
function desenharDiaDaGrade(dia, nome, janelas) {
  const bloco = criarElemento('div', { classe: 'horario-dia' });
  bloco.dataset.dia = String(dia);
  bloco.append(criarElemento('span', { texto: nome, classe: 'horario-nome' }));

  const lista = criarElemento('div', { classe: 'horario-janelas' });
  lista.dataset.dia = String(dia);
  const linhasIniciais = janelas.length > 0 ? janelas : [['', '']];
  for (const [inicio, fim] of linhasIniciais) {
    lista.append(desenharJanelaDaGrade(dia, inicio ?? '', fim ?? ''));
  }
  bloco.append(lista);

  const adicionar = document.createElement('button');
  adicionar.type = 'button';
  adicionar.className = 'acao horario-adicionar';
  adicionar.textContent = '+ intervalo';
  adicionar.dataset.dia = String(dia);
  bloco.append(adicionar);

  return bloco;
}

function desenharGradeDeHorario(agenda) {
  const grade = seletor('#horario-grade');
  if (!grade) return;

  // TODAS as janelas de cada dia viram linha editável — nenhuma fica
  // escondida atrás de uma nota "+N faixa(s)" que se perderia ao salvar
  // (Comando 4: era exatamente isso que acontecia com `janelas[1]` em diante).
  grade.replaceChildren(...DIAS_DA_SEMANA.map(
    (nome, dia) => desenharDiaDaGrade(dia, nome, agenda?.dias?.[String(dia)] ?? []),
  ));
}

/**
 * Adiciona uma linha vazia ao dia informado, e coloca o foco nela — quem
 * clicou em "+ intervalo" está prestes a digitar um horário nela.
 */
function adicionarJanelaNaGrade(dia) {
  const lista = seletor(`.horario-janelas[data-dia="${dia}"]`);
  if (!lista) return;
  const linha = desenharJanelaDaGrade(dia, '', '');
  lista.append(linha);
  linha.querySelector('.horario-inicio')?.focus();
}

/**
 * Remove a linha do intervalo clicado. Um dia nunca fica sem nenhuma linha
 * visível — a última é limpa em vez de removida, porque "sem linha nenhuma"
 * não tem como virar "sem horário neste dia" de volta sem reabrir a tela.
 */
function removerJanelaDaGrade(botao) {
  const linha = botao.closest('.horario-janela');
  if (!linha) return;
  const lista = linha.parentElement;
  if (lista && lista.children.length > 1) {
    linha.remove();
    return;
  }
  for (const campo of linha.querySelectorAll('input[type="time"]')) campo.value = '';
}

/**
 * Lê a grade da tela inteira, direto do DOM — nenhum estado "anterior" é
 * consultado, porque agora não existe mais janela escondida para preservar:
 * o que está na tela é exatamente o que existe. Linha com um lado só
 * preenchido é erro, não meia-configuração salva por engano.
 */
function lerGradeDaTela() {
  const grade = seletor('#horario-grade');
  const dias = {};

  for (let dia = 0; dia <= 6; dia += 1) {
    const linhas = grade ? [...grade.querySelectorAll(`.horario-janela[data-dia="${dia}"]`)] : [];
    const janelas = [];

    for (const linha of linhas) {
      const inicio = linha.querySelector('.horario-inicio')?.value ?? '';
      const fim = linha.querySelector('.horario-fim')?.value ?? '';
      if (!inicio && !fim) continue; // linha vazia: nenhum intervalo aqui
      if (!inicio || !fim) {
        throw new Error(`${DIAS_DA_SEMANA[dia]}: preencha o início e o fim de cada intervalo, ou remova o intervalo`);
      }
      janelas.push([inicio, fim]);
    }

    dias[String(dia)] = janelas;
  }

  return { ativa: seletor('#horario-ativo')?.checked === true, fuso: FUSO_DA_CLINICA, dias };
}

async function salvarHorario() {
  const aviso = seletor('#horario-aviso');
  if (aviso) aviso.textContent = '';

  let grade;
  try {
    grade = lerGradeDaTela();
  } catch (erro) {
    if (aviso) aviso.textContent = erro.message;
    return;
  }

  try {
    const { horario } = await pedirJson('/api/serena/horario', { metodo: 'PUT', corpo: grade });
    if (serenaPainel) serenaPainel.horario = horario;
    desenharHorario(horario);
    if (aviso) aviso.textContent = 'horário salvo';
  } catch (erro) {
    if (aviso) aviso.textContent = erro.detalhe ?? `não foi possível salvar: ${erro.message}`;
  }
}

/**
 * Pausa, retomada e plantão: uma chamada, e a tela se redesenha com a resposta.
 *
 * `botao`, quando informado, fica "Aplicando…" e desabilitado até a resposta
 * do servidor — impede o duplo clique de virar dois comandos concorrentes.
 */
async function mexerNoAtendimento(caminho, opcoes, botao = null) {
  const textoOriginal = botao?.textContent;
  if (botao) {
    botao.disabled = true;
    botao.textContent = 'Aplicando…';
  }
  try {
    const { horario } = await pedirJson(caminho, opcoes);
    if (serenaPainel) serenaPainel.horario = horario;
    desenharHorario(horario);
    // Pausar cala a automação a partir de agora — "comando recebido", não
    // "geração em andamento cancelada retroativamente".
    if (opcoes.metodo === 'POST' && caminho === '/api/serena/pausa') {
      informar('Comando recebido: Serena pausada. Uma resposta que já estava sendo gerada no momento do clique pode ainda ter sido entregue.');
    }
  } catch (erro) {
    informar(erro.detalhe ?? `não foi possível: ${erro.message}`);
  } finally {
    if (botao) {
      botao.disabled = false;
      if (textoOriginal !== undefined) botao.textContent = textoOriginal;
    }
  }
}

// ---------------------------------------------------------------------------
// Conexão do WhatsApp da clínica.
//
// O QR do WhatsApp vive poucos segundos e é trocado por outro enquanto ninguém
// escaneia. Mostrar um e deixar na tela produz um código morto que a pessoa
// tenta escanear sem entender por que não funciona — então a tela repede.
// ---------------------------------------------------------------------------

let relogioDoQr = null;
// Cada abertura da janela do QR ganha um número. Requisição que volta com número
// velho pertence a uma janela já fechada e é descartada.
let aberturaDoQr = 0;

/**
 * Comando 4 / frente 8: a Evolution API é o canal PRIMÁRIO de entrega desde
 * os PRs #30/#31 (ver `canal-conversas.js` — ela é tentada antes, o gateway
 * do OpenClaw abaixo só entra como reserva se ela falhar ou não estiver
 * configurada). Antes, este cartão só sabia falar do gateway e podia dizer
 * "conexão indisponível" com o canal que realmente entrega funcionando —
 * agora `/api/serena/canal` sempre traz `evolucao`, e a tela mostra os dois.
 */
async function desenharEstadoDoCanal() {
  const descricao = seletor('#canal-descricao');
  const acoes = seletor('#canal-acoes');
  if (!descricao) return;

  try {
    const canal = await pedirJson('/api/serena/canal');
    const evolucaoOk = canal.evolucao?.configurada === true;
    const rotuloDoGateway = evolucaoOk ? 'gateway do OpenClaw (reserva)' : 'gateway do OpenClaw';

    const prefixo = evolucaoOk
      ? `Evolution API configurada${canal.evolucao.instancia ? ` (instância "${canal.evolucao.instancia}")` : ''} — via principal de entrega. `
      : 'Evolution API não configurada. ';

    if (!canal.disponivel) {
      descricao.textContent = evolucaoOk
        ? `${prefixo}${rotuloDoGateway}: ${canal.motivo ?? 'indisponível'}`
        : `${prefixo}${rotuloDoGateway} também indisponível — ${canal.motivo ?? 'não configurado'}. Nenhum canal de entrega ativo.`;
      if (acoes) acoes.hidden = true;
      return;
    }

    const estadoDoGateway = canal.vinculado
      ? (canal.conectado ? `conectado no ${formatarTelefone(canal.numero)}` : `vinculado ao ${formatarTelefone(canal.numero)}, mas fora do ar agora`)
      : 'nenhum telefone conectado nele';
    descricao.textContent = `${prefixo}${rotuloDoGateway}: ${estadoDoGateway}`;

    // Só o master conecta: trocar o telefone muda por onde a clínica atende.
    if (acoes) {
      acoes.hidden = !usuarioAtual?.master;
      const botao = seletor('#canal-conectar');
      if (botao) {
        botao.textContent = canal.vinculado
          ? 'Reconectar'
          : (evolucaoOk ? 'Conectar WhatsApp (reserva)' : 'Conectar WhatsApp');
      }
    }

    // Sem await: é um aviso, não um pré-requisito para mostrar o estado.
    desenharRiscoDoCanal().catch(() => {});
  } catch (erro) {
    descricao.textContent = `não foi possível verificar: ${erro.message}`;
  }
}

/**
 * Aviso de risco de bloqueio do número.
 *
 * O WhatsApp derruba números que se comportam como disparador de massa, e o
 * nosso atende por sessão pareada — o mesmo mecanismo do WhatsApp Web, sem a
 * proteção contratual da API oficial. Migrar tem custo alto (tira o número do
 * celular da recepção), então este bloco só aparece quando os números mostram
 * que a hora chegou. Enquanto o uso é o de uma clínica, fica calado: aviso
 * permanente vira paisagem, e aí ninguém repara quando ele muda.
 */
async function desenharRiscoDoCanal() {
  const bloco = seletor('#canal-risco');
  if (!bloco) return;

  const risco = await pedirJson('/api/serena/canal/risco');

  if (risco.semDados || risco.nivel === 'tranquilo') {
    bloco.hidden = true;
    return;
  }

  const ehRisco = risco.nivel === 'risco';
  bloco.className = `aviso-risco ${ehRisco ? 'grave' : 'moderado'}`;

  const selo = seletor('#risco-selo');
  if (selo) selo.textContent = ehRisco ? '⛔' : '⚠️';

  const frase = seletor('#risco-frase');
  if (frase) {
    frase.textContent = ehRisco
      ? 'O número corre risco real de ser bloqueado'
      : 'O uso começou a sair do padrão de uma clínica';
  }

  const lista = seletor('#risco-motivos');
  if (lista) {
    lista.replaceChildren(...risco.motivos.map((motivo) => {
      const item = document.createElement('li');
      item.textContent = `${motivo.texto} — ${motivo.porque}`;
      return item;
    }));
  }

  const recomendacao = seletor('#risco-recomendacao');
  if (recomendacao) recomendacao.textContent = risco.recomendacao;

  bloco.hidden = false;
}

async function atualizarQr() {
  const aviso = seletor('#qr-aviso');
  const imagem = seletor('#qr-imagem');
  if (imagem) imagem.hidden = true;

  // Fechar a janela limpa o bloco da instrução, mas não cancela a requisição já
  // em voo. Sem esta marca, a resposta atrasada escreveria de novo num modal
  // fechado — e a próxima abertura começaria exibindo a instrução da anterior.
  const abertura = aberturaDoQr;

  try {
    const resposta = await pedirJson('/api/serena/canal/qr', { metodo: 'POST' });
    if (abertura !== aberturaDoQr) return;

    if (resposta.vinculado) {
      fecharModalDoQr();
      informar(`WhatsApp conectado: ${formatarTelefone(resposta.numero)}`);
      await desenharEstadoDoCanal();
      return;
    }

    if (resposta.qr && imagem) {
      imagem.src = resposta.qr;
      imagem.hidden = false;
      if (aviso) aviso.hidden = true;
      // Veio QR de verdade: os passos voltam a descrever o que está na tela.
      const bloco = seletor('#qr-instrucao');
      if (bloco) { bloco.hidden = true; bloco.replaceChildren(); }
      alternarPassosDoQr(true);
      return;
    }

    // O gateway não expõe o QR por RPC — só pelo comando no servidor. Em vez
    // de um botão que gira sem entregar, a tela diz o caminho que funciona.
    mostrarInstrucaoDeVinculo(resposta.instrucao ?? null);
  } catch {
    if (abertura !== aberturaDoQr) return;
    mostrarInstrucaoDeVinculo(null);
  }
}

/**
 * Mostra o caminho manual quando o gateway não entrega o QR.
 *
 * Escreve num bloco irmão, nunca por cima de `#qr-area`: sobrescrever o HTML
 * apagava `#qr-imagem` do DOM, e uma única falha do gateway — um reinício, por
 * exemplo — deixava a tela incapaz de exibir QR até recarregar a página.
 *
 * O endereço do servidor vem do servidor, em `instrucao`. Ele não pode morar
 * aqui: `app.js` é baixado sem login por qualquer um.
 */
function mostrarInstrucaoDeVinculo(instrucao) {
  const bloco = seletor('#qr-instrucao');
  const aviso = seletor('#qr-aviso');
  pararRelogioDoQr();
  if (aviso) aviso.hidden = true;
  // Os passos e a nota mandam apontar a câmera para um código na tela. Com a
  // instrução do servidor no lugar do QR, eles passam a instruir o contrário do
  // que a janela mostra — some com os dois enquanto o caminho é o manual.
  alternarPassosDoQr(false);
  if (!bloco) return;

  if (!instrucao) {
    bloco.textContent = 'Não foi possível gerar o código agora. Tente de novo em instantes.';
    bloco.hidden = false;
    return;
  }

  const linhas = [
    criarElemento('p', { html: `<b>${escapar(instrucao.titulo)}</b>` }),
    criarElemento('p', { texto: instrucao.antes }),
  ];

  // O link primeiro: é o caminho de quem está na clínica, num navegador. O
  // comando de terminal só aparece quando existe, e depois — instrução que a
  // pessoa não consegue seguir, posta antes da que ela consegue, é ruído.
  if (instrucao.url) {
    const link = criarElemento('a', { texto: 'Abrir o OpenClaw Control', classe: 'botao-link' });
    link.href = instrucao.url;
    link.target = '_blank';
    // Sem isto, a página aberta ganha `window.opener` e pode redirecionar esta.
    link.rel = 'noopener noreferrer';
    linhas.push(link);
  }

  if (instrucao.comandos?.length) {
    linhas.push(criarElemento('p', { texto: 'Ou, com acesso ao servidor:', classe: 'nota' }));
    linhas.push(criarElemento('pre', { texto: instrucao.comandos.join('\n') }));
  }

  linhas.push(criarElemento('p', { texto: instrucao.depois, classe: 'nota' }));

  bloco.replaceChildren(...linhas);
  bloco.hidden = false;
}

/** Passos e nota só fazem sentido quando há um QR de verdade na tela. */
function alternarPassosDoQr(visiveis) {
  for (const alvo of ['#qr-passos', '#qr-nota']) {
    const elemento = seletor(alvo);
    if (elemento) elemento.hidden = !visiveis;
  }
}

function criarElemento(tag, { texto, html, classe } = {}) {
  const elemento = document.createElement(tag);
  if (classe) elemento.className = classe;
  if (html) elemento.innerHTML = html;
  else if (texto) elemento.textContent = texto;
  return elemento;
}

function pararRelogioDoQr() {
  if (relogioDoQr) {
    clearInterval(relogioDoQr);
    relogioDoQr = null;
  }
}

function fecharModalDoQr() {
  aberturaDoQr += 1; // invalida qualquer requisição ainda em voo
  pararRelogioDoQr();
  const modal = seletor('#modal-qr');
  if (modal) modal.hidden = true;
  const imagem = seletor('#qr-imagem');
  if (imagem) { imagem.hidden = true; imagem.removeAttribute('src'); }
  const instrucao = seletor('#qr-instrucao');
  if (instrucao) { instrucao.hidden = true; instrucao.replaceChildren(); }
  alternarPassosDoQr(true);
  // Nada de avisar o servidor. O painel não abre assistente nenhum, então um
  // "cancelar" daqui só poderia derrubar o de outra pessoa — o do admin com o
  // `vincular-whatsapp` rodando no terminal, no instante em que ele fecha isto.
}

async function conectarWhatsapp() {
  const modal = seletor('#modal-qr');
  if (!modal) return;

  modal.hidden = false;
  const aviso = seletor('#qr-aviso');
  if (aviso) { aviso.hidden = false; aviso.textContent = 'gerando o código…'; }

  // A primeira consulta pode levar até 30s (timeout do gateway). Se a janela for
  // fechada nesse meio-tempo, armar o relógio depois deixaria a aba consultando
  // a cada 5s para sempre — reabrindo no gateway a vinculação recém-cancelada.
  const abertura = aberturaDoQr;
  await atualizarQr();
  if (abertura !== aberturaDoQr) return;

  pararRelogioDoQr();
  // Cinco segundos: o QR do WhatsApp costuma durar cerca de vinte, e recarregar
  // antes disso mantém sempre um código válido na tela.
  relogioDoQr = setInterval(atualizarQr, 5000);
}

document.addEventListener('click', (evento) => {
  const alvo = evento.target.closest('button');
  if (!alvo) return;
  if (alvo.id === 'canal-conectar') conectarWhatsapp();
  if (alvo.id === 'qr-fechar') fecharModalDoQr();

  // Horário. Os prazos são curtos de propósito: pausa e plantão existem para
  // durar o tempo de uma intervenção, e voltar sozinhos é o que impede que
  // alguém esqueça a Serena calada — ou falando num domingo.
  if (alvo.id === 'horario-salvar') salvarHorario();
  if (alvo.classList.contains('horario-adicionar')) adicionarJanelaNaGrade(alvo.dataset.dia);
  if (alvo.classList.contains('horario-remover')) removerJanelaDaGrade(alvo);
  if (alvo.id === 'serena-pausar') {
    mexerNoAtendimento('/api/serena/pausa', { metodo: 'POST', corpo: { minutos: 15 } }, alvo);
  }
  if (alvo.id === 'serena-despausar') {
    mexerNoAtendimento('/api/serena/pausa', { metodo: 'DELETE' }, alvo);
  }
  if (alvo.id === 'serena-plantao') {
    mexerNoAtendimento('/api/serena/plantao', { metodo: 'POST', corpo: { minutos: 60 } }, alvo);
  }
});

// Fechar com Esc: modal que só fecha no botão prende quem abriu por engano.
document.addEventListener('keydown', (evento) => {
  if (evento.key === 'Escape' && !seletor('#modal-qr')?.hidden) fecharModalDoQr();
});

// ---------------------------------------------------------------- teste da Serena
//
// Ensaio do prompt dentro do painel. A conversa acontece na sessão do gateway,
// não no canal: nada sai para telefone, e o paciente fictício não vira contato.
//
// O modelo responde de forma assíncrona — `enviar` volta antes de a resposta
// existir. Por isso a tela pergunta pelo histórico algumas vezes até a resposta
// aparecer, em vez de esperar uma única vez e desistir.

let sessaoDeTeste = null;
let testeOcupado = false;

function desenharConversaDeTeste(mensagens) {
  const area = seletor('#teste-conversa');
  if (!area) return;

  if (!mensagens.length) {
    area.innerHTML = '<p class="vazio" id="teste-vazio">Escreva a primeira mensagem do paciente para começar.</p>';
    return;
  }

  area.replaceChildren(...mensagens.map((mensagem) => {
    const balao = document.createElement('div');
    balao.className = `balao ${mensagem.de === 'serena' ? 'de-serena' : 'de-paciente'}`;
    const corpo = document.createElement('span');
    corpo.textContent = mensagem.texto;
    balao.appendChild(corpo);

    // Qual modelo respondeu, no próprio balão. Sem isto, comparar duas conversas
    // exigiria lembrar o que estava selecionado quando cada resposta chegou.
    if (mensagem.modelo) {
      const etiqueta = document.createElement('small');
      etiqueta.className = 'modelo-usado';
      etiqueta.textContent = mensagem.modelo;
      balao.appendChild(etiqueta);
    }

    return balao;
  }));

  area.scrollTop = area.scrollHeight;
}

/** Pergunta pelo histórico até a Serena responder, ou até desistir. */
async function esperarResposta(quantasAntes) {
  for (let tentativa = 0; tentativa < 20; tentativa += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const historico = await pedirJson(`/api/serena/teste?sessao=${encodeURIComponent(sessaoDeTeste)}`);
    if (historico.mensagens.length > quantasAntes) {
      desenharConversaDeTeste(historico.mensagens);
      return true;
    }
  }
  return false;
}

async function enviarNoTeste(texto) {
  if (testeOcupado) return;
  testeOcupado = true;

  const botao = seletor('#teste-enviar');
  const campo = seletor('#teste-texto');
  if (botao) { botao.disabled = true; botao.textContent = 'Serena pensando…'; }

  try {
    if (!sessaoDeTeste) {
      const aberta = await pedirJson('/api/serena/teste', {
        metodo: 'POST',
        corpo: { modelo: seletor('#teste-modelo')?.value || null },
      });
      sessaoDeTeste = aberta.sessao;
      preencherModelos(aberta.modelos);
    }

    const antes = await pedirJson(`/api/serena/teste?sessao=${encodeURIComponent(sessaoDeTeste)}`);
    desenharConversaDeTeste([...antes.mensagens, { de: 'paciente', texto }]);

    await pedirJson('/api/serena/teste/mensagem', {
      metodo: 'POST',
      corpo: { sessao: sessaoDeTeste, texto },
    });

    if (campo) campo.value = '';
    const respondeu = await esperarResposta(antes.mensagens.length + 1);
    if (!respondeu) informar('A Serena não respondeu a tempo. Tente de novo.');
  } catch (erro) {
    informar(`Não foi possível testar: ${erro.message}`);
  } finally {
    testeOcupado = false;
    if (botao) { botao.disabled = false; botao.textContent = 'Enviar'; }
    if (campo) campo.focus();
  }
}

seletor('#teste-form')?.addEventListener('submit', (evento) => {
  evento.preventDefault();
  const campo = seletor('#teste-texto');
  const texto = campo?.value.trim();
  if (texto) enviarNoTeste(texto);
});

seletor('#teste-reiniciar')?.addEventListener('click', () => {
  // Sessão nova começa sem contexto: é o que permite repetir o mesmo caso e
  // comparar a resposta depois de mexer no prompt.
  sessaoDeTeste = null;
  desenharConversaDeTeste([]);
});

/**
 * Preenche o seletor de modelos com a lista que o servidor manda.
 *
 * A lista vem de lá, e não daqui, porque nome de modelo inválido só dá erro
 * quando alguém já está no meio de um teste — e a tela não tem como saber quais
 * provedores têm credencial configurada.
 */
function preencherModelos(modelos) {
  const campo = seletor('#teste-modelo');
  if (!campo || !Array.isArray(modelos) || !modelos.length) return;

  // Só preenche uma vez: repovoar a cada mensagem descartaria a escolha de quem
  // está testando, e a conversa passaria a alternar de modelo sozinha.
  if (campo.dataset.preenchido === 'sim') return;

  const escolhido = campo.value;

  campo.replaceChildren(...modelos.map((modelo) => {
    const opcao = document.createElement('option');
    opcao.value = modelo.id;
    opcao.textContent = modelo.nota ? `${modelo.nome} — ${modelo.nota}` : modelo.nome;
    return opcao;
  }));

  campo.dataset.preenchido = 'sim';
  if (escolhido) campo.value = escolhido;
}

/**
 * Busca a lista de modelos antes da primeira mensagem.
 *
 * Sem isto, o seletor ficava vazio até alguém enviar algo — e a lista só chegava
 * junto da primeira sessão, quando já era tarde para escolher o modelo que se
 * queria testar.
 */
async function carregarModelosDoTeste() {
  const campo = seletor('#teste-modelo');
  if (!campo || campo.dataset.preenchido === 'sim') return;

  try {
    const aberta = await pedirJson('/api/serena/teste', { metodo: 'POST', corpo: {} });
    preencherModelos(aberta.modelos);
    // A sessão aberta aqui é aproveitada: descartá-la faria a primeira mensagem
    // abrir outra, e a conversa começaria na segunda tentativa.
    sessaoDeTeste = aberta.sessao;
  } catch {
    // Sem lista, o teste ainda funciona no modelo padrão do agente — que é o
    // caso mais comum. Travar a tela por causa do seletor seria pior.
  }
}

// Trocar de modelo começa conversa nova. Continuar a mesma conversa com outro
// modelo compararia respostas sobre históricos diferentes — que é justamente o
// que impede concluir qual se saiu melhor.
seletor('#teste-modelo')?.addEventListener('change', (evento) => {
  // Seletor vazio disparando `change` zerava a sessão antes de a mensagem sair.
  if (!evento.target.value) return;
  sessaoDeTeste = null;
  desenharConversaDeTeste([]);
  informar('Conversa reiniciada para testar o modelo escolhido.');
});

// ------------------------------------------------------------ centro operacional
//
// Sete peças falham em silêncio — banco, RLS, esquema, fila, canal, automação e
// worker — e nenhuma avisa quando cai. A varredura pergunta a todas de uma vez.
//
// Nada é consertado sozinho: cada achado traz o que fazer, e aplicar é decisão
// de quem administra. Reparo automático em produção decide sozinho que entendeu
// o problema, e quando erra, erra de madrugada, sobre dado de paciente.

const CORES_DO_NIVEL = Object.freeze({
  critico: 'grave',
  falha: 'grave',
  aviso: 'moderado',
  ok: 'moderado',
});

async function varrerSistema() {
  const botao = seletor('#diagnostico-verificar');
  const resumo = seletor('#diagnostico-resumo');
  const area = seletor('#diagnostico-achados');
  const parecerContainer = seletor('#diagnostico-parecer');
  if (!area) return;

  if (parecerContainer) { parecerContainer.hidden = true; parecerContainer.innerHTML = ''; }
  if (botao) { botao.disabled = true; botao.textContent = 'Verificando…'; }
  if (resumo) resumo.textContent = 'consultando banco, esquema, fila, canal e automação…';

  try {
    const laudo = await pedirJson('/api/diagnostico');

    if (resumo) resumo.textContent = laudo.resumo;

    if (!laudo.achados.length) {
      area.innerHTML = '<p class="vazio">Nenhum problema encontrado.</p>';
      return;
    }

    area.replaceChildren(...laudo.achados.map((item) => {
      const bloco = document.createElement('div');
      bloco.className = `aviso-risco ${CORES_DO_NIVEL[item.nivel] ?? 'moderado'}`;

      const titulo = document.createElement('p');
      titulo.className = 'titulo-risco';
      titulo.innerHTML = `<b>${escapar(item.area)}: ${escapar(item.titulo)}</b>`;
      bloco.appendChild(titulo);

      if (item.detalhe) {
        const detalhe = document.createElement('p');
        detalhe.className = 'nota';
        detalhe.textContent = item.detalhe;
        bloco.appendChild(detalhe);
      }

      if (item.reparo) {
        const reparo = document.createElement('p');
        reparo.textContent = item.reparo;
        bloco.appendChild(reparo);
      }

      const botoes = document.createElement('div');
      botoes.className = 'linha-acoes';
      botoes.style.marginTop = '0.5rem';

      const btnReparo = document.createElement('button');
      btnReparo.type = 'button';
      btnReparo.className = 'secundario btn-reparo-ia';
      btnReparo.textContent = 'Planejar reparo com IA';
      btnReparo.addEventListener('click', () => planoDeReparo(item, bloco));
      botoes.appendChild(btnReparo);

      if (item.acao) {
        const btnAplicar = document.createElement('button');
        btnAplicar.type = 'button';
        btnAplicar.className = 'primario';
        btnAplicar.textContent = 'Aplicar reparo';
        btnAplicar.addEventListener('click', () => aplicarReparo(item.acao));
        botoes.appendChild(btnAplicar);
      }

      bloco.appendChild(botoes);

      return bloco;
    }));
  } catch (erro) {
    if (resumo) resumo.textContent = `não foi possível verificar: ${erro.message}`;
  } finally {
    if (botao) { botao.disabled = false; botao.textContent = 'Verificar agora'; }
  }
}

async function planoDeReparo(item, bloco) {
  const botao = bloco.querySelector('.btn-reparo-ia');
  if (botao) { botao.disabled = true; botao.textContent = 'Planejando…'; }
  try {
    const { provedor } = provedorEscolhidoDoDiagnostico();
    const resultado = await pedirJson('/api/diagnostico/reparo', {
      metodo: 'POST',
      corpo: {
        area: item.area,
        nivel: item.nivel,
        titulo: item.titulo,
        detalhe: item.detalhe,
        reparo: item.reparo,
        acao: item.acao,
        ...(provedor ? { provedor } : {}),
      },
    });
    const plano = document.createElement('div');
    plano.className = 'nota';
    plano.innerHTML = `<pre style="white-space:pre-wrap">${escapar(resultado.plano)}</pre>`;
    const origem = document.createElement('small');
    origem.textContent = `Gerado por ${resultado.gerado_por}${resultado.de_cache ? ' · reaproveitado' : ''}`;
    plano.appendChild(origem);
    bloco.appendChild(plano);
  } catch (erro) {
    const msg = document.createElement('p');
    msg.className = 'nota';
    msg.textContent = `não foi possível planejar reparo: ${erro.message}`;
    bloco.appendChild(msg);
  } finally {
    if (botao) { botao.disabled = false; botao.textContent = 'Planejar reparo com IA'; }
  }
}

async function aplicarReparo(acao) {
  if (!confirm(`Aplicar o reparo "${acao}"?\n\nIsso altera o banco de produção. Certifique-se de que entende o problema.`)) return;
  try {
    const resultado = await pedirJson('/api/diagnostico/acoes', {
      metodo: 'POST', corpo: { acao },
    });
    alert(`Reparo aplicado: ${JSON.stringify(resultado)}`);
    await varrerSistema();
  } catch (erro) {
    alert(`Falha ao aplicar reparo: ${erro.message}`);
  }
}

async function parecerDaIA() {
  const botao = seletor('#diagnostico-parecer-ia');
  const container = seletor('#diagnostico-parecer');
  if (!container) return;
  if (botao) { botao.disabled = true; botao.textContent = 'Analisando…'; }
  container.hidden = false;
  container.textContent = 'Consultando a IA…';
  try {
    const { provedor } = provedorEscolhidoDoDiagnostico();
    const resultado = await pedirJson('/api/diagnostico/parecer', {
      metodo: 'POST', corpo: provedor ? { provedor } : {},
    });
    container.innerHTML = `<pre style="white-space:pre-wrap">${escapar(resultado.parecer)}</pre>`;
    const origem = document.createElement('p');
    origem.className = 'nota';
    origem.textContent = `Gerado por ${resultado.gerado_por}${resultado.de_cache ? ' · reaproveitado do cache do dia' : ''}${resultado.fallback_de ? ` · fallback de ${resultado.fallback_de}` : ''}`;
    container.appendChild(origem);
  } catch (erro) {
    container.textContent = `não foi possível obter parecer: ${erro.message}`;
  } finally {
    if (botao) { botao.disabled = false; botao.textContent = 'Parecer da IA'; }
  }
}

function provedorEscolhidoDoDiagnostico() {
  const seletorIa = seletor('#diagnostico-ia');
  const provedor = seletorIa?.value || null;
  return { provedor, modelo: null };
}

async function carregarSeletorDeIaDoDiagnostico() {
  const seletorIa = seletor('#diagnostico-ia');
  if (!seletorIa) return;
  if (!catalogoDeIA) {
    try {
      const { provedores } = await pedirJson('/api/ia/modelos');
      catalogoDeIA = provedores;
    } catch {
      seletorIa.innerHTML = '<option value="" disabled>Provedores indisponíveis</option>';
      return;
    }
  }
  seletorIa.innerHTML = '<option value="" disabled>Escolha a IA…</option>';
  let temDisponivel = false;
  for (const linha of catalogoDeIA) {
    const opcao = document.createElement('option');
    opcao.value = linha.provedor;
    opcao.textContent = linha.disponivel ? linha.provedor : `${linha.provedor} (sem chave)`;
    opcao.disabled = !linha.disponivel;
    seletorIa.append(opcao);
    if (linha.disponivel) temDisponivel = true;
  }
  const salvo = localStorage.getItem('centro-operacional:provedor-ia');
  if (salvo) seletorIa.value = salvo;
  seletorIa.addEventListener('change', () => {
    localStorage.setItem('centro-operacional:provedor-ia', seletorIa.value);
  });
  const botaoParecer = seletor('#diagnostico-parecer-ia');
  if (botaoParecer) botaoParecer.hidden = !temDisponivel;
}

seletor('#diagnostico-verificar')?.addEventListener('click', varrerSistema);
seletor('#diagnostico-parecer-ia')?.addEventListener('click', parecerDaIA);

/**
 * Move um lead de etapa no funil.
 *
 * Recarrega o quadro depois de gravar, em vez de mexer no DOM na mão: mover o
 * card antes da confirmação mostraria a etapa nova mesmo quando a gravação
 * falha, e aí o funil na tela deixa de ser o funil do banco.
 */
async function moverLead(leadId, estagio, extras = {}) {
  if (!estagio) return;

  const card = document.querySelector(`[data-lead-id="${leadId}"]`);
  if (card?.dataset.estagio === estagio && Object.keys(extras).length === 0) return; // soltou onde já estava

  try {
    await pedirJson(`/api/leads/${leadId}/estagio`, {
      metodo: 'POST',
      corpo: { estagio, ...extras },
    });
    await carregarLeads();
  } catch (erro) {
    // A regra do kanban pede dono e próximo passo; a interface pede na hora em
    // vez de devolver o card com um erro seco.
    if (erro.codigo === 'gestao_obrigatoria' && !extras.proximo_passo) {
      const passo = window.prompt('Qual é o próximo passo combinado para este lead?');
      if (passo && passo.trim()) {
        return moverLead(leadId, estagio, { ...extras, proximo_passo: passo.trim() });
      }
    }
    if (erro.codigo === 'motivo_obrigatorio' && !extras.motivo) {
      const motivo = window.prompt('Qual o motivo da perda? (alimenta a métrica de perda)');
      if (motivo && motivo.trim()) {
        return moverLead(leadId, estagio, { ...extras, motivo: motivo.trim() });
      }
    }

    informar(`Não foi possível mover o lead: ${erro.detalhe || erro.message}`);
    // Recarrega mesmo em caso de falha: sem isto o card fica onde o navegador o
    // largou, sugerindo uma mudança que o banco recusou.
    await carregarLeads();
  }
}

// ---------------------------------------------------------------------------
// Instalar o CRM como app no aparelho (12/09/2026)
//
// Pedido do Dr. Edson: "quem entrar tem esta possibilidade de baixar, já com o
// ícone novo". No Android o navegador avisa quando o site pode ser instalado
// (`beforeinstallprompt`) e esse aviso pode ser guardado para disparar no
// clique de um botão nosso. No iPhone esse evento não existe: lá a instalação é
// manual, pelo menu Compartilhar — então o que dá para fazer é ensinar o
// caminho, em vez de mostrar um botão que não faria nada.
//
// O ícone do app instalado sai do manifest.webmanifest, e o registro do service
// worker (public/sw.js, que não guarda cache nenhum) é o que falta para o
// navegador considerar o site instalável.

let conviteDeInstalacao = null;

function rodandoComoApp() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || window.navigator.standalone === true;
}

function ehIPhoneOuIPad() {
  const agente = navigator.userAgent || '';
  // iPad recente se anuncia como Mac: o toque é o que o separa de um desktop.
  return /iPad|iPhone|iPod/.test(agente)
    || (/Macintosh/.test(agente) && navigator.maxTouchPoints > 1);
}

function mostrarConviteDeInstalacao({ ajuda = '' } = {}) {
  for (const botao of document.querySelectorAll('[data-instalar-app]')) botao.hidden = Boolean(ajuda);
  for (const texto of document.querySelectorAll('[data-instalar-ajuda]')) {
    texto.hidden = !ajuda;
    if (ajuda) texto.textContent = ajuda;
  }
}

function esconderConviteDeInstalacao() {
  for (const botao of document.querySelectorAll('[data-instalar-app]')) botao.hidden = true;
  for (const texto of document.querySelectorAll('[data-instalar-ajuda]')) texto.hidden = true;
}

// O navegador dispara isto quando o site atende aos requisitos de instalação.
// Guardamos o convite e mostramos o botão; `preventDefault` tira o aviso
// automático do navegador, que aparece em lugar que ninguém procura.
window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault();
  conviteDeInstalacao = evento;
  mostrarConviteDeInstalacao();
});

window.addEventListener('appinstalled', () => {
  conviteDeInstalacao = null;
  esconderConviteDeInstalacao();
});

for (const botao of document.querySelectorAll('[data-instalar-app]')) {
  botao.addEventListener('click', async () => {
    if (!conviteDeInstalacao) return;
    const convite = conviteDeInstalacao;
    // O convite é de uso único: guardá-lo depois de usado faria o segundo
    // clique falhar em silêncio.
    conviteDeInstalacao = null;
    esconderConviteDeInstalacao();
    try {
      convite.prompt();
      const { outcome } = await convite.userChoice;
      // Recusar não é erro: o botão volta, para quem mudar de ideia.
      if (outcome !== 'accepted') mostrarConviteDeInstalacao();
    } catch {
      mostrarConviteDeInstalacao();
    }
  });
}

(function prepararInstalacao() {
  if (rodandoComoApp()) return esconderConviteDeInstalacao();

  // iPhone e iPad não têm o evento: a instalação é pelo menu Compartilhar.
  if (ehIPhoneOuIPad()) {
    mostrarConviteDeInstalacao({
      ajuda: 'Para instalar no iPhone: toque em Compartilhar (o quadrado com a seta) e depois em "Adicionar à Tela de Início".',
    });
  }

  if (!('serviceWorker' in navigator)) return undefined;
  // Depois do load: registrar cedo demais disputa banda com a primeira tela.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sem service worker o CRM funciona igual — só não dá para instalar.
    });
  });
  return undefined;
}());

// ---------------------------------------------------------------------------
// Avisos no celular (12/09/2026)
//
// Pedido do Dr. Edson: "quando acontecer algo na conta que me pertence, o
// usuário ser notificado, via popup do celular".
//
// Como funciona: o navegador cria uma inscrição no serviço de push DELE
// (Google, Mozilla, Apple), assinada com a chave pública do nosso servidor, e
// nós guardamos o endereço dessa inscrição. Quando alguém fica esperando
// resposta, o servidor empurra — sem conteúdo, porque o aviso aparece na tela
// de bloqueio (ver src/seguranca/webpush.js).
//
// O aparelho avisado é AQUELE onde a pessoa apertou o botão. Quem usa celular e
// computador aperta nos dois.

/** A chave pública vem em base64url e o navegador exige bytes. */
function bytesDaChave(base64url) {
  const preenchido = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const cru = atob(preenchido + '='.repeat((4 - (preenchido.length % 4)) % 4));
  return Uint8Array.from(cru, (letra) => letra.charCodeAt(0));
}

let avisosDisponiveis = null;

function mostrarRecadoDeAviso(texto) {
  const recado = seletor('#avisos-recado');
  if (!recado) return;
  recado.hidden = !texto;
  if (texto) recado.textContent = texto;
}

function desenharBotoesDeAviso(inscrito) {
  const ligar = seletor('#avisos-ligar');
  const desligar = seletor('#avisos-desligar');
  if (ligar) ligar.hidden = inscrito;
  if (desligar) desligar.hidden = !inscrito;
  definirTexto('#avisos-estado', inscrito
    ? 'Este aparelho recebe avisos quando alguém está esperando resposta.'
    : 'Receba um toque quando alguém estiver esperando resposta.');
}

async function inscricaoDesteAparelho() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registro = await navigator.serviceWorker.getRegistration();
  if (!registro) return null;
  return registro.pushManager.getSubscription();
}

/** Carrega o estado ao abrir Meu perfil. */
async function carregarAvisosDoCelular() {
  const card = seletor('#avisos-card');
  if (!card) return;

  try {
    avisosDisponiveis = await pedirJson('/api/aparelhos');
  } catch {
    // Servidor sem a rota (versão antiga) ou fora do ar: o cartão não aparece.
    card.hidden = true;
    return;
  }

  // Sem VAPID no servidor não há empurrão possível: um botão que não faz nada
  // é pior que botão nenhum.
  if (!avisosDisponiveis?.disponivel) {
    card.hidden = true;
    return;
  }
  // Navegador sem suporte (iPhone com o site aberto no Safari, por exemplo, só
  // aceita push quando o app está instalado na tela de início).
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    card.hidden = false;
    desenharBotoesDeAviso(false);
    seletor('#avisos-ligar').disabled = true;
    mostrarRecadoDeAviso(ehIPhoneOuIPad()
      ? 'No iPhone, os avisos só funcionam depois de instalar o app na tela de início (Compartilhar → Adicionar à Tela de Início).'
      : 'Este navegador não recebe avisos.');
    return;
  }

  card.hidden = false;
  mostrarRecadoDeAviso('');
  desenharBotoesDeAviso(Boolean(await inscricaoDesteAparelho()));
}

/**
 * @returns {Promise<{ligado: boolean, motivo?: string}>} para quem chamou saber
 *   se a inscrição realmente aconteceu — a faixa do convite só pode sumir
 *   quando aconteceu.
 */
async function ligarAvisosDoCelular({ silencioso = false } = {}) {
  // No modo silencioso não se mexe no botão de Meu perfil: isto roda em todo
  // login, e deixar o botão desabilitado por causa de um passo que travou
  // atrás significa a pessoa não conseguir mais ligar os avisos na mão.
  const botao = silencioso ? null : seletor('#avisos-ligar');
  if (botao) botao.disabled = true;
  if (!silencioso) mostrarRecadoDeAviso('');

  try {
    // No modo silencioso a permissão JÁ existe (quem chama conferiu): pedir de
    // novo não abre caixa nenhuma, mas evita depender disso.
    const permissao = silencioso && Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permissao !== 'granted') {
      // Negada no navegador, só o dono do aparelho reverte — a página não pode
      // pedir de novo, e insistir não adianta.
      const recado = permissao === 'denied'
        ? 'Os avisos estão bloqueados para este site no seu aparelho. Libere nas configurações do navegador e tente de novo.'
        : 'Sem a permissão do aparelho, não dá para avisar.';
      mostrarRecadoDeAviso(recado);
      return { ligado: false, motivo: recado };
    }

    // `serviceWorker.ready` NUNCA rejeita: se o registro falhar (sw.js fora do
    // ar depois de um deploy ruim, worker bloqueado pelo navegador), a promessa
    // fica pendente para sempre — e sem o teto abaixo o `finally` nunca roda.
    const registro = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rejeitar) => {
        setTimeout(() => rejeitar(new Error('o service worker não ficou pronto')), 10000);
      }),
    ]);
    const inscricao = await registro.pushManager.subscribe({
      // Obrigatório no Chrome: todo push tem de virar notificação visível.
      userVisibleOnly: true,
      applicationServerKey: bytesDaChave(avisosDisponiveis.chave_publica),
    });

    const dados = inscricao.toJSON();
    await pedirJson('/api/aparelhos', {
      metodo: 'POST',
      corpo: {
        endpoint: dados.endpoint,
        chaves: dados.keys,
        agente: navigator.userAgent,
      },
    });

    desenharBotoesDeAviso(true);
    if (!silencioso) informar('Pronto: este aparelho vai avisar quando alguém estiver esperando resposta.');
    return { ligado: true };
  } catch (erro) {
    const recado = `Não consegui ligar os avisos: ${erro.message}`;
    mostrarRecadoDeAviso(recado);
    return { ligado: false, motivo: recado };
  } finally {
    if (botao) botao.disabled = false;
  }
}

async function desligarAvisosDoCelular({ silencioso = false } = {}) {
  const botao = silencioso ? null : seletor('#avisos-desligar');
  if (botao) botao.disabled = true;

  try {
    const inscricao = await inscricaoDesteAparelho();
    if (inscricao) {
      // Primeiro o servidor, depois o navegador: se cair no meio, sobra uma
      // inscrição viva no aparelho e nenhuma no banco — o inverso deixaria o
      // servidor empurrando para um endereço que já morreu.
      await pedirJson('/api/aparelhos', {
        metodo: 'DELETE',
        corpo: { endpoint: inscricao.endpoint },
      }).catch(() => {});
      await inscricao.unsubscribe();
    }
    if (!silencioso) desenharBotoesDeAviso(false);
  } catch (erro) {
    if (!silencioso) mostrarRecadoDeAviso(`Não consegui desligar: ${erro.message}`);
  } finally {
    if (botao) botao.disabled = false;
  }
}

seletor('#avisos-ligar')?.addEventListener('click', ligarAvisosDoCelular);
seletor('#avisos-desligar')?.addEventListener('click', desligarAvisosDoCelular);

// O aparelho troca o endereço de entrega de tempos em tempos; o service worker
// não tem a sessão para regravar sozinho, então avisa a página.
navigator.serviceWorker?.addEventListener?.('message', (evento) => {
  if (evento.data?.tipo === 'reinscrever-avisos') ligarAvisosDoCelular().catch(() => {});
});

// ---------------------------------------------------------------------------
// O convite dos avisos, para quem entrar (13/09/2026)
//
// Pedido do Dr. Edson: "não é só no meu, são em todos os usuários que entrar".
//
// O limite que não dá para contornar: navegador nenhum concede permissão de
// notificação sem um gesto da PRÓPRIA pessoa — ninguém inscreve o aparelho de
// outro, nem o administrador. Então o que dá para fazer, e é o que está aqui:
//
//   • quem JÁ autorizou em algum momento é inscrito em silêncio, sem perguntar
//     nada (trocou de navegador, reinstalou o app, limpou os dados);
//   • quem ainda não decidiu vê um convite de um clique logo ao entrar, em vez
//     de precisar achar o botão em Meu perfil;
//   • quem dispensa fica três dias sem ser incomodado — insistir todo dia é o
//     caminho mais curto para a pessoa bloquear o site de vez;
//   • quem bloqueou no navegador não vê nada: só o dono do aparelho reverte
//     isso, e um convite que não pode funcionar é só ruído.

const DIAS_DE_SOSSEGO = 3;

/**
 * A dispensa é POR PESSOA, não por navegador.
 *
 * Com uma chave global, bastava alguém clicar "Agora não" no computador do
 * balcão para que ninguém mais que entrasse naquela máquina visse o convite
 * por três dias — o contrário exato do pedido ("em todos os usuários que
 * entrar").
 */
function chaveDoConvite() {
  return `crmclinica:avisos:dispensado-ate:${usuarioAtual?.id ?? 'anonimo'}`;
}

function conviteFoiDispensado() {
  try {
    const ate = Number(localStorage.getItem(chaveDoConvite()) || 0);
    return Number.isFinite(ate) && ate > Date.now();
  } catch {
    return false;
  }
}

function dispensarConviteDeAvisos() {
  try {
    localStorage.setItem(chaveDoConvite(), String(Date.now() + DIAS_DE_SOSSEGO * 24 * 60 * 60 * 1000));
  } catch { /* armazenamento bloqueado: o convite volta na próxima entrada */ }
  const convite = seletor('#convite-avisos');
  if (convite) convite.hidden = true;
}

/**
 * Roda depois que a aplicação aparece, para todo mundo que entra.
 *
 * Nunca lança e nunca trava a tela: se algo aqui falhar, o CRM continua
 * funcionando sem avisos — que é exatamente como ele funcionava antes.
 */
async function oferecerAvisosNoCelular() {
  const convite = seletor('#convite-avisos');
  if (!convite) return;

  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

    // Bloqueado no aparelho: só o dono reverte, e insistir não adianta. Sai
    // antes de perguntar qualquer coisa ao servidor — pedido que não pode
    // mudar nada é pedido desperdiçado em todo login.
    if (Notification.permission === 'denied') return;

    const jaDispensou = conviteFoiDispensado();
    if (Notification.permission !== 'granted' && jaDispensou) return;

    const estado = await pedirJson('/api/aparelhos').catch(() => null);
    if (!estado?.disponivel || !estado.chave_publica) return;
    avisosDisponiveis = estado;

    // ATENÇÃO ao caso do balcão: a inscrição é do NAVEGADOR, não da pessoa.
    // Se A ativou os avisos e depois B entra no mesmo computador, a inscrição
    // que existe aqui é a de A — e, desde que o aviso passou a levar nome do
    // paciente, deixá-la como está faria este aparelho mostrar a B as
    // notificações de A. Por isso, com a permissão já concedida, a inscrição é
    // sempre REENVIADA: o servidor passa a posse para quem está logado agora
    // (ON CONFLICT (endpoint) DO UPDATE SET usuario_id).
    if (Notification.permission === 'granted') {
      await ligarAvisosDoCelular({ silencioso: true });
      return;
    }

    if (jaDispensou) return;
    convite.hidden = false;
  } catch {
    // Sem avisos o CRM funciona igual: nada aqui pode atrapalhar quem entrou.
  }
}

seletor('#convite-avisos-ligar')?.addEventListener('click', async (evento) => {
  const botao = evento.currentTarget;
  // Dois cliques rápidos disparariam dois pedidos de permissão e duas
  // inscrições concorrentes.
  if (botao.disabled) return;
  botao.disabled = true;

  try {
    const { ligado, motivo } = await ligarAvisosDoCelular();
    const convite = seletor('#convite-avisos');

    // A faixa só some quando a inscrição ACONTECEU. Antes ela sumia de
    // qualquer jeito — inclusive quando a pessoa só fechava a caixa de
    // permissão do navegador —, e o recado de erro ia para dentro de Meu
    // perfil, que está escondido: a pessoa ficava convencida de que tinha
    // ligado os avisos sem nenhuma inscrição existir.
    if (ligado) {
      if (convite) convite.hidden = true;
      return;
    }

    const recado = seletor('#convite-avisos-erro');
    if (recado) {
      recado.hidden = false;
      recado.textContent = motivo || 'Não consegui ligar os avisos neste aparelho.';
    }
  } finally {
    botao.disabled = false;
  }
});

seletor('#convite-avisos-depois')?.addEventListener('click', dispensarConviteDeAvisos);
