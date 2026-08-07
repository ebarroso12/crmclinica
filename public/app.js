'use strict';

// Interface do crmclinica. Fala só com a API do próprio domínio; nenhuma credencial
// trafega pelo navegador. O inbox é local: conversa e mensagem vêm do banco do produto.

const TITULOS = {
  painel: 'Hoje',
  conversas: 'Conversas',
  leads: 'Leads',
  agenda: 'Agenda',
  serena: 'Serena',
  contatos: 'Contatos',
  auditoria: 'Auditoria',
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
    const ativo = botao.dataset.tela === tela;
    if (ativo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }

  seletor('#titulo').textContent = TITULOS[tela];
  document.title = `${TITULOS[tela]} · crmclinica`;

  if (tela === 'conversas') carregarConversas();
  if (tela === 'leads') carregarLeads();
  if (tela === 'agenda') carregarAgenda();
  if (tela === 'serena') carregarSerena();
  if (tela === 'contatos') carregarContatos();
  if (tela === 'auditoria') carregarAuditoria();
  if (tela === 'usuarios') carregarUsuarios();
  if (tela === 'perfil') desenharPerfil();
}

for (const gatilho of document.querySelectorAll('nav [data-tela]')) {
  gatilho.addEventListener('click', () => abrirTela(gatilho.dataset.tela));
}

function atualizarRelogio() {
  seletor('#hora').textContent = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());
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
// Sessão da equipe.
//
// O access token fica só em memória: em `localStorage` ele sobreviveria à aba e
// ficaria legível por qualquer script injetado. O refresh vai para `sessionStorage`
// para que um F5 não derrube a recepção no meio do plantão.
// ---------------------------------------------------------------------------

let accessToken = null;
let usuarioAtual = null;
let cursorAuditoria = null;

const CHAVE_REFRESH = 'crmclinica.refresh';

function guardarSessao(sessao) {
  accessToken = sessao.access_token;
  usuarioAtual = sessao.usuario;
  try {
    sessionStorage.setItem(CHAVE_REFRESH, sessao.refresh_token);
  } catch {
    // Navegador com armazenamento bloqueado: a sessão vale enquanto a página viver.
  }
}

function lerRefresh() {
  try {
    return sessionStorage.getItem(CHAVE_REFRESH);
  } catch {
    return null;
  }
}

function limparSessao() {
  accessToken = null;
  usuarioAtual = null;
  try {
    sessionStorage.removeItem(CHAVE_REFRESH);
  } catch {
    // nada a fazer
  }
}

function podeFazer(permissao) {
  return Boolean(usuarioAtual?.permissoes?.includes(permissao));
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
      erro.detalhe = (await resposta.json()).erro;
    } catch {
      erro.detalhe = null;
    }
    throw erro;
  }
  return resposta.json();
}

async function renovarSessao() {
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
    limparSessao();
    mostrarPortao();
    return false;
  }
}

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

    const { orquestrador, atendimento, inbox, fonteDeVerdade } = resumo.plataforma;
    aplicarEstado('#saude-orquestrador', orquestrador.saude);
    aplicarEstado('#saude-atendimento', atendimento.integracao);
    aplicarEstado('#saude-inbox', inbox?.saude ?? 'ausente');
    aplicarEstado('#saude-crm', fonteDeVerdade.banco === 'configurado' ? 'operacional' : 'ausente');

    const pilula = seletor('#estado-serena');
    if (pilula) pilula.textContent = atendimento.integracao === 'configurada' ? 'Ativa' : 'Aguardando integração';
  } catch {
    for (const alvo of ['#saude-orquestrador', '#saude-atendimento', '#saude-inbox', '#saude-crm']) {
      aplicarEstado(alvo, 'indisponivel');
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox: lista à esquerda, thread no centro, ficha à direita.
// ---------------------------------------------------------------------------

let filaAtual = 'todos';
let conversaAberta = null;
let contatoAberto = null;
let etiquetasDisponiveis = [];

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

  const parametros = new URLSearchParams({ fila: filaAtual });
  const busca = seletor('#busca-conversas')?.value.trim();
  if (busca) parametros.set('busca', busca);

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

    desenharFilaDeHoje(dados.conversas);
  } catch (erro) {
    avisar(lista, erro.status === 503 ? 'Inbox indisponível.' : 'Não foi possível carregar as conversas.');
  }
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

    definirTexto('#thread-nome', conversa.contato?.nome || `Conversa ${conversa.id}`);
    definirTexto(
      '#thread-detalhe',
      `${conversa.canal} · ${conversa.status}${conversa.prioridade ? ` · ${conversa.prioridade}` : ''}`,
    );

    // A pausa da IA é a informação mais importante da tela: quem responde agora?
    const aviso = seletor('#aviso-ia');
    aviso.hidden = !conversa.assumida_por_humano;
    aviso.textContent = conversa.assumida_por_humano
      ? 'Conversa assumida pela equipe. A resposta automática está pausada.'
      : '';
    seletor('.acao[data-acao="assumir"]').hidden = conversa.assumida_por_humano;
    seletor('.acao[data-acao="liberar"]').hidden = !conversa.assumida_por_humano;

    desenharThread(mensagens);
    desenharFicha(conversa, ficha, detalhe.temperatura);

    seletor('#seletor-prioridade').value = conversa.prioridade || '';
    seletor('#seletor-temperatura').value = detalhe.temperatura || '';
    alternarAcoes(true);

    // Sem `await`: a agenda do paciente é apoio, e a thread não deve esperar
    // por ela para aparecer.
    carregarAgendaDaConversa(conversaId);
  } catch (erro) {
    seletor('#thread-mensagens').innerHTML = '';
    definirTexto('#thread-nome', 'Não foi possível abrir');
    definirTexto('#thread-detalhe', erro.status === 404 ? 'Conversa não encontrada.' : 'Tente novamente.');
    alternarAcoes(false);
  }
}

function desenharThread(mensagens) {
  const thread = seletor('#thread-mensagens');
  thread.innerHTML = '';

  for (const mensagem of mensagens) {
    const item = document.createElement('li');

    if (mensagem.tipo === 'sistema') {
      item.className = 'balao-sistema';
      item.textContent = mensagem.conteudo || '';
      thread.append(item);
      continue;
    }

    item.className = mensagem.direcao === 'entrada' ? 'recebida' : 'enviada';
    if (mensagem.privada) item.classList.add('privada');

    const corpo = document.createElement('span');
    corpo.textContent = mensagem.conteudo || '';

    const rodape = document.createElement('small');
    const autor = mensagem.autor_tipo === 'automacao' ? 'Serena' : mensagem.autor_nome || '';
    rodape.textContent = [mensagem.privada ? 'nota interna' : autor, hora(mensagem.criado_em)]
      .filter(Boolean)
      .join(' · ');

    item.append(corpo, rodape);
    thread.append(item);
  }

  thread.scrollTop = thread.scrollHeight;
}

function desenharFicha(conversa, ficha, temperatura) {
  definirTexto('#ficha-nome', ficha?.nome || 'Sem nome');
  definirTexto('#ficha-canal', `${conversa.canal}${temperatura ? ` · lead ${temperatura}` : ''}`);
  definirTexto('#ficha-telefone', ficha?.telefone || '—');
  definirTexto('#ficha-identificador', ficha?.identificador || '—');
  definirTexto('#ficha-email', ficha?.email || '—');
  seletor('#editar-ficha').hidden = !podeFazer('contatos:editar');

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
        detalhe.textContent = `${lead.origem} · ${lead.temperatura}`;
        botao.append(detalhe);

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

let buscaAgendada = null;
seletor('#busca-conversas')?.addEventListener('input', () => {
  clearTimeout(buscaAgendada);
  buscaAgendada = setTimeout(carregarConversas, 300);
});

seletor('#form-resposta')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const campo = seletor('#resposta');
  const texto = campo.value.trim();
  if (!texto) return;

  campo.value = '';
  await agir('mensagens', { texto });
});

seletor('#botao-nota')?.addEventListener('click', async () => {
  const campo = seletor('#resposta');
  const texto = campo.value.trim();
  if (!texto) return;

  campo.value = '';
  await agir('notas', { texto });
});

for (const botao of document.querySelectorAll('.acoes-conversa .acao[data-acao]')) {
  botao.addEventListener('click', () => {
    const acoes = {
      assumir: () => agir('assumir', {}),
      liberar: () => agir('assumir', { liberar: true }),
      resolver: () => agir('estado', { status: 'resolvida' }),
      reabrir: () => agir('estado', { status: 'aberta' }),
    };
    acoes[botao.dataset.acao]?.();
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

function mostrarAplicacao() {
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

  // A aba de usuários é do administrador master.
  const itemUsuarios = seletor('#item-usuarios');
  if (itemUsuarios) itemUsuarios.hidden = !usuarioAtual?.master;

  // O inbox começa a carregar de qualquer forma: a faixa de saúde não pode ficar
  // em "verificando…" só porque a pessoa foi levada ao perfil.
  iniciarInbox();

  // Senha provisória: leva direto ao perfil, e o aviso fica visível até trocar.
  const precisaTrocar = Boolean(usuarioAtual?.precisa_trocar_senha);
  const aviso = seletor('#aviso-trocar-senha');
  if (aviso) aviso.hidden = !precisaTrocar;

  if (precisaTrocar) abrirTela('perfil');

  if (usuarioAtual?.master) carregarUsuarios();
}

let inboxIniciado = false;
function iniciarInbox() {
  if (inboxIniciado) return;
  inboxIniciado = true;

  carregarResumo();
  setInterval(carregarResumo, 60000);

  carregarEtiquetas().then(() => {
    carregarConversas();
    carregarLeads();
  });
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

    const recuperar = document.querySelector('[data-portao="recuperar"]');
    if (recuperar) recuperar.hidden = !opcoes.recuperacao_por_email;
  } catch {
    // Sem as opções, a entrada por e-mail e senha continua funcionando.
  }
}

seletor('#sair')?.addEventListener('click', async () => {
  const refresh = lerRefresh();
  limparSessao();

  if (refresh) {
    // Encerrar do lado do servidor é o que revoga de verdade.
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    }).catch(() => {});
  }
  mostrarPortao();
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
  } catch (erro) {
    avisar(lista, erro.status === 403 ? 'Apenas o administrador master vê esta lista.' : 'Não foi possível carregar.');
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
    await pedirJson('/api/usuarios', { metodo: 'POST', corpo });
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
    setTimeout(() => {
      limparSessao();
      mostrarPortao('Senha alterada. Entre com a senha nova.');
    }, 1500);
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

  // Um F5 no meio do plantão não deve pedir senha de novo.
  if (lerRefresh() && await renovarSessao()) mostrarAplicacao();
  else mostrarPortao();
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

async function carregarSerena() {
  try {
    const dados = await pedirJson('/api/serena');
    serenaPainel = dados;

    desenharEstadoDaSerena(dados);

    const controle = seletor('#serena-controle');
    if (controle) controle.hidden = !dados.pode_gerenciar;
    const cartaoDeHorario = seletor('#serena-horario-card');
    if (cartaoDeHorario) cartaoDeHorario.hidden = !dados.pode_gerenciar;
    // Testar o prompt é mexer no que a clínica diz ao paciente: mesma permissão
    // de quem publica a versão.
    const cartaoDeTeste = seletor('#serena-teste-card');
    if (cartaoDeTeste) {
      cartaoDeTeste.hidden = !dados.pode_gerenciar;
      // A lista de modelos precisa existir antes da primeira mensagem: quem vai
      // testar escolhe o modelo primeiro, não depois de já ter conversado.
      if (dados.pode_gerenciar) carregarModelosDoTeste().catch(() => {});
    }
    // A varredura mostra o estado interno da infraestrutura — nome do usuário do
    // banco, serviços parados. Quem atende paciente não precisa disso.
    const cartaoDeDiagnostico = seletor('#diagnostico-card');
    if (cartaoDeDiagnostico) cartaoDeDiagnostico.hidden = !dados.pode_gerenciar;
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

async function alternarSerena(ativa) {
  const motivo = ativa ? null : prompt('Motivo do desligamento (obrigatório):');
  if (!ativa && !motivo) return;

  try {
    await pedirJson('/api/serena/estado', { metodo: 'POST', corpo: { ativa, motivo } });
    informar(ativa ? 'Serena ligada.' : 'Serena desligada — as mensagens continuam sendo gravadas.');
    await carregarSerena();
  } catch (erro) {
    informar(`Não foi possível alterar: ${erro.message}`);
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
// Contatos: a base de pacientes. Excluir é soft delete — o histórico fica.
// ---------------------------------------------------------------------------

let contatoEmEdicao = null;

async function carregarContatos() {
  const busca = seletor('#contatos-busca')?.value ?? '';
  const excluidos = seletor('#contatos-excluidos')?.checked ? 'sim' : 'nao';

  try {
    const dados = await pedirJson(`/api/contatos/gestao?busca=${encodeURIComponent(busca)}&excluidos=${excluidos}`);
    const lista = seletor('#lista-contatos');
    const total = seletor('#contatos-total');

    if (total) total.textContent = `${dados.total} contato(s)`;
    if (!lista) return;

    if (dados.contatos.length === 0) {
      lista.innerHTML = '<li class="vazio">Nenhum contato encontrado.</li>';
      return;
    }

    lista.innerHTML = dados.contatos.map((contato) => `
      <li class="${contato.excluido ? 'desligada' : ''}">
        <div>
          <strong>${escapar(contato.nome ?? 'sem nome')}</strong>
          <small>${contato.telefone} · ${contato.conversas ?? 0} conversa(s) ·
            ${contato.agendamentos ?? 0} agendamento(s)
            ${contato.recebe_lembretes ? '' : ' · não recebe lembretes'}
            ${contato.excluido ? ` · excluído em ${new Date(contato.excluido_em).toLocaleDateString('pt-BR')}` : ''}</small>
        </div>
        <div class="linha-acoes">
          ${contato.excluido
            ? `<button type="button" class="secundario" data-restaurar-contato="${contato.id}">Restaurar</button>`
            : `<button type="button" class="secundario" data-ver-contato="${contato.id}">Histórico</button>
               <button type="button" class="secundario" data-editar-contato="${contato.id}">Editar</button>
               <button type="button" class="perigo" data-excluir-contato="${contato.id}">Excluir</button>`}
        </div>
      </li>`).join('');
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
    const linhas = [
      `${contato.nome ?? 'sem nome'} — ${contato.telefone}`,
      '',
      `Conversas: ${historico.conversas.length}`,
      ...historico.conversas.slice(0, 5).map((c) => `  · ${c.status} — ${c.previa ?? 'sem mensagem'}`),
      '',
      `Agendamentos: ${historico.agendamentos.length}`,
      ...historico.agendamentos.slice(0, 5).map((a) => `  · ${new Date(a.inicio).toLocaleString('pt-BR')} — ${a.status}`),
    ];
    alert(linhas.join('\n'));
  } catch (erro) {
    informar(`Não foi possível abrir o histórico: ${erro.message}`);
  }
}

// ---------------------------------------------------------------- eventos

document.addEventListener('click', async (evento) => {
  const alvo = evento.target.closest('button');
  if (!alvo) return;

  try {
    if (alvo.id === 'serena-ligar') await alternarSerena(true);
    if (alvo.id === 'serena-desligar') await alternarSerena(false);
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

function desenharGradeDeHorario(agenda) {
  const grade = seletor('#horario-grade');
  if (!grade) return;

  grade.replaceChildren(...DIAS_DA_SEMANA.map((nome, dia) => {
    const janelas = agenda?.dias?.[String(dia)] ?? [];
    const linha = criarElemento('div', { classe: 'horario-dia' });
    linha.append(criarElemento('span', { texto: nome, classe: 'horario-nome' }));

    // Uma faixa por dia cobre o caso real da clínica. Duas faixas (almoço) o
    // banco e a API aceitam; a tela mostra a primeira e preserva o resto ao
    // salvar, para não apagar em silêncio o que alguém configurou pela API.
    const [inicio = '', fim = ''] = janelas[0] ?? [];
    for (const [classe, valor] of [['inicio', inicio], ['fim', fim]]) {
      const campo = document.createElement('input');
      campo.type = 'time';
      campo.className = `horario-${classe}`;
      campo.dataset.dia = String(dia);
      campo.value = valor;
      linha.append(campo);
    }

    if (janelas.length > 1) {
      linha.append(criarElemento('span', {
        texto: `+${janelas.length - 1} faixa(s) definidas pela API`, classe: 'nota',
      }));
    }
    return linha;
  }));
}

/** Lê a grade da tela. Faixa pela metade é erro, não meia-configuração. */
function lerGradeDaTela() {
  const anterior = serenaPainel?.horario?.agenda?.dias ?? {};
  const dias = {};

  for (let dia = 0; dia <= 6; dia += 1) {
    const inicio = seletor(`.horario-inicio[data-dia="${dia}"]`)?.value ?? '';
    const fim = seletor(`.horario-fim[data-dia="${dia}"]`)?.value ?? '';

    if (!inicio && !fim) { dias[String(dia)] = []; continue; }
    if (!inicio || !fim) {
      throw new Error(`${DIAS_DA_SEMANA[dia]}: preencha o início e o fim, ou deixe os dois vazios`);
    }

    // As faixas extras que só existem pela API seguem intactas.
    dias[String(dia)] = [[inicio, fim], ...(anterior[String(dia)] ?? []).slice(1)];
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

/** Pausa, retomada e plantão: uma chamada, e a tela se redesenha com a resposta. */
async function mexerNoAtendimento(caminho, opcoes) {
  try {
    const { horario } = await pedirJson(caminho, opcoes);
    if (serenaPainel) serenaPainel.horario = horario;
    desenharHorario(horario);
  } catch (erro) {
    informar(erro.detalhe ?? `não foi possível: ${erro.message}`);
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

async function desenharEstadoDoCanal() {
  const descricao = seletor('#canal-descricao');
  const acoes = seletor('#canal-acoes');
  if (!descricao) return;

  try {
    const canal = await pedirJson('/api/serena/canal');

    if (!canal.disponivel) {
      descricao.textContent = `conexão indisponível — ${canal.motivo ?? 'gateway não configurado'}`;
      if (acoes) acoes.hidden = true;
      return;
    }

    if (canal.vinculado) {
      descricao.textContent = canal.conectado
        ? `conectado no ${formatarTelefone(canal.numero)}`
        : `vinculado ao ${formatarTelefone(canal.numero)}, mas fora do ar agora`;
    } else {
      descricao.textContent = 'nenhum telefone conectado — os pacientes não são atendidos';
    }

    // Só o master conecta: trocar o telefone muda por onde a clínica atende.
    if (acoes) {
      acoes.hidden = !usuarioAtual?.master;
      const botao = seletor('#canal-conectar');
      if (botao) botao.textContent = canal.vinculado ? 'Reconectar' : 'Conectar WhatsApp';
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
  if (alvo.id === 'serena-pausar') {
    mexerNoAtendimento('/api/serena/pausa', { metodo: 'POST', corpo: { minutos: 15 } });
  }
  if (alvo.id === 'serena-despausar') {
    mexerNoAtendimento('/api/serena/pausa', { metodo: 'DELETE' });
  }
  if (alvo.id === 'serena-plantao') {
    mexerNoAtendimento('/api/serena/plantao', { metodo: 'POST', corpo: { minutos: 60 } });
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
  if (!area) return;

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

      return bloco;
    }));
  } catch (erro) {
    if (resumo) resumo.textContent = `não foi possível verificar: ${erro.message}`;
  } finally {
    if (botao) { botao.disabled = false; botao.textContent = 'Verificar agora'; }
  }
}

seletor('#diagnostico-verificar')?.addEventListener('click', varrerSistema);

/**
 * Move um lead de etapa no funil.
 *
 * Recarrega o quadro depois de gravar, em vez de mexer no DOM na mão: mover o
 * card antes da confirmação mostraria a etapa nova mesmo quando a gravação
 * falha, e aí o funil na tela deixa de ser o funil do banco.
 */
async function moverLead(leadId, estagio) {
  if (!estagio) return;

  const card = document.querySelector(`[data-lead-id="${leadId}"]`);
  if (card?.dataset.estagio === estagio) return; // soltou onde já estava

  try {
    await pedirJson(`/api/leads/${leadId}/estagio`, {
      metodo: 'POST',
      corpo: { estagio },
    });
    await carregarLeads();
  } catch (erro) {
    informar(`Não foi possível mover o lead: ${erro.message}`);
    // Recarrega mesmo em caso de falha: sem isto o card fica onde o navegador o
    // largou, sugerindo uma mudança que o banco recusou.
    await carregarLeads();
  }
}
