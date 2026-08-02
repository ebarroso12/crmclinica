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

function criarAutenticacao({ repositorio, configuracao, agora = () => new Date() }) {
  const segredo = configuracao.autenticacao.segredoJwt;

  function emitirAccess(usuario) {
    return emitir(
      { sub: String(usuario.id), nome: usuario.nome, papel: usuario.papel },
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

    return {
      access_token: emitirAccess(usuario),
      refresh_token: refresh,
      expira_em: DURACAO_ACCESS_SEGUNDOS,
      usuario: {
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
    const usuario = await repositorio.obterUsuarioPorEmail(email);
    const hashDeReferencia = usuario?.senha_hash
      ?? '$scrypt$16384$8$1$00$00'; // formato inválido de propósito: `conferir` devolve false

    const senhaConfere = await conferir(senha, hashDeReferencia);

    if (!usuario || !usuario.ativo || !senhaConfere) {
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

    await repositorio.registrarAuditoria({
      entidade: 'usuario',
      entidadeId: usuario.id,
      acao: 'login',
      usuarioId: usuario.id,
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
    if (!usuario || !usuario.ativo) {
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
      permissoes: permissoesDoPapel(conteudo.papel),
    };
  }

  return {
    entrar,
    renovar,
    sair,
    identificar,
    DURACAO_ACCESS_SEGUNDOS,
    DURACAO_REFRESH_SEGUNDOS,
  };
}

module.exports = { criarAutenticacao, hashDoRefresh, DURACAO_ACCESS_SEGUNDOS, DURACAO_REFRESH_SEGUNDOS };
