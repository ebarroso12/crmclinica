'use strict';

const crypto = require('node:crypto');
const { gerarHash, conferir } = require('./senha');
const { gerarSegredo, conferirCodigo, montarUri, cifrarSegredo, decifrarSegredo } = require('./totp');
const { permissoesDoPapel } = require('./rbac');

// Ciclo de vida das contas da equipe: cadastro, aprovação pelo master, segundo
// fator, troca e recuperação de senha, e vínculo com a conta Google.
//
// Regra que atravessa tudo: **cadastro não é autorização**. Conta nova nasce
// `pendente` e não entra até o admin master liberar — inclusive quando veio pelo
// Google, onde qualquer pessoa com uma conta poderia se cadastrar sozinha.

const DURACAO_RECUPERACAO_MS = 60 * 60 * 1000;
const SITUACOES = Object.freeze(['pendente', 'ativo', 'recusado', 'desativado']);

function hashDoToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Erro de acesso com situação: a interface precisa distinguir "espere" de "não". */
function erroDeSituacao(situacao) {
  const mensagens = {
    pendente: 'Sua conta ainda não foi liberada pelo administrador.',
    recusado: 'Seu acesso não foi autorizado.',
    desativado: 'Sua conta está desativada.',
  };
  const erro = new Error(mensagens[situacao] || 'Acesso não autorizado.');
  erro.status = 403;
  erro.situacao = situacao;
  return erro;
}

function criarContas({
  repositorio, configuracao, remetente, google, limitador = null, agora = () => new Date(),
}) {
  const segredoDaAplicacao = configuracao.autenticacao.segredoJwt;

  function podeEntrar(usuario) {
    return Boolean(usuario && usuario.ativo && usuario.situacao === 'ativo');
  }

  function retratoDoUsuario(usuario) {
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      master: Boolean(usuario.master),
      situacao: usuario.situacao,
      telefone: usuario.telefone ?? null,
      precisa_trocar_senha: Boolean(usuario.precisa_trocar_senha),
      totp_ativo: Boolean(usuario.totp_ativo),
      google_vinculado: Boolean(usuario.google_sub),
      permissoes: permissoesDoPapel(usuario.papel),
    };
  }

  // ---------------------------------------------------------------- cadastro e aprovação

  /**
   * Cadastro de uma conta nova. Sempre nasce pendente.
   * @param {object} dados nome, email, senha e papel pretendido
   * @param {object|null} criadoPor quem criou, quando veio do painel do master
   */
  async function cadastrar({ nome, email, senha, papel = 'atendente', googleSub = null }, criadoPor = null) {
    // Só o master cria conta já liberada; qualquer outro caminho passa pela fila.
    const jaLiberada = Boolean(criadoPor?.master);

    const usuario = await repositorio.criarUsuario({
      nome,
      email,
      senhaHash: senha ? await gerarHash(senha) : null,
      papel,
      googleSub,
      situacao: jaLiberada ? 'ativo' : 'pendente',
      // Senha escolhida por outra pessoa é provisória por definição.
      precisaTrocarSenha: Boolean(senha && criadoPor),
    });

    if (jaLiberada) {
      await repositorio.atualizarUsuario(usuario.id, {
        aprovadoPor: criadoPor.id,
        aprovadoEm: agora().toISOString(),
      });
    }

    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuario.id,
      acao: jaLiberada ? 'usuario_criado_e_liberado' : 'usuario_cadastrado_aguardando',
      detalhe: { papel, origem: googleSub ? 'google' : 'formulario' },
      usuarioId: criadoPor?.id ?? null,
    });

    return retratoDoUsuario(await repositorio.obterUsuarioPorId(usuario.id));
  }

  /**
   * Muda a situação de uma conta. Exclusivo do admin master.
   * O master não pode mexer na própria situação: seria a única forma de o sistema
   * ficar sem ninguém capaz de liberar contas.
   */
  async function definirSituacao(master, usuarioId, situacao) {
    if (!master?.master) {
      const erro = new Error('apenas o administrador master libera contas');
      erro.status = 403;
      throw erro;
    }
    if (!SITUACOES.includes(situacao)) {
      const erro = new Error(`situação deve ser uma de: ${SITUACOES.join(', ')}`);
      erro.status = 400;
      throw erro;
    }

    const alvo = await repositorio.obterUsuarioPorId(usuarioId);
    if (!alvo) {
      const erro = new Error('usuário não encontrado');
      erro.status = 404;
      throw erro;
    }
    if (alvo.master) {
      const erro = new Error('a conta do administrador master não pode ser alterada');
      erro.status = 409;
      throw erro;
    }

    const atualizado = await repositorio.atualizarUsuario(usuarioId, {
      situacao,
      ativo: situacao === 'ativo',
      aprovadoPor: master.id,
      aprovadoEm: agora().toISOString(),
    });

    // Quem perde acesso perde as sessões junto: continuar logado depois de
    // recusado tornaria a recusa decorativa.
    if (situacao !== 'ativo') await repositorio.revogarSessoesDoUsuario(usuarioId);

    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuarioId,
      acao: `usuario_${situacao}`,
      usuarioId: master.id,
    });

    return retratoDoUsuario(atualizado);
  }

  // ---------------------------------------------------------------- senha

  /** Troca a própria senha. Exige a senha atual — token roubado não troca senha. */
  async function trocarSenha(usuarioId, senhaAtual, senhaNova) {
    const usuario = await repositorio.obterUsuarioPorEmail(
      (await repositorio.obterUsuarioPorId(usuarioId))?.email,
    );
    if (!usuario) {
      const erro = new Error('usuário não encontrado');
      erro.status = 404;
      throw erro;
    }

    // Conta criada só pelo Google não tem senha para conferir.
    const temSenha = Boolean(usuario.senha_hash);
    if (temSenha && !(await conferir(senhaAtual, usuario.senha_hash))) {
      const erro = new Error('senha atual incorreta');
      erro.status = 401;
      throw erro;
    }
    if (temSenha && senhaAtual === senhaNova) {
      const erro = new Error('a senha nova precisa ser diferente da atual');
      erro.status = 400;
      throw erro;
    }

    await repositorio.atualizarUsuario(usuarioId, {
      senhaHash: await gerarHash(senhaNova),
      precisaTrocarSenha: false,
    });

    // Trocar senha encerra as outras sessões: é o gesto de quem desconfia que
    // alguém entrou. Manter as sessões antigas anularia o efeito.
    await repositorio.revogarSessoesDoUsuario(usuarioId);
    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuarioId,
      acao: 'senha_trocada',
      usuarioId,
    });

    return { trocada: true };
  }

  /**
   * Pede recuperação por e-mail.
   *
   * Responde igual para e-mail conhecido e desconhecido: a diferença revelaria
   * quem tem conta. O trabalho de verdade acontece só quando a conta existe.
   */
  async function pedirRecuperacao(email, { ip = null } = {}) {
    // Limite antes de qualquer coisa: pedir link é barato para quem pede e caro
    // para quem recebe. Sem teto, vira ferramenta de flood na caixa de outra pessoa.
    if (limitador) await limitador.exigirDentroDoLimite({ ip, email, acao: 'recuperacao' });
    if (limitador) await limitador.registrar({ ip, email, acao: 'recuperacao', sucesso: false });

    const usuario = await repositorio.obterUsuarioPorEmail(email);

    if (usuario && podeEntrar(usuario)) {
      const token = crypto.randomBytes(32).toString('base64url');

      // Pedido novo invalida os anteriores: só o último link deve funcionar.
      await repositorio.invalidarRecuperacoesDoUsuario(usuario.id);
      await repositorio.criarRecuperacao({
        usuarioId: usuario.id,
        hashToken: hashDoToken(token),
        expiraEm: new Date(agora().getTime() + DURACAO_RECUPERACAO_MS).toISOString(),
        ip,
      });

      const link = `${configuracao.autenticacao.urlPublica}/?recuperar=${token}`;
      await remetente.enviar({
        para: usuario.email,
        assunto: 'crmclinica — redefinição de senha',
        texto: [
          `Olá, ${usuario.nome}.`,
          '',
          'Recebemos um pedido para redefinir a senha da sua conta no crmclinica.',
          'Abra o endereço abaixo para escolher uma senha nova:',
          '',
          link,
          '',
          'O link vale por 1 hora e só pode ser usado uma vez.',
          'Se não foi você quem pediu, ignore esta mensagem: nada muda.',
        ].join('\n'),
      });

      await repositorio.registrarAuditoria({
        entidade: 'usuario',
        entidadeId: usuario.id,
        acao: 'recuperacao_solicitada',
      });
    }

    // Sempre a mesma resposta, com ou sem conta.
    return { solicitado: true };
  }

  /** Redefine a senha com o token recebido por e-mail. */
  async function redefinirSenha(token, senhaNova, { ip = null } = {}) {
    // O token tem 32 bytes, mas adivinhação por força bruta ainda merece teto.
    if (limitador) await limitador.exigirDentroDoLimite({ ip, acao: 'redefinicao' });

    const recuperacao = await repositorio.obterRecuperacaoPorHash(hashDoToken(String(token || '')));

    if (!recuperacao || recuperacao.usado_em || new Date(recuperacao.expira_em) <= agora()) {
      if (limitador) await limitador.registrar({ ip, acao: 'redefinicao', sucesso: false });

      const erro = new Error('link de recuperação inválido ou expirado');
      erro.status = 400;
      throw erro;
    }

    const usuario = await repositorio.obterUsuarioPorId(recuperacao.usuario_id);
    if (!podeEntrar(usuario)) throw erroDeSituacao(usuario?.situacao ?? 'desativado');

    await repositorio.atualizarUsuario(usuario.id, {
      senhaHash: await gerarHash(senhaNova),
      precisaTrocarSenha: false,
    });
    await repositorio.marcarRecuperacaoUsada(recuperacao.id);
    // Quem redefiniu a senha provavelmente perdeu o controle da conta: derruba tudo.
    await repositorio.revogarSessoesDoUsuario(usuario.id);

    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuario.id,
      acao: 'senha_redefinida',
      usuarioId: usuario.id,
    });

    return { redefinida: true };
  }

  // ---------------------------------------------------------------- segundo fator

  /** Prepara o segundo fator. Só passa a valer depois de confirmado com um código. */
  async function prepararSegundoFator(usuarioId) {
    const usuario = await repositorio.obterUsuarioPorId(usuarioId);
    if (!usuario) {
      const erro = new Error('usuário não encontrado');
      erro.status = 404;
      throw erro;
    }

    const segredo = gerarSegredo();
    await repositorio.atualizarUsuario(usuarioId, {
      totpSegredoCifrado: cifrarSegredo(segredo, segredoDaAplicacao),
      totpAtivo: false,
      totpConfirmadoEm: null,
    });

    // O segredo em claro aparece uma única vez, para a pessoa cadastrar no aplicativo.
    return { segredo, uri: montarUri(segredo, usuario.email) };
  }

  /** Confirma o segundo fator com um código do aplicativo. Só então fica ativo. */
  async function confirmarSegundoFator(usuarioId, codigo) {
    const cifrado = await repositorio.obterSegredoTotp(usuarioId);
    const segredo = decifrarSegredo(cifrado, segredoDaAplicacao);

    if (!segredo) {
      const erro = new Error('nenhum segundo fator em preparação');
      erro.status = 400;
      throw erro;
    }
    if (!conferirCodigo(segredo, codigo, agora().getTime())) {
      const erro = new Error('código incorreto');
      erro.status = 400;
      throw erro;
    }

    await repositorio.atualizarUsuario(usuarioId, {
      totpAtivo: true,
      totpConfirmadoEm: agora().toISOString(),
    });
    await repositorio.registrarAuditoria({
      entidade: 'usuario', entidadeId: usuarioId, acao: 'segundo_fator_ativado', usuarioId,
    });

    return { ativo: true };
  }

  /** Desliga o segundo fator. Exige a senha: token roubado não desliga proteção. */
  async function desativarSegundoFator(usuarioId, senha) {
    const porId = await repositorio.obterUsuarioPorId(usuarioId);
    const usuario = await repositorio.obterUsuarioPorEmail(porId?.email);

    if (usuario?.senha_hash && !(await conferir(senha, usuario.senha_hash))) {
      const erro = new Error('senha incorreta');
      erro.status = 401;
      throw erro;
    }

    await repositorio.atualizarUsuario(usuarioId, {
      totpAtivo: false,
      totpSegredoCifrado: null,
      totpConfirmadoEm: null,
    });
    await repositorio.registrarAuditoria({
      entidade: 'usuario', entidadeId: usuarioId, acao: 'segundo_fator_desativado', usuarioId,
    });

    return { ativo: false };
  }

  async function segundoFatorConfere(usuario, codigo) {
    if (!usuario.totp_ativo) return true;

    const segredo = decifrarSegredo(await repositorio.obterSegredoTotp(usuario.id), segredoDaAplicacao);
    return Boolean(segredo) && conferirCodigo(segredo, codigo, agora().getTime());
  }

  // ---------------------------------------------------------------- Google

  /**
   * Entra com a conta Google.
   *
   * Vincula pelo `sub` quando já existe, ou pelo e-mail quando a conta foi criada
   * antes por outro caminho. Conta nova pelo Google nasce **pendente**: se qualquer
   * pessoa com uma conta Google entrasse direto, a fila de aprovação não serviria
   * para nada.
   */
  async function entrarComGoogle(codigo) {
    const identidade = await google.trocarCodigo(codigo);

    let usuario = await repositorio.obterUsuarioPorGoogleSub(identidade.sub);

    if (!usuario && identidade.email) {
      const porEmail = await repositorio.obterUsuarioPorEmail(identidade.email);
      if (porEmail) {
        usuario = await repositorio.atualizarUsuario(porEmail.id, { googleSub: identidade.sub });
        await repositorio.registrarAuditoria({
          entidade: 'usuario', entidadeId: porEmail.id, acao: 'google_vinculado', usuarioId: porEmail.id,
        });
      }
    }

    if (!usuario) {
      const criado = await cadastrar({
        nome: identidade.nome || identidade.email,
        email: identidade.email,
        senha: null,
        googleSub: identidade.sub,
      });
      throw erroDeSituacao(criado.situacao);
    }

    if (!podeEntrar(usuario)) throw erroDeSituacao(usuario.situacao);

    return usuario;
  }

  return {
    SITUACOES,
    podeEntrar,
    retratoDoUsuario,
    erroDeSituacao,
    cadastrar,
    definirSituacao,
    trocarSenha,
    pedirRecuperacao,
    redefinirSenha,
    prepararSegundoFator,
    confirmarSegundoFator,
    desativarSegundoFator,
    segundoFatorConfere,
    entrarComGoogle,
  };
}

module.exports = { criarContas, hashDoToken, SITUACOES, DURACAO_RECUPERACAO_MS };
