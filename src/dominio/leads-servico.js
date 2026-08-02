'use strict';

const {
  camposPendentes, proximaPergunta, calcularScore, decidirTemperatura,
  normalizarQualificacao, normalizarOrigem, proximaAcao,
} = require('./qualificacao');
const { estagioSugerido, transicaoPermitida, montarEvento, ErroDeJornada } = require('./jornada');
const { aplicarTemperatura } = require('./conversas');

// Serviço do lead: junta qualificação, score, temperatura e jornada num lugar só,
// e garante que **toda** alteração deixe rastro.
//
// A regra que atravessa tudo: nenhuma mudança de estágio, temperatura ou campo
// acontece sem um evento de jornada e um registro de auditoria. Um CRM em que a
// equipe não consegue reconstruir o que aconteceu com um lead é um CRM em que a
// equipe deixa de confiar.

function criarServicoDeLeads({ repositorio, agora = () => new Date() }) {
  /** Recalcula score e temperatura, e grava o que mudou. */
  async function recalcular(lead, { conversaId = null, origem = 'automacao', usuarioId = null } = {}) {
    const { score, motivos } = calcularScore(lead, { agora: agora().getTime() });
    const { temperatura, origem: origemDaTemperatura } = decidirTemperatura(lead, score);

    const mudou = lead.score !== score || lead.temperatura !== temperatura;
    if (!mudou) return { lead, score, temperatura, mudou: false };

    const atualizado = await repositorio.atualizarLead(lead.id, {
      score,
      scoreMotivos: motivos,
      scoreCalculadoEm: agora().toISOString(),
      // Temperatura fixada pela equipe não é sobrescrita — `decidirTemperatura`
      // já devolveu a dela, mas registrar de novo seria ruído na jornada.
      ...(origemDaTemperatura === 'score' ? { temperatura } : {}),
    });

    if (lead.temperatura !== temperatura && origemDaTemperatura === 'score') {
      await repositorio.registrarEventoDeLead(montarEvento({
        leadId: lead.id,
        conversaId,
        tipo: 'temperatura',
        de: lead.temperatura,
        para: temperatura,
        detalhe: { score, motivos },
        origem,
        usuarioId,
      }));
    }

    return { lead: atualizado, score, temperatura, mudou: true };
  }

  /**
   * Grava o que a qualificação descobriu.
   * Aceita respostas parciais: a conversa é gradual, e exigir tudo de uma vez
   * transformaria acolhimento em formulário.
   */
  async function qualificar(leadId, entrada, { conversaId = null, origem = 'automacao', usuarioId = null } = {}) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) {
      const erro = new Error('lead não encontrado');
      erro.status = 404;
      throw erro;
    }

    const campos = { ...normalizarQualificacao(entrada), ...normalizarOrigem(entrada) };
    if (Object.keys(campos).length === 0) {
      return { lead, alterados: [], proxima: proximaPergunta(lead) };
    }

    // Só o que mudou de fato: regravar o mesmo valor encheria a jornada de ruído.
    const alterados = Object.entries(campos)
      .filter(([campo, valor]) => lead[campo] !== valor)
      .map(([campo]) => campo);

    if (alterados.length === 0) {
      return { lead, alterados: [], proxima: proximaPergunta(lead) };
    }

    let atualizado = await repositorio.atualizarLead(leadId, campos);

    await repositorio.registrarEventoDeLead(montarEvento({
      leadId,
      conversaId,
      tipo: 'qualificacao',
      detalhe: { campos: alterados },
      origem,
      usuarioId,
    }));
    await repositorio.registrarAuditoria({
      entidade: 'lead',
      entidadeId: leadId,
      acao: 'lead_qualificado',
      detalhe: { campos: alterados, origem },
      usuarioId,
    });

    // Qualificar avança o estágio sozinho, mas só para frente.
    const pendentes = camposPendentes(atualizado);
    const sugerido = estagioSugerido(atualizado, pendentes);
    if (sugerido !== atualizado.estagio && transicaoPermitida(atualizado.estagio, sugerido)) {
      atualizado = (await moverEstagio(leadId, sugerido, { conversaId, origem, usuarioId })).lead;
    }

    if (pendentes.length === 0 && !atualizado.qualificado_em) {
      atualizado = await repositorio.atualizarLead(leadId, { qualificadoEm: agora().toISOString() });
    }

    const { lead: comScore } = await recalcular(atualizado, { conversaId, origem, usuarioId });

    return {
      lead: comScore,
      alterados,
      proxima: proximaPergunta(comScore),
      pendentes: camposPendentes(comScore),
    };
  }

  /** Move o lead de etapa, recusando salto que quase sempre é erro de clique. */
  async function moverEstagio(leadId, para, { conversaId = null, origem = 'equipe', usuarioId = null, motivo = null } = {}) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) {
      const erro = new Error('lead não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (!transicaoPermitida(lead.estagio, para)) throw new ErroDeJornada(lead.estagio, para);

    const atualizado = await repositorio.atualizarLead(leadId, {
      estagio: para,
      ...(para === 'perdido' && motivo ? { perdidoMotivo: String(motivo).slice(0, 200) } : {}),
    });

    await repositorio.registrarEventoDeLead(montarEvento({
      leadId,
      conversaId,
      tipo: 'estagio',
      de: lead.estagio,
      para,
      detalhe: motivo ? { motivo } : null,
      origem,
      usuarioId,
    }));
    await repositorio.registrarAuditoria({
      entidade: 'lead',
      entidadeId: leadId,
      acao: 'lead_estagio_alterado',
      detalhe: { de: lead.estagio, para, motivo },
      usuarioId,
    });

    return { lead: atualizado, de: lead.estagio, para };
  }

  /**
   * Fixa a temperatura na mão. A partir daí o cálculo não mexe mais.
   * Também sincroniza a etiqueta da conversa, para a lista e a ficha não
   * discordarem do kanban.
   */
  async function definirTemperaturaManual(leadId, temperatura, { conversaId = null, usuarioId = null } = {}) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) {
      const erro = new Error('lead não encontrado');
      erro.status = 404;
      throw erro;
    }

    const atualizado = await repositorio.atualizarLead(leadId, { temperatura, temperaturaManual: true });

    const alvo = conversaId ?? lead.conversa_id;
    if (alvo) {
      const atuais = await repositorio.listarEtiquetasDaConversa(alvo);
      await repositorio.definirEtiquetasDaConversa(alvo, aplicarTemperatura(atuais, temperatura));
    }

    await repositorio.registrarEventoDeLead(montarEvento({
      leadId,
      conversaId: alvo,
      tipo: 'temperatura',
      de: lead.temperatura,
      para: temperatura,
      detalhe: { manual: true },
      origem: 'equipe',
      usuarioId,
    }));
    await repositorio.registrarAuditoria({
      entidade: 'lead',
      entidadeId: leadId,
      acao: 'lead_temperatura_manual',
      detalhe: { de: lead.temperatura, para: temperatura },
      usuarioId,
    });

    return atualizado;
  }

  /** Registra o primeiro contato — o começo da jornada. */
  async function registrarPrimeiroContato(leadId, { conversaId = null, canal = null } = {}) {
    const jaTem = await repositorio.listarEventosDoLead(leadId, { tipo: 'primeiro_contato', limite: 1 });
    if (jaTem.length > 0) return jaTem[0];

    const evento = montarEvento({
      leadId,
      conversaId,
      tipo: 'primeiro_contato',
      para: canal,
      origem: 'contato',
    });
    await repositorio.registrarEventoDeLead(evento);
    return evento;
  }

  /** O retrato que a interface mostra: temperatura, próxima ação e o que falta. */
  async function descrever(leadId) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) return null;

    const { score, motivos } = calcularScore(lead, { agora: agora().getTime() });
    const eventos = await repositorio.listarEventosDoLead(leadId, { limite: 50 });

    return {
      lead,
      score,
      score_motivos: motivos,
      temperatura: lead.temperatura,
      temperatura_manual: Boolean(lead.temperatura_manual),
      proxima_acao: proximaAcao(lead),
      proxima_pergunta: proximaPergunta(lead),
      pendentes: camposPendentes(lead),
      jornada: eventos,
    };
  }

  return {
    qualificar,
    moverEstagio,
    definirTemperaturaManual,
    registrarPrimeiroContato,
    recalcular,
    descrever,
  };
}

module.exports = { criarServicoDeLeads };
