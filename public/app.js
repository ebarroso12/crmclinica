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

    const { orquestrador, atendimento, fonteDeVerdade } = resumo.plataforma;
    aplicarEstado('#saude-orquestrador', orquestrador.saude);
    aplicarEstado('#saude-atendimento', atendimento.integracao);
    aplicarEstado('#saude-crm', fonteDeVerdade.banco === 'configurado' ? 'operacional' : 'ausente');

    const pilula = document.querySelector('#estado-serena');
    if (pilula) {
      pilula.textContent = atendimento.integracao === 'configurada' ? 'Ativa' : 'Aguardando integração';
    }
  } catch {
    for (const seletor of ['#saude-orquestrador', '#saude-atendimento', '#saude-crm']) {
      aplicarEstado(seletor, 'indisponivel');
    }
    definirTexto('#fila-topo', 'sem dados');
  }
}

atualizarRelogio();
setInterval(atualizarRelogio, 30000);

carregarResumo();
setInterval(carregarResumo, 60000);
