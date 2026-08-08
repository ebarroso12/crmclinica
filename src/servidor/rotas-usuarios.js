'use strict';

// Rotas da gestão de usuários, contatos estruturados, termos, deduplicação,
// qualidade cadastral e onboarding (P1-01 a P1-09, P2-10, P3-01).
//
// O módulo é fino de propósito: valida a forma do pedido e delega ao serviço,
// que é onde as regras duras moram (auditoria de papel, revogação de sessão,
// cifra de documento). Rota que decide regra de negócio vira exceção sem
// teste — por isso aqui só há tradução HTTP.

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function criarRotasDeUsuarios({ repositorio, usuarios, deduplicacao, qualidade, onboarding }) {
  return {
    // ------------------------------------------------------------ usuários

    /** GET /api/usuarios/gestao — lista completa para a tela de gestão. */
    async listar(usuario) {
      exigirPermissao(usuario, 'usuarios:gerenciar');
      return { usuarios: await repositorio.listarUsuarios({}) };
    },

    /** GET /api/usuarios/:id — ficha completa, sem documentos em claro. */
    async obter(usuario, usuarioId) {
      const ficha = await usuarios.obterFichaDoUsuario(usuario, exigirIdentificador(usuarioId, 'id'));
      return { usuario: ficha };
    },

    /** PUT /api/usuarios/:id — edição completa (P1-01/P1-05). */
    async editar(usuario, usuarioId, corpo) {
      const atualizado = await usuarios.editarUsuarioCompleto(
        usuario,
        exigirIdentificador(usuarioId, 'id'),
        corpo ?? {},
      );
      return { usuario: atualizado };
    },

    /** GET /api/usuarios/:id/cpf — decifrar é operação auditada (P1-05). */
    async revelarCpf(usuario, usuarioId) {
      const cpf = await usuarios.revelarCpfDoUsuario(usuario, exigirIdentificador(usuarioId, 'id'));
      return { cpf };
    },

    /** POST /api/usuarios/:id/suspender — derruba as sessões junto (P1-02). */
    async suspender(usuario, usuarioId, corpo) {
      const atualizado = await usuarios.suspenderUsuario(
        usuario,
        exigirIdentificador(usuarioId, 'id'),
        { motivo: corpo?.motivo ?? null },
      );
      return { usuario: atualizado };
    },

    async reativar(usuario, usuarioId) {
      const atualizado = await usuarios.reativarUsuario(usuario, exigirIdentificador(usuarioId, 'id'));
      return { usuario: atualizado };
    },

    /** DELETE /api/usuarios/:id — exclusão lógica; a autoria fica (P1-02). */
    async excluir(usuario, usuarioId, corpo) {
      const atualizado = await usuarios.excluirUsuario(
        usuario,
        exigirIdentificador(usuarioId, 'id'),
        { motivo: corpo?.motivo ?? null },
      );
      return { usuario: atualizado };
    },

    // ------------------------------------------------------------ sessões (P1-03)

    async listarSessoes(usuario, usuarioId) {
      const sessoes = await usuarios.listarSessoes(usuario, exigirIdentificador(usuarioId, 'id'));
      return { sessoes };
    },

    async revogarSessao(usuario, usuarioId, sessaoId) {
      const revogada = await usuarios.revogarSessao(
        usuario,
        exigirIdentificador(usuarioId, 'id'),
        exigirIdentificador(sessaoId, 'sessao_id'),
      );
      if (!revogada) {
        const erro = new Error('sessão não encontrada ou já revogada');
        erro.status = 404;
        throw erro;
      }
      return { revogada: true };
    },

    // ------------------------------------------------------------ whatsapp particular (P1-06)

    async autorizarWhatsapp(usuario, usuarioId, corpo) {
      const atualizado = await usuarios.autorizarWhatsappParticular(
        usuario,
        exigirIdentificador(usuarioId, 'id'),
        { autorizado: corpo?.autorizado === true },
      );
      return { usuario: atualizado };
    },

    // ------------------------------------------------------------ termos (P1-07)

    async obterTermoVigente(usuario, parametros) {
      exigirPermissao(usuario, 'conversas:ler');
      const escopo = parametros.get('escopo') || 'equipe';
      const termo = await usuarios.obterTermoVigente(escopo);
      return { termo };
    },

    async listarTermos(usuario, parametros) {
      const termos = await usuarios.listarTermos(usuario, parametros.get('escopo') || null);
      return { termos };
    },

    async criarTermo(usuario, corpo) {
      const termo = await usuarios.criarVersaoDeTermo(usuario, {
        escopo: corpo?.escopo,
        titulo: corpo?.titulo ?? null,
        texto: corpo?.texto,
        publicar: corpo?.publicar === true,
      });
      return { termo };
    },

    async publicarTermo(usuario, termoId) {
      const termo = await usuarios.publicarTermo(usuario, exigirIdentificador(termoId, 'id'));
      if (!termo) {
        const erro = new Error('termo não encontrado');
        erro.status = 404;
        throw erro;
      }
      return { termo };
    },

    async assinarTermo(usuario, termoId, corpo) {
      const assinatura = await usuarios.registrarAssinatura(usuario, {
        termoId: exigirIdentificador(termoId, 'id'),
        usuarioId: corpo?.usuario_id ?? null,
        contatoId: corpo?.contato_id ?? null,
        assinaturaExternaId: corpo?.assinatura_externa_id ?? null,
        provedor: corpo?.provedor ?? null,
      });
      return { assinatura };
    },

    // ------------------------------------------------------------ responsável (P1-08)

    async registrarResponsavel(usuario, contatoId, corpo) {
      const contato = await usuarios.registrarResponsavel(
        usuario,
        exigirIdentificador(contatoId, 'id'),
        {
          nome: corpo?.nome,
          cpf: corpo?.cpf ?? null,
          parentesco: corpo?.parentesco ?? null,
          consentimentoCanal: corpo?.consentimento_canal ?? null,
          consentimentoTermoId: corpo?.consentimento_termo_id ?? null,
        },
      );
      return { contato };
    },

    // ------------------------------------------------------------ deduplicação (P1-09)

    async buscarDuplicatas(usuario, parametros) {
      const pares = await deduplicacao.buscarDuplicatas(usuario, {
        limite: Number(parametros.get('limite') ?? 20),
      });
      return { pares };
    },

    async fundirContatos(usuario, corpo) {
      const resultado = await deduplicacao.fundir(usuario, {
        vencedorId: exigirIdentificador(corpo?.vencedor_id, 'vencedor_id'),
        perdedorId: exigirIdentificador(corpo?.perdedor_id, 'perdedor_id'),
      });
      return resultado;
    },

    // ------------------------------------------------------------ qualidade (P2-10)

    async qualidadeCadastral(usuario) {
      return qualidade.relatorio(usuario);
    },

    // ------------------------------------------------------------ onboarding (P3-01)

    async trilhaDoOnboarding(usuario) {
      // A trilha é da própria pessoa: cada um vê a sua, sem permissão especial.
      const completo = await repositorio.obterUsuarioPorId(usuario.id);
      return { passos: onboarding.trilhaPara(completo ?? usuario) };
    },

    async ajudaContextual(usuario, parametros) {
      exigirPermissao(usuario, 'conversas:ler');
      const tela = parametros.get('tela') ?? '';
      return { tela, dica: onboarding.ajudaDaTela(tela) };
    },
  };
}

module.exports = { criarRotasDeUsuarios };
