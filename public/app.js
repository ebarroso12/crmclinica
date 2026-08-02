'use strict';

// Interface do crmclinica. Só lê a API pública do próprio domínio (/api/resumo);
// nenhuma credencial trafega pelo navegador e nenhum dado de paciente é carregado aqui.

const TITULOS = {
  painel: 'Hoje',
  conversas: 'Conversas',
  leads: 'Leads',
  agenda: 'Agenda',
  serena: 'Serena',
  auditoria: 'Auditoria',
};

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

  document.querySelector('#titulo').textContent = TITULOS[tela];
  document.title = `${TITULOS[tela]} · crmclinica`;
}

for (const gatilho of document.querySelectorAll('[data-tela]')) {
  gatilho.addEventListener('click', () => abrirTela(gatilho.dataset.tela));
}

function atualizarRelogio() {
  document.querySelector('#hora').textContent = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());
}

// Traduz o estado técnico devolvido pela API em algo que a equipe entende de relance.
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

function aplicarEstado(seletor, chave) {
  const alvo = document.querySelector(seletor);
  if (!alvo) return;
  const [rotulo, classe] = LEGENDAS[chave] || [String(chave), ''];
  alvo.textContent = rotulo;
  alvo.className = `estado ${classe}`.trim();
}

function definirTexto(seletor, valor) {
  const alvo = document.querySelector(seletor);
  if (alvo) alvo.textContent = valor;
}

async function carregarResumo() {
  try {
    const resposta = await fetch('/api/resumo', { headers: { accept: 'application/json' } });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const resumo = await resposta.json();

    const { pendentes, leadsHoje, consultasHoje, escalonamentos } = resumo.indicadores;
    definirTexto('#metrica-pendentes', pendentes);
    definirTexto('#metrica-leads', leadsHoje);
    definirTexto('#metrica-consultas', consultasHoje);
    definirTexto('#metrica-escalonamentos', escalonamentos);
    definirTexto('#fila-topo', `${pendentes} pendentes`);
    definirTexto('#contador-conversas', pendentes);

    const { orquestrador, atendimento, inbox, fonteDeVerdade } = resumo.plataforma;
    aplicarEstado('#saude-orquestrador', orquestrador.saude);
    aplicarEstado('#saude-atendimento', atendimento.integracao);
    aplicarEstado('#saude-inbox', inbox?.saude ?? 'ausente');
    aplicarEstado('#saude-crm', fonteDeVerdade.banco === 'configurado' ? 'operacional' : 'ausente');

    const pilula = document.querySelector('#estado-serena');
    if (pilula) {
      pilula.textContent = atendimento.integracao === 'configurada' ? 'Ativa' : 'Aguardando integração';
    }
  } catch {
    for (const seletor of ['#saude-orquestrador', '#saude-atendimento', '#saude-inbox', '#saude-crm']) {
      aplicarEstado(seletor, 'indisponivel');
    }
    definirTexto('#fila-topo', 'sem dados');
  }
}

// ---------------------------------------------------------------------------
// Inbox: as conversas vivem no Chatwoot. A interface só fala com a API do
// crmclinica — nenhum token do Chatwoot chega ao navegador.
// ---------------------------------------------------------------------------

let filaAtual = 'nao_atribuidas';
let conversaAberta = null;

async function pedirJson(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: { accept: 'application/json', ...(opcoes.corpo ? { 'content-type': 'application/json' } : {}) },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  if (!resposta.ok) {
    const erro = new Error(`HTTP ${resposta.status}`);
    erro.status = resposta.status;
    throw erro;
  }
  return resposta.json();
}

function iniciais(nome) {
  return (nome || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((parte) => parte[0] || '')
    .join('')
    .toUpperCase();
}

function avisar(elemento, mensagem) {
  elemento.innerHTML = '';
  const linha = document.createElement('li');
  linha.className = 'vazio';
  linha.textContent = mensagem;
  elemento.append(linha);
}

async function carregarConversas() {
  const lista = document.querySelector('#lista-conversas');
  if (!lista) return;

  try {
    const dados = await pedirJson(`/api/conversas?fila=${encodeURIComponent(filaAtual)}`);
    if (dados.conversas.length === 0) {
      avisar(lista, 'Nenhuma conversa nesta fila.');
      return;
    }

    lista.innerHTML = '';
    for (const conversa of dados.conversas) {
      const linha = document.createElement('li');
      linha.dataset.conversa = conversa.id;
      linha.tabIndex = 0;
      linha.setAttribute('role', 'button');

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = iniciais(conversa.contato?.nome);

      const texto = document.createElement('span');
      texto.className = 'linha-texto';
      const nome = document.createElement('b');
      nome.textContent = conversa.contato?.nome || conversa.contato?.telefone || `Conversa ${conversa.id}`;
      const previa = document.createElement('small');
      previa.textContent = conversa.ultimaMensagem || 'Sem mensagens';
      texto.append(nome, previa);

      linha.append(avatar, texto);

      if (conversa.responsavel) {
        const etiqueta = document.createElement('span');
        etiqueta.className = 'etiqueta amarela';
        etiqueta.textContent = 'Humano';
        linha.append(etiqueta);
      }

      const abrir = () => abrirConversa(conversa.id);
      linha.addEventListener('click', abrir);
      linha.addEventListener('keydown', (evento) => {
        if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); abrir(); }
      });

      lista.append(linha);
    }
  } catch (erro) {
    avisar(lista, erro.status === 503 ? 'Inbox ainda não configurado.' : 'Não foi possível carregar as conversas.');
  }
}

function alternarAcoes(habilitado) {
  for (const controle of document.querySelectorAll('.acoes-conversa .acao, #form-resposta input, #form-resposta button')) {
    controle.disabled = !habilitado;
  }
}

async function abrirConversa(conversaId) {
  conversaAberta = conversaId;
  const thread = document.querySelector('#thread-mensagens');

  try {
    const { conversa, mensagens, ficha, lead } = await pedirJson(`/api/conversas/${conversaId}`);

    definirTexto('#thread-nome', conversa.contato?.nome || `Conversa ${conversa.id}`);
    definirTexto('#thread-detalhe', `${lead.origem} · ${conversa.estado} · lead ${lead.temperatura}`);

    thread.innerHTML = '';
    for (const mensagem of mensagens) {
      if (mensagem.privada) continue;
      const item = document.createElement('li');
      item.className = mensagem.autor === 'contato' ? 'recebida' : 'enviada';
      item.textContent = mensagem.texto;
      thread.append(item);
    }

    definirTexto('#ficha-nome', ficha?.nome || '—');
    definirTexto('#ficha-canal', `${lead.origem} · ${conversa.estado}`);
    definirTexto('#ficha-telefone', ficha?.telefone || '—');
    definirTexto('#ficha-identificador', ficha?.identificador || '—');
    definirTexto('#ficha-etiquetas', conversa.etiquetas?.join(', ') || 'sem etiquetas');
    definirTexto('#ficha-notas', ficha?.notas?.map((nota) => nota.texto).join(' · ') || 'sem notas');
    definirTexto('#ficha-anteriores', ficha?.conversas_anteriores?.length
      ? `${ficha.conversas_anteriores.length} conversa(s)`
      : 'nenhuma');

    const seletorTemperatura = document.querySelector('#seletor-temperatura');
    if (seletorTemperatura) seletorTemperatura.value = lead.temperatura || '';

    alternarAcoes(true);
  } catch (erro) {
    thread.innerHTML = '';
    definirTexto('#thread-nome', 'Não foi possível abrir');
    definirTexto('#thread-detalhe', erro.status === 503 ? 'Inbox não configurado.' : 'Tente novamente.');
    alternarAcoes(false);
  }
}

async function agirNaConversa(caminho, corpo) {
  if (!conversaAberta) return;
  try {
    await pedirJson(`/api/conversas/${conversaAberta}/${caminho}`, { method: 'POST', corpo });
    await abrirConversa(conversaAberta);
    await carregarConversas();
  } catch {
    definirTexto('#thread-detalhe', 'A ação não pôde ser concluída.');
  }
}

async function carregarLeads() {
  const kanban = document.querySelector('#kanban-leads');
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
        item.textContent = lead.nome || lead.telefone || 'Lead sem nome';
        const detalhe = document.createElement('small');
        detalhe.textContent = `${lead.origem} · ${lead.temperatura}`;
        item.append(detalhe);
        lista.append(item);
      }

      secao.append(titulo, lista);
      kanban.append(secao);
    }
  } catch (erro) {
    kanban.textContent = erro.status === 503
      ? 'Inbox ainda não configurado.'
      : 'Não foi possível carregar os leads.';
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

document.querySelector('#form-resposta')?.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const campo = document.querySelector('#resposta');
  const texto = campo.value.trim();
  if (!texto) return;

  campo.value = '';
  await agirNaConversa('mensagens', { texto });
});

for (const botao of document.querySelectorAll('.acoes-conversa .acao[data-acao]')) {
  botao.addEventListener('click', () => {
    const acoes = {
      // "Assumir" entrega a conversa ao time da clínica — e a automação para.
      assumir: () => agirNaConversa('atribuicao', { time_id: Number(botao.dataset.timeId) || undefined }),
      resolver: () => agirNaConversa('estado', { estado: 'resolved' }),
      reabrir: () => agirNaConversa('estado', { estado: 'open' }),
    };
    acoes[botao.dataset.acao]?.();
  });
}

document.querySelector('#seletor-prioridade')?.addEventListener('change', (evento) => {
  if (evento.target.value) agirNaConversa('prioridade', { prioridade: evento.target.value });
});

document.querySelector('#seletor-temperatura')?.addEventListener('change', (evento) => {
  if (evento.target.value) agirNaConversa('temperatura', { temperatura: evento.target.value });
});

atualizarRelogio();
setInterval(atualizarRelogio, 30000);

carregarResumo();
setInterval(carregarResumo, 60000);

carregarConversas();
carregarLeads();
setInterval(carregarConversas, 30000);
