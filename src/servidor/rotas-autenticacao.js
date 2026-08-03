'use strict';

const crypto = require('node:crypto');
const { ErroDeContrato } = require('../contratos/erros');
const { PAPEIS, exigirPermissao } = require('../seguranca/rbac');

// Rotas de conta e sessão da equipe.
//
// Nenhuma delas devolve hash de senha, segredo do segundo fator ou refresh de
// outra sessão. O refresh só aparece para quem acabou de autenticar.

const TAMANHO_MINIMO_SENHA = 8;

function exigirTexto(valor, campo, limite = 200) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

/**
 * Valida a senha nova.
 * Comprimento mínimo e nada de senha só de repetição — sem transformar em ginástica
 * de símbolos, que empurra as pessoas para o post-it no monitor.
 */
function exigirSenhaNova(valor, campo = 'senha_nova') {
  const senha = typeof valor === 'string' ? valor : '';
  if (senha.length < TAMANHO_MINIMO_SENHA) {
    throw new ErroDeContrato(`a senha precisa ter ao menos ${TAMANHO_MINIMO_SENHA} caracteres`, campo);
  }
  if (/^(.)\1*$/.test(senha)) {
    throw new ErroDeContrato('a senha não pode ser um único caractere repetido', campo);
  }
  return senha;
}

function exigirEmail(valor, campo = 'email') {
  const email = exigirTexto(valor, campo, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErroDeContrato(`campo "${campo}" não é um e-mail válido`, campo);
  }
  return email;
}

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function criarRotasDeAutenticacao({ repositorio, autenticacao, contas, google, configuracao }) {
  // `state` do OAuth: guardado por alguns minutos para amarrar o retorno do Google
  // à requisição que o originou. Em memória basta — é efêmero por natureza.
  const estadosPendentes = new Map();

  function guardarEstado() {
    const estado = crypto.randomBytes(16).toString('base64url');
    estadosPendentes.set(estado, Date.now() + 10 * 60 * 1000);

    for (const [chave, validade] of estadosPendentes) {
      if (validade < Date.now()) estadosPendentes.delete(chave);
    }
    return estado;
  }

  function consumirEstado(estado) {
    const validade = estadosPendentes.get(estado);
    estadosPendentes.delete(estado);
    return Boolean(validade && validade >= Date.now());
  }

  function exigirMaster(usuario) {
    if (!usuario) {
      const erro = new Error('autenticação obrigatória');
      erro.status = 401;
      throw erro;
    }
    if (!usuario.master) {
      const erro = new Error('apenas o administrador master pode fazer isso');
      erro.status = 403;
      throw erro;
    }
  }

  return {
    /** GET /api/auth/opcoes — o que a tela de login deve oferecer. */
    async opcoesDeEntrada() {
      return {
        google: Boolean(google?.disponivel),
        recuperacao_por_email: Boolean(configuracao.email.host && configuracao.email.remetente),
        cadastro_aberto: true,
      };
    },

    /** POST /api/auth/login */
    async entrar(corpo, contexto) {
      const email = exigirTexto(corpo?.email, 'email', 254);
      const senha = exigirTexto(corpo?.senha, 'senha');

      return autenticacao.entrar(email, senha, { ...contexto, codigo: corpo?.codigo ?? null });
    },

    /** POST /api/auth/refresh — rotaciona: o refresh usado é revogado. */
    async renovar(corpo, contexto) {
      const refresh = exigirTexto(corpo?.refresh_token, 'refresh_token', 500);
      return autenticacao.renovar(refresh, contexto);
    },

    /** POST /api/auth/logout */
    async sair(corpo) {
      return autenticacao.sair(corpo?.refresh_token ?? null);
    },

    /** GET /api/auth/sessao — quem sou eu e o que posso fazer. */
    async sessaoAtual(usuario) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }
      const atual = await repositorio.obterUsuarioPorId(usuario.id);
      return { usuario: contas.retratoDoUsuario(atual) };
    },

    /** POST /api/auth/cadastro — abre uma conta, que nasce aguardando liberação. */
    async cadastrar(corpo) {
      const nome = exigirTexto(corpo?.nome, 'nome', 120);
      const email = exigirEmail(corpo?.email);
      const senha = exigirSenhaNova(corpo?.senha, 'senha');

      try {
        const criado = await contas.cadastrar({ nome, email, senha });
        return {
          cadastrado: true,
          situacao: criado.situacao,
          detalhe: 'Cadastro recebido. Você poderá entrar assim que o administrador liberar o acesso.',
        };
      } catch (erro) {
        if (erro.codigo === 'usuario_duplicado' || erro.code === '23505') {
          // Mesma resposta de sucesso: dizer "já existe" entregaria quem tem conta.
          return {
            cadastrado: true,
            situacao: 'pendente',
            detalhe: 'Cadastro recebido. Você poderá entrar assim que o administrador liberar o acesso.',
          };
        }
        throw erro;
      }
    },

    // ---------------------------------------------------------------- Google

    /** GET /api/auth/google — devolve para onde mandar a pessoa. */
    async iniciarGoogle() {
      if (!google?.disponivel) {
        const erro = new Error('login com Google não está configurado');
        erro.status = 503;
        throw erro;
      }
      return { url: google.montarUrlDeAutorizacao(guardarEstado()) };
    },

    /** GET /api/auth/google/retorno?code=…&state=… */
    async retornoGoogle(parametros, contexto) {
      const codigo = parametros.get('code');
      const estado = parametros.get('state');

      if (!codigo) throw new ErroDeContrato('código de autorização ausente', 'code');
      // Sem o `state` que emitimos, o retorno pode ter vindo de outro lugar.
      if (!estado || !consumirEstado(estado)) {
        const erro = new Error('estado do login inválido ou expirado');
        erro.status = 401;
        throw erro;
      }

      const usuario = await contas.entrarComGoogle(codigo);
      return autenticacao.abrirSessaoDireta(usuario, contexto);
    },

    // ---------------------------------------------------------------- senha

    /** POST /api/auth/senha — trocar a própria senha. */
    async trocarSenha(usuario, corpo) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }

      const senhaNova = exigirSenhaNova(corpo?.senha_nova);
      return contas.trocarSenha(usuario.id, corpo?.senha_atual ?? '', senhaNova);
    },

    /**
     * POST /api/usuarios/:id/senha — o master define uma senha temporária.
     *
     * É o caminho de recuperação quando não há SMTP: o admin gera, entrega
     * pessoalmente, e a troca é exigida no primeiro acesso. A senha aparece
     * **uma vez** nesta resposta e não é guardada em lugar nenhum.
     */
    async definirSenhaTemporaria(master, usuarioId) {
      if (!master?.master) {
        const erro = new Error('apenas o administrador master redefine a senha de outra conta');
        erro.status = 403;
        throw erro;
      }

      const id = Number(usuarioId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ErroDeContrato('identificador de usuário inválido', 'usuario_id');
      }
      if (id === master.id) {
        // O master troca a própria senha pelo fluxo normal, que exige a atual.
        const erro = new Error('para a sua própria senha, use a troca de senha');
        erro.status = 409;
        throw erro;
      }

      return contas.definirSenhaTemporaria(id, { porUsuarioId: master.id });
    },

    /** POST /api/auth/recuperar — pede o link por e-mail. */
    async pedirRecuperacao(corpo, contexto) {
      const email = exigirTexto(corpo?.email, 'email', 254);
      await contas.pedirRecuperacao(email, contexto);

      // Resposta idêntica com ou sem conta: a diferença revelaria quem tem cadastro.
      return {
        solicitado: true,
        detalhe: 'Se houver uma conta com esse e-mail, o link de redefinição foi enviado.',
      };
    },

    /** POST /api/auth/redefinir — usa o token do e-mail. */
    async redefinirSenha(corpo, contexto = {}) {
      const token = exigirTexto(corpo?.token, 'token', 500);
      const senhaNova = exigirSenhaNova(corpo?.senha_nova);

      return contas.redefinirSenha(token, senhaNova, contexto);
    },

    // ---------------------------------------------------------------- segundo fator

    async prepararSegundoFator(usuario) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }
      return contas.prepararSegundoFator(usuario.id);
    },

    async confirmarSegundoFator(usuario, corpo) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }
      return contas.confirmarSegundoFator(usuario.id, exigirTexto(corpo?.codigo, 'codigo', 10));
    },

    async desativarSegundoFator(usuario, corpo) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }
      return contas.desativarSegundoFator(usuario.id, corpo?.senha ?? '');
    },

    // ---------------------------------------------------------------- perfil

    /** PUT /api/perfil — dados que a própria pessoa mantém. */
    async atualizarPerfil(usuario, corpo) {
      if (!usuario) {
        const erro = new Error('autenticação obrigatória');
        erro.status = 401;
        throw erro;
      }

      const campos = {};
      if (corpo?.nome !== undefined) campos.nome = exigirTexto(corpo.nome, 'nome', 120);
      if (corpo?.telefone !== undefined) {
        campos.telefone = corpo.telefone === null ? null : String(corpo.telefone).trim().slice(0, 40);
      }
      if (Object.keys(campos).length === 0) {
        throw new ErroDeContrato('informe ao menos um campo do perfil');
      }

      const atualizado = await repositorio.atualizarUsuario(usuario.id, campos);
      await repositorio.registrarAuditoria({
        entidade: 'usuario', entidadeId: usuario.id, acao: 'perfil_atualizado', usuarioId: usuario.id,
      });

      return { usuario: contas.retratoDoUsuario(atualizado) };
    },

    // ---------------------------------------------------------------- usuários (master)

    /** GET /api/usuarios */
    async listarUsuarios(usuario, parametros) {
      exigirPermissao(usuario, 'usuarios:gerenciar');

      const situacao = parametros?.get?.('situacao') || null;
      if (situacao && !contas.SITUACOES.includes(situacao)) {
        throw new ErroDeContrato(`situação deve ser uma de: ${contas.SITUACOES.join(', ')}`, 'situacao');
      }

      const lista = await repositorio.listarUsuarios({ situacao });
      return {
        usuarios: lista.map((item) => contas.retratoDoUsuario(item)),
        pendentes: lista.filter((item) => item.situacao === 'pendente').length,
      };
    },

    /** POST /api/usuarios — criação pelo master, já liberada. */
    async criarUsuario(usuario, corpo) {
      exigirMaster(usuario);

      const nome = exigirTexto(corpo?.nome, 'nome', 120);
      const email = exigirEmail(corpo?.email);
      const senha = exigirSenhaNova(corpo?.senha, 'senha');
      const papel = corpo?.papel ?? 'atendente';

      if (!PAPEIS.includes(papel)) {
        throw new ErroDeContrato(`campo "papel" deve ser um de: ${PAPEIS.join(', ')}`, 'papel');
      }

      try {
        const criado = await contas.cadastrar({ nome, email, senha, papel }, usuario);
        return { usuario: criado };
      } catch (erro) {
        if (erro.codigo === 'usuario_duplicado' || erro.code === '23505') {
          throw new ErroDeContrato('e-mail já cadastrado', 'email');
        }
        throw erro;
      }
    },

    /** POST /api/usuarios/:id/situacao — liberar, recusar ou desativar. */
    async definirSituacao(usuario, alvoId, corpo) {
      exigirMaster(usuario);

      const id = exigirIdentificador(alvoId, 'usuario_id');
      const situacao = exigirTexto(corpo?.situacao, 'situacao', 20);

      return { usuario: await contas.definirSituacao(usuario, id, situacao) };
    },

    /** POST /api/usuarios/:id/papel */
    async definirPapel(usuario, alvoId, corpo) {
      exigirMaster(usuario);

      const id = exigirIdentificador(alvoId, 'usuario_id');
      const papel = exigirTexto(corpo?.papel, 'papel', 20);
      if (!PAPEIS.includes(papel)) {
        throw new ErroDeContrato(`campo "papel" deve ser um de: ${PAPEIS.join(', ')}`, 'papel');
      }

      const alvo = await repositorio.obterUsuarioPorId(id);
      if (!alvo) {
        const erro = new Error('usuário não encontrado');
        erro.status = 404;
        throw erro;
      }
      if (alvo.master) {
        const erro = new Error('o papel do administrador master não pode ser alterado');
        erro.status = 409;
        throw erro;
      }

      const atualizado = await repositorio.atualizarUsuario(id, { papel });
      await repositorio.registrarAuditoria({
        entidade: 'usuario', entidadeId: id, acao: 'papel_alterado',
        detalhe: { papel }, usuarioId: usuario.id,
      });

      return { usuario: contas.retratoDoUsuario(atualizado) };
    },
  };
}

module.exports = { criarRotasDeAutenticacao, TAMANHO_MINIMO_SENHA };
