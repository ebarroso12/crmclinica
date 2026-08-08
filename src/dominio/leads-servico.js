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

    // Qualificar avança o estágio sozinho, mas só para frente. O avanço é
    // consequência automática — não exige dono nem próximo passo, que são
    // regra do movimento EXPLÍCITO no kanban.
    const pendentes = camposPendentes(atualizado);
    const sugerido = estagioSugerido(atualizado, pendentes);
    if (sugerido !== atualizado.estagio && transicaoPermitida(atualizado.estagio, sugerido)) {
      atualizado = (await moverEstagio(leadId, sugerido, {
        conversaId, origem, usuarioId, automatico: true,
      })).lead;
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

  /**
   * Move o lead de etapa, recusando salto que quase sempre é erro de clique.
   *
   * Movimento feito pela EQUIPE exige dono e próximo passo — card sem
   * responsável e sem ação combinada é card que morre na coluna. A automação
   * fica isenta: o avanço automático (novo → qualificando) acontece antes de
   * existir alguém para ser dono. Perder exige motivo: "perdido" sem porquê
   * inutiliza a métrica de motivo de perda.
   *
   * Os dois campos podem vir na própria chamada (`proprietarioId`,
   * `proximoPasso`) — mover e assumir num gesto só.
   */
  async function moverEstagio(leadId, para, {
    conversaId = null, origem = 'equipe', usuarioId = null, motivo = null,
    proprietarioId = null, proximoPasso = null, automatico = false,
  } = {}) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) {
      const erro = new Error('lead não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (!transicaoPermitida(lead.estagio, para)) throw new ErroDeJornada(lead.estagio, para);

    if (origem === 'equipe' && para !== 'perdido' && !automatico) {
      const dono = proprietarioId ?? usuarioId ?? lead.proprietario_id;
      const passo = proximoPasso ?? lead.proximo_passo;
      if (!dono || !String(passo ?? '').trim()) {
        const erro = new Error(
          'para mover o lead, defina o proprietário e o próximo passo — sem dono e sem ação combinada, o card morre na coluna',
        );
        erro.status = 422;
        erro.codigo = 'gestao_obrigatoria';
        throw erro;
      }
    }
    if (para === 'perdido' && !String(motivo ?? '').trim() && !lead.perdido_motivo) {
      const erro = new Error('mover para perdido exige o motivo — é ele que alimenta a métrica de perda');
      erro.status = 422;
      erro.codigo = 'motivo_obrigatorio';
      throw erro;
    }

    const atualizado = await repositorio.atualizarLead(leadId, {
      estagio: para,
      // O relógio do aging zera a cada mudança de coluna.
      estagioDesde: agora().toISOString(),
      ...(proprietarioId ?? usuarioId
        ? { proprietarioId: proprietarioId ?? usuarioId }
        : {}),
      ...(proximoPasso
        ? { proximoPasso: String(proximoPasso).trim().slice(0, 300), proximoPassoEm: agora().toISOString() }
        : {}),
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
   * Define o dono e o próximo passo do lead — os dois campos que a regra do
   * kanban exige antes de qualquer avanço de coluna feito pela equipe.
   */
  async function definirGestao(leadId, { proprietarioId = null, proximoPasso = null, usuarioId = null } = {}) {
    const lead = await repositorio.obterLead(leadId);
    if (!lead) {
      const erro = new Error('lead não encontrado');
      erro.status = 404;
      throw erro;
    }

    const campos = {};
    if (proprietarioId !== null) campos.proprietarioId = Number(proprietarioId);
    if (proximoPasso !== null) {
      const passo = String(proximoPasso).trim();
      if (!passo) {
        const erro = new Error('o próximo passo não pode ser vazio');
        erro.status = 422;
        erro.codigo = 'proximo_passo_vazio';
        throw erro;
      }
      campos.proximoPasso = passo.slice(0, 300);
      campos.proximoPassoEm = agora().toISOString();
    }
    if (Object.keys(campos).length === 0) return lead;

    const atualizado = await repositorio.atualizarLead(leadId, campos);
    await repositorio.registrarAuditoria({
      entidade: 'lead',
      entidadeId: leadId,
      acao: 'lead_gestao_definida',
      detalhe: {
        proprietario_id: campos.proprietarioId ?? null,
        proximo_passo: campos.proximoPasso ?? null,
      },
      usuarioId,
    });

    return atualizado;
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
    definirGestao,
    definirTemperaturaManual,
    registrarPrimeiroContato,
    recalcular,
    descrever,
  };
}

module.exports = { criarServicoDeLeads };
