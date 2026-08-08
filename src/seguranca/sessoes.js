'use strict';

const crypto = require('node:crypto');
const { emitir, verificar } = require('./jwt');
const { conferir } = require('./senha');
const { permissoesDoPapel } = require('./rbac');

// Autenticação em duas peças, com propósitos diferentes:
//
//   access token  — JWT curto, auto-contido. Validar não toca o banco.
//   refresh token — opaco, longo, guardado **em hash**. É o que permite revogar.
//
// O refresh nunca é gravado em claro: um vazamento da tabela de sessões não pode
// virar um vazamento de sessões ativas. Mesmo raciocínio de senha.

const DURACAO_ACCESS_SEGUNDOS = 15 * 60;
const DURACAO_REFRESH_SEGUNDOS = 7 * 24 * 60 * 60;

function hashDoRefresh(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function criarAutenticacao({
  repositorio, configuracao, contas = null, limitador = null, agora = () => new Date(),
}) {
  const segredo = configuracao.autenticacao.segredoJwt;

  function emitirAccess(usuario) {
    return emitir(
      {
        sub: String(usuario.id),
        nome: usuario.nome,
        papel: usuario.papel,
        // `master` no token evita uma ida ao banco a cada checagem de privilégio.
        master: Boolean(usuario.master),
        // P1-04: master e admin sem TOTP ativo recebem o token marcado, e o
        // servidor só os deixa ir até as rotas de autenticação — onde está o
        // endpoint que ativa o segundo fator. Privilégio sem 2FA não opera.
        ...(configuracao.autenticacao.segundoFatorObrigatorio !== false
          && (usuario.master || usuario.papel === 'admin') && !usuario.totp_ativo
          ? { p2f: true }
          : {}),
      },
      segredo,
      DURACAO_ACCESS_SEGUNDOS,
    );
  }

  async function abrirSessao(usuario, { agente = null, ip = null } = {}) {
    const refresh = crypto.randomBytes(32).toString('base64url');
    const expiraEm = new Date(agora().getTime() + DURACAO_REFRESH_SEGUNDOS * 1000);

    await repositorio.criarSessao({
      usuarioId: usuario.id,
      hashRefresh: hashDoRefresh(refresh),
      expiraEm: expiraEm.toISOString(),
      agente,
      ip,
    });

    await repositorio.atualizarUsuario(usuario.id, { ultimoLoginEm: agora().toISOString() });

    return {
      access_token: emitirAccess(usuario),
      refresh_token: refresh,
      expira_em: DURACAO_ACCESS_SEGUNDOS,
      usuario: contas
        ? contas.retratoDoUsuario(usuario)
        : {
          id: usuario.id,
          nome: usuario.nome,
          papel: usuario.papel,
          permissoes: permissoesDoPapel(usuario.papel),
        },
    };
  }

  /**
   * Autentica e abre sessão.
   *
   * Usuário inexistente e senha errada devolvem exatamente a mesma resposta, e o
   * hash é conferido nos dois casos: responder mais rápido para e-mail inexistente
   * entregaria a lista de quem tem conta.
   */
  async function entrar(email, senha, contexto = {}) {
    const ip = contexto.ip ?? null;

    // O limite vem antes de tudo: assim quem está varrendo senhas não descobre
    // nada com a resposta e não consome o scrypt, que é caro de propósito.
    if (limitador) await limitador.exigirDentroDoLimite({ ip, email, acao: 'login' });

    const usuario = await repositorio.obterUsuarioPorEmail(email);
    const hashDeReferencia = usuario?.senha_hash
      ?? '$scrypt$16384$8$1$00$00'; // formato inválido de propósito: `conferir` devolve false

    const senhaConfere = await conferir(senha, hashDeReferencia);

    if (!usuario || !senhaConfere) {
      if (limitador) await limitador.registrar({ ip, email, acao: 'login', sucesso: false });

      await repositorio.registrarAuditoria({
        entidade: 'usuario',
        entidadeId: usuario?.id ?? null,
        acao: 'login_recusado',
        // Sem senha e sem e-mail no log: auditoria não pode virar vazamento.
        detalhe: { motivo: usuario ? 'credencial_invalida' : 'usuario_desconhecido' },
      });
      const erro = new Error('credenciais inválidas');
      erro.status = 401;
      throw erro;
    }

    // Credencial certa, mas conta não liberada: a pessoa merece saber que está na
    // fila em vez de achar que errou a senha. Só chega aqui quem provou ser quem diz.
    if (contas && !contas.podeEntrar(usuario)) {
      await repositorio.registrarAuditoria({
        entidade: 'usuario',
        entidadeId: usuario.id,
        acao: 'login_bloqueado',
        detalhe: { situacao: usuario.situacao },
      });
      throw contas.erroDeSituacao(usuario.situacao);
    }
    if (!contas && !usuario.ativo) {
      const erro = new Error('credenciais inválidas');
      erro.status = 401;
      throw erro;
    }

    // Segundo fator, quando a pessoa ativou.
    if (contas && usuario.totp_ativo) {
      const codigo = contexto.codigo ?? null;
      if (!codigo) {
        const erro = new Error('código do segundo fator é obrigatório');
        erro.status = 401;
        erro.segundoFator = 'obrigatorio';
        throw erro;
      }
      if (!(await contas.segundoFatorConfere(usuario, codigo))) {
        // Código errado conta como falha: senão o segundo fator viraria o elo
        // sem limite, testável à vontade por quem já tem a senha.
        if (limitador) await limitador.registrar({ ip, email, acao: 'login', sucesso: false });

        await repositorio.registrarAuditoria({
          entidade: 'usuario', entidadeId: usuario.id, acao: 'segundo_fator_recusado',
        });
        const erro = new Error('código do segundo fator incorreto');
        erro.status = 401;
        erro.segundoFator = 'incorreto';
        throw erro;
      }
    }

    if (limitador) await limitador.registrar({ ip, email, acao: 'login', sucesso: true });

    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuario.id,
      acao: 'login',
      usuarioId: usuario.id,
    });

    return abrirSessao(usuario, contexto);
  }

  /** Abre sessão para quem já teve a identidade confirmada por outro caminho (Google). */
  async function abrirSessaoDireta(usuario, contexto = {}) {
    await repositorio.registrarAuditoria({
      entidade: 'usuario', entidadeId: usuario.id, acao: 'login_google', usuarioId: usuario.id,
    });
    return abrirSessao(usuario, contexto);
  }

  /**
   * Troca o refresh por um novo par.
   *
   * O refresh usado é revogado na troca (rotação): se um token vazar e for usado,
   * o legítimo para de funcionar e o problema aparece em vez de passar despercebido.
   */
  async function renovar(refreshToken, contexto = {}) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      const erro = new Error('refresh token ausente');
      erro.status = 401;
      throw erro;
    }

    const sessao = await repositorio.obterSessaoPorHash(hashDoRefresh(refreshToken));
    if (!sessao || sessao.revogada_em || new Date(sessao.expira_em) <= agora()) {
      const erro = new Error('sessão inválida ou expirada');
      erro.status = 401;
      throw erro;
    }

    const usuario = await repositorio.obterUsuarioPorId(sessao.usuario_id);
    const aindaPode = contas ? contas.podeEntrar(usuario) : Boolean(usuario?.ativo);
    if (!aindaPode) {
      // Quem foi desativado depois de entrar não renova: a revogação alcança
      // a sessão em curso, não só os logins futuros.
      await repositorio.revogarSessao(sessao.id);
      const erro = new Error('usuário inativo');
      erro.status = 401;
      throw erro;
    }

    await repositorio.revogarSessao(sessao.id);
    return abrirSessao(usuario, contexto);
  }

  async function sair(refreshToken) {
    if (!refreshToken) return { encerrada: false };

    const sessao = await repositorio.obterSessaoPorHash(hashDoRefresh(refreshToken));
    if (!sessao) return { encerrada: false };

    await repositorio.revogarSessao(sessao.id);
    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: sessao.usuario_id,
      acao: 'logout',
      usuarioId: sessao.usuario_id,
    });
    return { encerrada: true };
  }

  /** Lê o portador do cabeçalho e devolve o usuário, ou `null`. */
  function identificar(cabecalhoAutorizacao) {
    if (typeof cabecalhoAutorizacao !== 'string') return null;

    const [esquema, token] = cabecalhoAutorizacao.split(' ');
    if (!/^bearer$/i.test(esquema || '') || !token) return null;

    const { valido, conteudo } = verificar(token, segredo);
    if (!valido) return null;

    return {
      id: Number(conteudo.sub),
      nome: conteudo.nome,
      papel: conteudo.papel,
      master: Boolean(conteudo.master),
      // A marca de "segundo fator pendente" atravessa para o guarda do http.
      p2f: conteudo.p2f === true,
      permissoes: permissoesDoPapel(conteudo.papel),
    };
  }

  return {
    entrar,
    abrirSessaoDireta,
    renovar,
    sair,
    identificar,
    DURACAO_ACCESS_SEGUNDOS,
    DURACAO_REFRESH_SEGUNDOS,
  };
}

module.exports = { criarAutenticacao, hashDoRefresh, DURACAO_ACCESS_SEGUNDOS, DURACAO_REFRESH_SEGUNDOS };
