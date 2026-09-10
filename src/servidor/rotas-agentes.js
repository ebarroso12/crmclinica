'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao, podeFazer } = require('../seguranca/rbac');

// API dos agentes configuráveis — mesmo molde de rotas-instagram.js:
// `exigirPermissao` é a PRIMEIRA linha de toda rota (antes até de validar o
// id: quem não tem sessão recebe 401, não um 400 que confirmaria a forma da
// rota), `exigirIdentificador` para parâmetro de caminho.
//
// `servico` é o que `criarServicoDeAgentes` (src/dominio/agentes/servico.js)
// devolve; `gateway` é o gateway multi-IA, usado só para o catálogo de modelos.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function criarRotasDeAgentes({ servico, gateway = null }) {
  if (!servico) throw new Error('rotas de agentes exigem o serviço de agentes');

  /**
   * O catálogo vem do banco pelo gateway. Uma falha nele não pode derrubar a
   * tela inteira de agentes — já aconteceu com a tela da Serena quando um
   * gateway externo caiu. Sem catálogo, o seletor de modelo fica vazio e o
   * resto funciona.
   */
  async function catalogoSeguro() {
    if (!gateway?.catalogo) return [];
    try {
      return await gateway.catalogo();
    } catch (erro) {
      console.error(`[agentes] catálogo de modelos indisponível: ${erro.message}`);
      return [];
    }
  }

  const podeGerenciar = (usuario) => podeFazer(usuario?.papel, 'agentes:gerenciar');

  return {
    /** GET /api/agentes */
    async listar(usuario) {
      exigirPermissao(usuario, 'agentes:ler');
      const [agentes, catalogo] = await Promise.all([servico.listar(), catalogoSeguro()]);
      return { agentes, catalogo, pode_gerenciar: podeGerenciar(usuario) };
    },

    /** GET /api/agentes/:id */
    async obter(usuario, id) {
      exigirPermissao(usuario, 'agentes:ler');
      const detalhe = await servico.obter(exigirIdentificador(id, 'agente_id'));
      return { ...detalhe, pode_gerenciar: podeGerenciar(usuario) };
    },

    /** POST /api/agentes */
    async criar(usuario, corpo) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      return { agente: await servico.criar(corpo, { usuarioId: usuario.id }) };
    },

    /** PUT /api/agentes/:id */
    async atualizar(usuario, id, corpo) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      return { agente: await servico.atualizar(agenteId, corpo, { usuarioId: usuario.id }) };
    },

    /** POST /api/agentes/:id/comportamento/:historicoId/restaurar */
    async restaurarComportamento(usuario, id, historicoId) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      const versao = exigirIdentificador(historicoId, 'historico_id');
      return { agente: await servico.restaurarComportamento(agenteId, versao, { usuarioId: usuario.id }) };
    },

    /** POST /api/agentes/:id/treinamentos */
    async adicionarTreinamento(usuario, id, corpo) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      return { treinamento: await servico.adicionarTreinamento(agenteId, corpo, { usuarioId: usuario.id }) };
    },

    /** DELETE /api/agentes/:id/treinamentos/:treinamentoId */
    async removerTreinamento(usuario, id, treinamentoId) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      const alvo = exigirIdentificador(treinamentoId, 'treinamento_id');
      await servico.removerTreinamento(agenteId, alvo, { usuarioId: usuario.id });
      return { removido: true };
    },

    /** PUT /api/agentes/:id/inatividade — corpo `{ acoes: [...] }`, substitui todas. */
    async definirInatividade(usuario, id, corpo) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      return { acoes: await servico.definirInatividade(agenteId, corpo?.acoes, { usuarioId: usuario.id }) };
    },

    /** PUT /api/agentes/:id/canais — corpo `{ canais: [...] }`, substitui todos. */
    async definirCanais(usuario, id, corpo) {
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      return { canais: await servico.definirCanais(agenteId, corpo?.canais, { usuarioId: usuario.id }) };
    },

    /** POST /api/agentes/:id/teste — corpo `{ mensagens: [{ autor, texto }] }`. Não grava nem envia. */
    async testar(usuario, id, corpo) {
      // Gerenciar, não ler: cada teste é uma chamada de IA paga, e é parte de
      // configurar o agente — não de acompanhar a operação.
      exigirPermissao(usuario, 'agentes:gerenciar');
      const agenteId = exigirIdentificador(id, 'agente_id');
      return servico.testar(agenteId, { mensagens: corpo?.mensagens });
    },
  };
}

module.exports = { criarRotasDeAgentes };
