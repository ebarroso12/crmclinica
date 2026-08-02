'use strict';

// Resumo operacional exibido no painel "Hoje".
//
// Todos os números vêm do inbox. Indicador que ainda não tem fonte devolve `null`,
// e a interface mostra "—": misturar número real com número inventado na mesma
// linha é pior que não mostrar nada, porque a equipe não sabe em qual confiar.

const { descreverConfiguracao } = require('../config');

function ehDeHoje(instante, agora = new Date()) {
  if (!instante) return false;
  const data = new Date(instante);
  if (Number.isNaN(data.getTime())) return false;
  return data.toDateString() === agora.toDateString();
}

/**
 * Calcula os indicadores a partir do que está no inbox.
 * @param {object[]} conversas conversas carregadas do repositório
 * @param {object[]} leads leads carregados do repositório
 */
function calcularIndicadores(conversas = [], leads = []) {
  return {
    // Conversa aberta ou pendente é conversa que espera alguém.
    pendentes: conversas.filter((conversa) => conversa.status !== 'resolvida').length,
    leadsHoje: leads.filter((lead) => ehDeHoje(lead.atualizado_em)).length,
    // Escalonamento é conversa que a automação entregou à equipe.
    escalonamentos: conversas.filter((conversa) => conversa.assumida_por_humano).length,
    // Sem agenda implementada, não há o que contar — e inventar seria mentir.
    consultasHoje: null,
  };
}

/**
 * Monta o resumo operacional.
 * @param {object} configuracao configuração já carregada
 * @param {object} saudeOrquestrador estado devolvido pelo cliente OpenClaw
 * @param {object} saudeInbox estado do repositório
 * @param {object} dados conversas e leads já lidos do repositório
 */
function montarResumo(
  configuracao,
  saudeOrquestrador = { estado: 'nao_configurado' },
  saudeInbox = { estado: 'nao_configurado' },
  dados = { conversas: [], leads: [] },
) {
  const descricao = descreverConfiguracao(configuracao);

  return {
    // Sem banco, o inbox roda em memória e nada persiste — a interface avisa.
    origem: configuracao.banco.configurado ? 'banco' : 'memoria',
    atualizadoEm: new Date().toISOString(),
    indicadores: calcularIndicadores(dados.conversas, dados.leads),
    plataforma: {
      orquestrador: { ...descricao.orquestrador, saude: saudeOrquestrador.estado },
      atendimento: descricao.atendimento,
      inbox: { ...descricao.inbox, saude: saudeInbox.estado },
      provedorModelo: descricao.provedorModelo,
      fonteDeVerdade: { nome: 'CRM', banco: descricao.banco },
    },
  };
}

module.exports = { montarResumo, calcularIndicadores };
