'use strict';

// Resumo operacional exibido no painel "Hoje".
// Enquanto o CRM não estiver ligado ao banco, os números vêm daqui e são marcados
// como demonstração — nenhuma linha deste arquivo toca dado real de paciente.

const { descreverConfiguracao } = require('../config');

const DEMONSTRACAO = Object.freeze({
  pendentes: 8,
  leadsHoje: 12,
  consultasHoje: 6,
  escalonamentos: 2,
});

/**
 * Monta o resumo operacional.
 * @param {object} configuracao configuração já carregada
 * @param {object} saudeOrquestrador estado devolvido pelo cliente OpenClaw
 */
function montarResumo(configuracao, saudeOrquestrador = { estado: 'nao_configurado' }) {
  const descricao = descreverConfiguracao(configuracao);

  return {
    origem: configuracao.banco.configurado ? 'crm' : 'demonstracao',
    atualizadoEm: new Date().toISOString(),
    indicadores: { ...DEMONSTRACAO },
    canais: [
      { nome: 'WhatsApp', estado: 'operacional' },
      { nome: 'Instagram', estado: 'operacional' },
      { nome: 'Site', estado: 'operacional' },
    ],
    plataforma: {
      orquestrador: { ...descricao.orquestrador, saude: saudeOrquestrador.estado },
      atendimento: descricao.atendimento,
      provedorModelo: descricao.provedorModelo,
      fonteDeVerdade: { nome: 'CRM', banco: descricao.banco },
    },
  };
}

module.exports = { montarResumo, DEMONSTRACAO };
