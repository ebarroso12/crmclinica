'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { PAPEIS, permissoesDoPapel, exigirPermissao } = require('../seguranca/rbac');
const { gerarHash } = require('../seguranca/senha');

// Rotas de sessão da equipe. Nenhuma delas devolve hash de senha ou refresh de
// outra sessão; o refresh só aparece para quem acabou de autenticar.

function exigirTexto(valor, campo, limite = 200) {
  const bruto = typeof valor === 'string' ? valor.trim() : '';
  if (!bruto) throw new ErroDeContrato(`campo "${campo}" é obrigatório`, campo);
  if (bruto.length > limite) throw new ErroDeContrato(`campo "${campo}" excede ${limite} caracteres`, campo);
  return bruto;
}

function criarRotasDeAutenticacao({ repositorio, autenticacao }) {
  return {
    /** POST /api/auth/login */
    async entrar(corpo, contexto) {
      const email = exigirTexto(corpo?.email, 'email');
      const senha = exigirTexto(corpo?.senha, 'senha');

      return autenticacao.entrar(email, senha, contexto);
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
      return {
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          papel: usuario.papel,
          permissoes: permissoesDoPapel(usuario.papel),
        },
      };
    },

    /** POST /api/usuarios — apenas admin. */
    async criarUsuario(usuario, corpo) {
      exigirPermissao(usuario, 'usuarios:gerenciar');

      const nome = exigirTexto(corpo?.nome, 'nome');
      const email = exigirTexto(corpo?.email, 'email');
      const senha = exigirTexto(corpo?.senha, 'senha');
      const papel = corpo?.papel ?? 'atendente';

      if (!PAPEIS.includes(papel)) {
        throw new ErroDeContrato(`campo "papel" deve ser um de: ${PAPEIS.join(', ')}`, 'papel');
      }
      if (senha.length < 8) {
        throw new ErroDeContrato('a senha precisa ter ao menos 8 caracteres', 'senha');
      }

      try {
        const criado = await repositorio.criarUsuario({ nome, email, senhaHash: await gerarHash(senha), papel });
        await repositorio.registrarAuditoria({
          entidade: 'usuario',
          entidadeId: criado.id,
          acao: 'usuario_criado',
          detalhe: { papel },
          usuarioId: usuario.id,
        });
        return { usuario: criado };
      } catch (erro) {
        if (erro.codigo === 'usuario_duplicado' || erro.code === '23505') {
          throw new ErroDeContrato('e-mail já cadastrado', 'email');
        }
        throw erro;
      }
    },

    /** GET /api/usuarios — apenas admin. */
    async listarUsuarios(usuario) {
      exigirPermissao(usuario, 'usuarios:gerenciar');
      return { usuarios: await repositorio.listarUsuarios() };
    },
  };
}

module.exports = { criarRotasDeAutenticacao };
