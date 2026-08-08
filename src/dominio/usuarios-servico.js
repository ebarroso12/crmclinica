'use strict';

// Gestão de usuários além do cadastro (P1-01 a P1-08).
//
// As regras duras deste módulo, e por que elas existem:
//
//   - Ninguém é apagado de verdade. Excluir é lógico: a autoria histórica
//     (mensagens respondidas, agendamentos criados, auditoria) continua
//     apontando para uma pessoa que existiu. Apagar a linha transformaria o
//     histórico em órfão anônimo.
//   - Suspender revoga as sessões na mesma hora. Um suspenso com token vivo
//     é um suspenso que continua operando — a suspensão que não derruba a
//     sessão é cenográfica.
//   - Mudança de papel é sempre auditada com o antes e o depois. É a ação
//     mais poderosa do painel: quem vira admin pode tudo.
//   - CPF/RG nunca trafegam em aberto. O serviço recebe o dígito, valida,
//     cifra e guarda o hash de busca; o que volta para a tela é a máscara.
//     Decifrar é uma operação à parte, restrita a admin e auditada.
//   - O termo é versionado e a assinatura é EXTERNA: guardamos quem assinou,
//     qual versão e o identificador no provedor — nunca a assinatura em si.
//     O texto do termo é template sujeito a revisão jurídica.

const { PAPEIS, exigirPermissao } = require('../seguranca/rbac');
const sensiveis = require('../seguranca/dados-sensiveis');

function erroDeValidacao(codigo, mensagem) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = 422;
  return erro;
}

function nascimentoValido(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) {
    throw erroDeValidacao('nascimento_invalido', 'data de nascimento inválida');
  }
  if (data.getTime() >= Date.now()) {
    throw erroDeValidacao('nascimento_futuro', 'nascimento não pode estar no futuro');
  }
  return data.toISOString().slice(0, 10);
}

function whatsappValido({ ddi = null, ddd = null, numero = null }) {
  if (!ddi && !ddd && !numero) return { ddi: null, ddd: null, numero: null };
  const digitos = (v) => String(v ?? '').replace(/\D/g, '');
  const ddiLimpo = digitos(ddi) || '55';
  const dddLimpo = digitos(ddd);
  const numeroLimpo = digitos(numero);
  if (!/^\d{2}$/.test(dddLimpo) || !/^\d{8,9}$/.test(numeroLimpo)) {
    throw erroDeValidacao('whatsapp_invalido', 'WhatsApp precisa de DDD (2 dígitos) e número (8 ou 9)');
  }
  return { ddi: ddiLimpo, ddd: dddLimpo, numero: numeroLimpo };
}

/** Cifra e faz o hash de busca de um documento; null entra, null sai. */
function protegerDocumento(segredo, valor, { validarCpf = false } = {}) {
  const digitos = sensiveis.normalizarDocumento(valor);
  if (!digitos) return { cifrado: null, hash: null };
  if (validarCpf && !sensiveis.cpfValido(digitos)) {
    throw erroDeValidacao('cpf_invalido', 'CPF não passou na verificação dos dígitos');
  }
  return { cifrado: sensiveis.cifrar(segredo, digitos), hash: sensiveis.hashDeBusca(segredo, digitos) };
}

function criarServicoDeUsuarios({
  repositorio,
  repositorioClinica,
  segredo,
  agora = () => new Date(),
}) {
  async function auditar(entidadeId, acao, detalhe, usuarioId) {
    await repositorio.registrarAuditoria({ entidade: 'usuario', entidadeId, acao, detalhe, usuarioId });
  }

  async function carregarUsuario(usuarioId) {
    const usuario = await repositorio.obterUsuarioPorId(usuarioId);
    if (!usuario) throw erroDeValidacao('usuario_inexistente', 'usuário não encontrado');
    return usuario;
  }

  /**
   * Edição completa (P1-01 + P1-05): cadastro estruturado, WhatsApp,
   * documentos (cifrados aqui dentro) e papel. O que muda de papel é
   * auditado com antes/depois; o que é documento nunca aparece no detalhe.
   */
  async function editarUsuarioCompleto(ator, usuarioId, campos = {}) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    const alvo = await carregarUsuario(usuarioId);

    const atualizacao = {};

    if (campos.nome !== undefined) atualizacao.nome = String(campos.nome ?? '').trim() || alvo.nome;
    if (campos.telefone !== undefined) atualizacao.telefone = campos.telefone ?? null;
    if (campos.nomeCompleto !== undefined) atualizacao.nomeCompleto = campos.nomeCompleto ?? null;
    if (campos.nascimento !== undefined) atualizacao.nascimento = nascimentoValido(campos.nascimento);

    if (campos.whatsapp !== undefined) {
      const { ddi, ddd, numero } = whatsappValido(campos.whatsapp ?? {});
      atualizacao.whatsappDdi = ddi;
      atualizacao.whatsappDdd = ddd;
      atualizacao.whatsappNumero = numero;
    }

    if (campos.cpf !== undefined) {
      const { cifrado, hash } = protegerDocumento(segredo, campos.cpf, { validarCpf: true });
      atualizacao.cpfCifrado = cifrado;
      atualizacao.cpfBuscaHash = hash;
    }
    if (campos.rg !== undefined) {
      const { cifrado } = protegerDocumento(segredo, campos.rg);
      atualizacao.rgCifrado = cifrado;
    }

    let mudancaDePapel = null;
    if (campos.papel !== undefined && campos.papel !== alvo.papel) {
      if (!PAPEIS.includes(campos.papel)) {
        throw erroDeValidacao('papel_invalido', `papel deve ser um de: ${PAPEIS.join(', ')}`);
      }
      if (alvo.master) {
        throw erroDeValidacao('master_imutavel', 'o papel do master só muda pela semeadura');
      }
      if (Number(ator.id) === Number(usuarioId)) {
        throw erroDeValidacao('papel_proprio', 'ninguém muda o próprio papel');
      }
      mudancaDePapel = { de: alvo.papel, para: campos.papel };
      atualizacao.papel = campos.papel;
    }

    const atualizado = Object.keys(atualizacao).length > 0
      ? await repositorio.atualizarUsuario(usuarioId, atualizacao)
      : alvo;

    if (mudancaDePapel) {
      await auditar(usuarioId, 'usuario.papel_alterado', mudancaDePapel, ator.id);
    }
    await auditar(usuarioId, 'usuario.editado', {
      campos: Object.keys(atualizacao).filter((c) => !/Cifrado|Hash/.test(c)),
      documentos_tocados: ['cpf', 'rg'].filter((d) => campos[d] !== undefined),
    }, ator.id);

    return atualizado;
  }

  /**
   * Ficha completa para a tela (P1-01): tudo, menos segredos e documentos —
   * no lugar do CPF, só a indicação de que existe e a máscara.
   */
  async function obterFichaDoUsuario(ator, usuarioId) {
    const proprioUsuario = Number(ator.id) === Number(usuarioId);
    if (!proprioUsuario) exigirPermissao(ator, 'usuarios:gerenciar');

    const alvo = await carregarUsuario(usuarioId);
    const documentos = await repositorio.obterDocumentosDoUsuario(usuarioId);
    return {
      ...alvo,
      cpf_cadastrado: Boolean(documentos?.cpfCifrado),
      cpf_mascarado: documentos?.cpfCifrado
        ? sensiveis.mascararCpf(sensiveis.decifrar(segredo, documentos.cpfCifrado) ?? '')
        : null,
      rg_cadastrado: Boolean(documentos?.rgCifrado),
    };
  }

  /**
   * Decifrar CPF é operação à parte: admin apenas, e cada leitura vira linha
   * na auditoria. Acesso mínimo não é promessa, é desenho (P1-05).
   */
  async function revelarCpfDoUsuario(ator, usuarioId) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    await carregarUsuario(usuarioId);
    const documentos = await repositorio.obterDocumentosDoUsuario(usuarioId);
    if (!documentos?.cpfCifrado) return null;

    await auditar(usuarioId, 'usuario.cpf_revelado', null, ator.id);
    return sensiveis.decifrar(segredo, documentos.cpfCifrado);
  }

  /**
   * Suspensão (P1-02): desativa e derruba as sessões no mesmo gesto. Sem a
   * revogação, tokens já emitidos continuariam válidos por dias.
   */
  async function suspenderUsuario(ator, usuarioId, { motivo = null } = {}) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    const alvo = await carregarUsuario(usuarioId);
    if (alvo.master) throw erroDeValidacao('master_imutavel', 'o master não pode ser suspenso');
    if (Number(ator.id) === Number(usuarioId)) {
      throw erroDeValidacao('suspensao_propria', 'ninguém suspende a si mesmo');
    }

    const atualizado = await repositorio.atualizarUsuario(usuarioId, {
      ativo: false, situacao: 'suspenso',
    });
    const sessoesRevogadas = await repositorio.revogarSessoesDoUsuario(usuarioId);
    await auditar(usuarioId, 'usuario.suspenso', { motivo, sessoes_revogadas: sessoesRevogadas }, ator.id);
    return atualizado;
  }

  async function reativarUsuario(ator, usuarioId) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    await carregarUsuario(usuarioId);

    const atualizado = await repositorio.atualizarUsuario(usuarioId, {
      ativo: true, situacao: 'ativo', excluidoEm: null, excluidoPor: null, excluidoMotivo: null,
    });
    await auditar(usuarioId, 'usuario.reativado', null, ator.id);
    return atualizado;
  }

  /**
   * Exclusão lógica (P1-02): a linha fica, a pessoa sai. Sessões revogadas
   * no mesmo gesto — excluído com token vivo é a mesma falha do suspenso.
   */
  async function excluirUsuario(ator, usuarioId, { motivo = null } = {}) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    const alvo = await carregarUsuario(usuarioId);
    if (alvo.master) throw erroDeValidacao('master_imutavel', 'o master não pode ser excluído');
    if (Number(ator.id) === Number(usuarioId)) {
      throw erroDeValidacao('exclusao_propria', 'ninguém exclui a si mesmo');
    }

    const atualizado = await repositorio.atualizarUsuario(usuarioId, {
      ativo: false,
      situacao: 'excluido',
      excluidoEm: agora().toISOString(),
      excluidoPor: ator.id,
      excluidoMotivo: motivo,
    });
    const sessoesRevogadas = await repositorio.revogarSessoesDoUsuario(usuarioId);
    await auditar(usuarioId, 'usuario.excluido', { motivo, sessoes_revogadas: sessoesRevogadas }, ator.id);
    return atualizado;
  }

  /** Painel de sessões (P1-03): quem está dentro, de onde, até quando. */
  async function listarSessoes(ator, usuarioId) {
    const proprioUsuario = Number(ator.id) === Number(usuarioId);
    if (!proprioUsuario) exigirPermissao(ator, 'usuarios:gerenciar');
    return repositorioClinica.listarSessoesDoUsuario(usuarioId);
  }

  async function revogarSessao(ator, usuarioId, sessaoId) {
    const proprioUsuario = Number(ator.id) === Number(usuarioId);
    if (!proprioUsuario) exigirPermissao(ator, 'usuarios:gerenciar');

    const revogada = await repositorioClinica.revogarSessaoDoUsuario(usuarioId, sessaoId);
    if (revogada) await auditar(usuarioId, 'usuario.sessao_revogada', { sessao_id: sessaoId }, ator.id);
    return revogada;
  }

  /**
   * Autorização de WhatsApp particular (P1-06): o número da equipe só é
   * usado para avisos operacionais com consentimento explícito — e o registro
   * de quem autorizou e quando é o que diferencia consentimento de hábito.
   */
  async function autorizarWhatsappParticular(ator, usuarioId, { autorizado }) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    await carregarUsuario(usuarioId);

    const atualizado = await repositorio.atualizarUsuario(usuarioId, {
      whatsappParticularAutorizado: autorizado === true,
      whatsappParticularAutorizadoEm: autorizado === true ? agora().toISOString() : null,
      whatsappParticularAutorizadoPor: autorizado === true ? ator.id : null,
    });
    await auditar(usuarioId, autorizado === true
      ? 'usuario.whatsapp_particular_autorizado'
      : 'usuario.whatsapp_particular_revogado', null, ator.id);
    return atualizado;
  }

  // ------------------------------------------------------------------ termos

  /** Termo vigente por escopo (P1-07). */
  async function obterTermoVigente(escopo) {
    return repositorioClinica.obterTermoVigente(escopo);
  }

  async function listarTermos(ator, escopo = null) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    return repositorioClinica.listarTermos(escopo);
  }

  /**
   * Nova versão de um termo. O texto é template sujeito a revisão jurídica —
   * o serviço versiona e publica, mas não finge que o conteúdo é definitivo.
   */
  async function criarVersaoDeTermo(ator, { escopo, titulo, texto, publicar = false }) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    if (!['equipe', 'paciente'].includes(escopo)) {
      throw erroDeValidacao('escopo_invalido', 'escopo deve ser equipe ou paciente');
    }
    if (!String(texto ?? '').trim()) {
      throw erroDeValidacao('texto_vazio', 'o termo precisa de texto');
    }

    const versao = await repositorioClinica.criarVersaoDeTermo({
      escopo, titulo, texto, autorId: ator.id,
    });
    if (publicar) await repositorioClinica.publicarTermo(versao.id);
    await auditar(versao.id, 'termo.versao_criada', { escopo, versao: versao.versao, publicado: publicar }, ator.id);
    return publicar ? repositorioClinica.listarTermos(escopo).then((t) => t.find((x) => x.id === versao.id)) : versao;
  }

  async function publicarTermo(ator, termoId) {
    exigirPermissao(ator, 'usuarios:gerenciar');
    const publicado = await repositorioClinica.publicarTermo(termoId);
    if (publicado) await auditar(termoId, 'termo.publicado', { versao: publicado.versao }, ator.id);
    return publicado;
  }

  /**
   * Registra a assinatura EXTERNA de um termo: quem assinou, qual versão e o
   * identificador no provedor (clique com registro, assinatura digital...).
   * A prova vive lá fora; aqui fica a referência.
   */
  async function registrarAssinatura(ator, { termoId, usuarioId = null, contatoId = null, assinaturaExternaId, provedor = null }) {
    if (!assinaturaExternaId) {
      throw erroDeValidacao('assinatura_sem_referencia', 'a assinatura precisa do identificador externo');
    }
    const proprioUsuario = usuarioId && Number(ator.id) === Number(usuarioId);
    if (!proprioUsuario) exigirPermissao(ator, 'usuarios:gerenciar');

    const assinatura = await repositorioClinica.assinarTermo({
      termoId, usuarioId, contatoId, assinaturaExternaId, provedor, registradoPor: ator.id,
    });
    await repositorio.registrarAuditoria({
      entidade: usuarioId ? 'usuario' : 'contato',
      entidadeId: usuarioId ?? contatoId,
      acao: 'termo.assinado',
      detalhe: { termo_id: termoId, provedor },
      usuarioId: ator.id,
    });
    return assinatura;
  }

  /**
   * Responsável legal + consentimento (P1-08): para menores e pacientes
   * assistidos, quem consente é outra pessoa — e o registro precisa dizer
   * quem, qual o parentesco, por qual canal consentiu e qual termo.
   */
  async function registrarResponsavel(ator, contatoId, {
    nome, cpf = null, parentesco = null, consentimentoCanal = null, consentimentoTermoId = null,
  }) {
    exigirPermissao(ator, 'contatos:editar');
    if (!String(nome ?? '').trim()) {
      throw erroDeValidacao('responsavel_sem_nome', 'o responsável precisa de nome');
    }
    const { cifrado } = protegerDocumento(segredo, cpf, { validarCpf: cpf != null && cpf !== '' });

    const atualizado = await repositorio.atualizarContato(contatoId, {
      responsavelNome: String(nome).trim(),
      responsavelCpfCifrado: cifrado,
      responsavelParentesco: parentesco,
      consentimentoResponsavelEm: agora().toISOString(),
      consentimentoCanal,
      consentimentoTermoId,
    });
    await repositorio.registrarAuditoria({
      entidade: 'contato',
      entidadeId: contatoId,
      acao: 'contato.responsavel_registrado',
      detalhe: { parentesco, consentimento_canal: consentimentoCanal, termo_id: consentimentoTermoId },
      usuarioId: ator.id,
    });
    return atualizado;
  }

  return {
    editarUsuarioCompleto,
    obterFichaDoUsuario,
    revelarCpfDoUsuario,
    suspenderUsuario,
    reativarUsuario,
    excluirUsuario,
    listarSessoes,
    revogarSessao,
    autorizarWhatsappParticular,
    obterTermoVigente,
    listarTermos,
    criarVersaoDeTermo,
    publicarTermo,
    registrarAssinatura,
    registrarResponsavel,
  };
}

module.exports = { criarServicoDeUsuarios };
