'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const {
  PAGAMENTOS, URGENCIAS, DISPONIBILIDADES, PERGUNTAS, proximaAcao, calcularScore,
} = require('../dominio/qualificacao');
const { ETAPAS, DESCRICAO, TRANSICOES, resumir } = require('../dominio/jornada');
const { TEMPERATURAS } = require('../dominio/conversas');

// API de qualificação e jornada do lead.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function exigirEnum(valor, campo, permitidos) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!permitidos.includes(bruto)) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um de: ${permitidos.join(', ')}`, campo);
  }
  return bruto;
}

function criarRotasDeLeads({ repositorio, leads }) {
  return {
    /** GET /api/leads/vocabulario — o que a interface precisa para montar os controles. */
    async vocabulario(usuario) {
      exigirPermissao(usuario, 'leads:ler');

      return {
        etapas: ETAPAS.map((etapa) => ({ etapa, ...DESCRICAO[etapa] })),
        transicoes: TRANSICOES,
        pagamentos: PAGAMENTOS,
        urgencias: URGENCIAS,
        disponibilidades: DISPONIBILIDADES,
        temperaturas: TEMPERATURAS,
        perguntas: PERGUNTAS,
      };
    },

    /** GET /api/leads/:id — qualificação, score explicado, próxima ação e jornada. */
    async obter(usuario, leadId) {
      exigirPermissao(usuario, 'leads:ler');
      const id = exigirIdentificador(leadId, 'lead_id');

      const retrato = await leads.descrever(id);
      if (!retrato) {
        const erro = new Error('lead não encontrado');
        erro.status = 404;
        throw erro;
      }

      return { ...retrato, resumo_da_jornada: resumir(retrato.jornada) };
    },

    /** POST /api/leads/:id/qualificacao — grava o que se descobriu. */
    async qualificar(usuario, leadId, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const id = exigirIdentificador(leadId, 'lead_id');

      // Vocabulário fechado nos campos que têm lista: valor torto não é gravado
      // "só para não perder a informação".
      if (corpo?.pagamento !== undefined) exigirEnum(corpo.pagamento, 'pagamento', PAGAMENTOS);
      if (corpo?.urgencia !== undefined) exigirEnum(corpo.urgencia, 'urgencia', URGENCIAS);
      if (corpo?.disponibilidade !== undefined) {
        exigirEnum(corpo.disponibilidade, 'disponibilidade', DISPONIBILIDADES);
      }
      if (corpo?.primeira_consulta !== undefined && typeof corpo.primeira_consulta !== 'boolean') {
        throw new ErroDeContrato('campo "primeira_consulta" deve ser booleano', 'primeira_consulta');
      }

      const resultado = await leads.qualificar(id, corpo ?? {}, {
        conversaId: corpo?.conversa_id ?? null,
        origem: 'equipe',
        usuarioId: usuario.id,
      });

      return {
        lead: resultado.lead,
        alterados: resultado.alterados,
        pendentes: resultado.pendentes ?? [],
        proxima_pergunta: resultado.proxima,
        proxima_acao: proximaAcao(resultado.lead),
      };
    },

    /** POST /api/leads/:id/estagio — move na jornada. */
    async moverEstagio(usuario, leadId, corpo) {
      exigirPermissao(usuario, 'conversas:responder');
      const id = exigirIdentificador(leadId, 'lead_id');
      const para = exigirEnum(corpo?.estagio, 'estagio', ETAPAS);

      const resultado = await leads.moverEstagio(id, para, {
        conversaId: corpo?.conversa_id ?? null,
        origem: 'equipe',
        usuarioId: usuario.id,
        motivo: corpo?.motivo ?? null,
      });

      return { ...resultado, proxima_acao: proximaAcao(resultado.lead) };
    },

    /** POST /api/leads/:id/temperatura — fixa na mão; o cálculo para de mexer. */
    async definirTemperatura(usuario, leadId, corpo) {
      exigirPermissao(usuario, 'conversas:etiquetar');
      const id = exigirIdentificador(leadId, 'lead_id');
      const temperatura = exigirEnum(corpo?.temperatura, 'temperatura', TEMPERATURAS);

      const lead = await leads.definirTemperaturaManual(id, temperatura, {
        conversaId: corpo?.conversa_id ?? null,
        usuarioId: usuario.id,
      });

      return { lead, temperatura, manual: true };
    },

    /** GET /api/leads/:id/jornada — o histórico completo. */
    async jornada(usuario, leadId) {
      exigirPermissao(usuario, 'leads:ler');
      const id = exigirIdentificador(leadId, 'lead_id');

      const eventos = await repositorio.listarEventosDoLead(id, { limite: 200 });
      return { eventos, resumo: resumir(eventos) };
    },

    /** Enriquece o kanban com score, próxima ação e o que falta perguntar. */
    async listarParaKanban() {
      const lista = await repositorio.listarLeads();

      return lista.map((lead) => {
        const { score } = calcularScore(lead);
        return {
          ...lead,
          score,
          proxima_acao: proximaAcao(lead),
        };
      });
    },
  };
}

module.exports = { criarRotasDeLeads };
