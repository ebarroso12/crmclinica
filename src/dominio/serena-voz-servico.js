'use strict';

const crypto = require('node:crypto');
const { exigirPermissao } = require('../seguranca/rbac');
const {
  ErroDaVoz, emitirTokenDeVoz, verificarTokenDeVoz,
  assinaturaDeEventoValida, validarEventoDeTranscricao,
} = require('./serena-voz');

function criarServicoDeVoz({ repositorio, serena, configuracao, agora = () => new Date() }) {
  if (!repositorio || !serena || !configuracao) throw new Error('serviço de voz incompleto');
  const voz = configuracao.serenaVoz;

  function exigirDisponivel() {
    if (!voz.ativa) throw new ErroDaVoz('laboratório de voz está desligado', 'voz_desligada', 503);
    if (!voz.gatewayUrl || voz.segredoJwt.length < 32 || voz.segredoWebhook.length < 32) {
      throw new ErroDaVoz('laboratório de voz ainda não foi configurado', 'voz_nao_configurada', 503);
    }
  }

  async function status(usuario) {
    exigirPermissao(usuario, 'serena:voz');
    const [estado, prompt] = await Promise.all([serena.obterConfiguracao(), serena.obterPromptAtivo()]);
    return {
      ativa: voz.ativa,
      configurada: Boolean(voz.gatewayUrl && voz.segredoJwt.length >= 32 && voz.segredoWebhook.length >= 32),
      pronta: voz.ativa && estado.ativa && Boolean(prompt.efetivo)
        && Boolean(voz.gatewayUrl && voz.segredoJwt.length >= 32 && voz.segredoWebhook.length >= 32),
      serena_ativa: estado.ativa,
      prompt_publicado: Boolean(prompt.efetivo),
      perfil: voz.perfil,
      limite_segundos: voz.duracaoMaximaSegundos,
      observacao: 'avaliação interna; não inicia contato nem executa ação clínica',
    };
  }

  async function criarSessao(usuario, corpo = {}) {
    exigirPermissao(usuario, 'serena:voz');
    exigirDisponivel();
    if (corpo.consentimento !== true) {
      throw new ErroDaVoz('confirme o consentimento antes de abrir o microfone', 'consentimento_obrigatorio');
    }

    const [estado, prompt] = await Promise.all([serena.obterConfiguracao(), serena.obterPromptAtivo()]);
    if (!estado.ativa) throw new ErroDaVoz('a Serena está desligada', 'serena_desligada', 409);
    if (!prompt.efetivo) throw new ErroDaVoz('publique um prompt antes do teste de voz', 'prompt_ausente', 409);

    let conversaId = null;
    if (corpo.conversa_id !== undefined && corpo.conversa_id !== null && corpo.conversa_id !== '') {
      conversaId = Number(corpo.conversa_id);
      if (!Number.isInteger(conversaId) || conversaId <= 0 || !(await repositorio.obterConversa(conversaId))) {
        throw new ErroDaVoz('conversa não encontrada', 'conversa_ausente', 404);
      }
    }

    const sessaoId = `sv_${crypto.randomUUID()}`;
    const criadoEm = agora();
    const expiraEm = new Date(criadoEm.getTime() + voz.duracaoMaximaSegundos * 1000);
    await repositorio.criarSessaoDeVoz({
      id: sessaoId,
      usuarioId: usuario.id,
      conversaId,
      perfil: voz.perfil,
      consentimentoEm: criadoEm,
      expiraEm,
    });
    await repositorio.registrarAuditoria({
      entidade: 'serena_voz', entidadeId: sessaoId, acao: 'sessao_iniciada',
      detalhe: { conversa_id: conversaId, perfil: voz.perfil }, usuarioId: usuario.id,
    });

    const token = emitirTokenDeVoz({
      sessaoId, usuarioId: usuario.id, segredo: voz.segredoJwt,
      duracaoSegundos: Math.min(voz.tokenTtlSegundos, voz.duracaoMaximaSegundos),
    });
    const separador = voz.gatewayUrl.includes('?') ? '&' : '?';
    return {
      sessao_id: sessaoId,
      websocket_url: `${voz.gatewayUrl}${separador}token=${encodeURIComponent(token)}`,
      expira_em: expiraEm.toISOString(),
      entrada_audio: { formato: 'pcm16', taxa_hz: 16000, canais: 1 },
      saida_audio: { formato: 'pcm16', taxa_hz: 24000, canais: 1 },
    };
  }

  async function obterContexto(token) {
    exigirDisponivel();
    const resultado = verificarTokenDeVoz(token, voz.segredoJwt);
    if (!resultado.valido) throw new ErroDaVoz('token de voz inválido', 'token_invalido', 401);
    const sessao = await repositorio.obterSessaoDeVoz(resultado.conteudo.sid);
    if (!sessao || sessao.estado !== 'ativa' || new Date(sessao.expira_em) <= agora()) {
      throw new ErroDaVoz('sessão de voz encerrada ou expirada', 'sessao_expirada', 401);
    }
    const [estado, prompt, turnos] = await Promise.all([
      serena.obterConfiguracao(), serena.obterPromptAtivo(), repositorio.listarTurnosDeVoz(sessao.id),
    ]);
    if (!estado.ativa || !prompt.efetivo) throw new ErroDaVoz('Serena indisponível', 'serena_indisponivel', 409);
    return {
      session_id: sessao.id,
      instructions: prompt.efetivo,
      voice: voz.voz,
      expires_at: sessao.expira_em,
      previous_turns: turnos.slice(-12).map((item) => ({ role: item.papel, transcript: item.transcricao })),
      policy: { persist_raw_audio: false, clinical_actions: false },
    };
  }

  async function receberEvento(corpoBruto, cabecalhos) {
    exigirDisponivel();
    if (!assinaturaDeEventoValida({
      corpoBruto,
      instante: cabecalhos['x-serena-voz-timestamp'],
      recebida: cabecalhos['x-serena-voz-signature'],
      segredo: voz.segredoWebhook,
      agora: agora().getTime(),
    })) throw new ErroDaVoz('assinatura do evento inválida', 'assinatura_invalida', 401);

    let corpo;
    try { corpo = JSON.parse(corpoBruto.toString('utf8')); } catch { throw new ErroDaVoz('JSON inválido'); }
    const evento = validarEventoDeTranscricao(corpo);
    const sessao = await repositorio.obterSessaoDeVoz(evento.sessaoId);
    if (!sessao) throw new ErroDaVoz('sessão de voz não encontrada', 'sessao_ausente', 404);
    if (sessao.estado !== 'ativa' || new Date(sessao.expira_em) <= agora()) {
      throw new ErroDaVoz('sessão de voz encerrada ou expirada', 'sessao_expirada', 409);
    }
    const resultado = await repositorio.registrarTurnoDeVoz(evento);
    return { aceito: true, duplicado: !resultado.criado };
  }

  async function encerrarSessao(usuario, sessaoId) {
    exigirPermissao(usuario, 'serena:voz');
    const sessao = await repositorio.obterSessaoDeVoz(sessaoId);
    if (!sessao) throw new ErroDaVoz('sessão de voz não encontrada', 'sessao_ausente', 404);
    if (Number(sessao.usuario_id) !== Number(usuario.id) && usuario.papel !== 'admin') {
      throw new ErroDaVoz('sessão pertence a outro usuário', 'sessao_proibida', 403);
    }
    const atualizada = await repositorio.encerrarSessaoDeVoz(sessaoId);
    return { sessao_id: atualizada.id, estado: atualizada.estado, encerrado_em: atualizada.encerrado_em };
  }

  return { status, criarSessao, obterContexto, receberEvento, encerrarSessao };
}

module.exports = { criarServicoDeVoz };
