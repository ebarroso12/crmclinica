'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');

// API de gatilhos de palavra do Instagram — mesmo molde de rotas-serena.js
// (bloco de regras): `exigirPermissao` em toda rota, `exigirIdentificador`
// para parâmetros de rota, e "editar" separado de "ligar/desligar" (mesmo
// raciocínio de `serena.definirRegraAtiva`: alternar é ação de um clique, não
// deve poder acontecer sem querer dentro de um salvamento comum).
//
// `servico` é o que `criarServicoDeGatilhos` (src/dominio/instagram-gatilhos.js)
// devolve.

function exigirIdentificador(valor, campo) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new ErroDeContrato(`campo "${campo}" deve ser um identificador válido`, campo);
  }
  return numero;
}

function criarRotasDeInstagram({ servico }) {
  if (!servico) throw new Error('rotas do Instagram exigem o serviço de gatilhos');

  return {
    /** GET /api/instagram/regras — `?ativas=sim` filtra só as ativas, mesmo contrato de rotas-serena.js. */
    async listarRegras(usuario, parametros) {
      exigirPermissao(usuario, 'instagram:ler');
      const regras = await servico.listarRegras({ apenasAtivas: parametros?.get('ativas') === 'sim' });
      return { regras };
    },

    /** POST /api/instagram/regras */
    async criarRegra(usuario, corpo) {
      exigirPermissao(usuario, 'instagram:gerenciar');
      const regra = await servico.criarRegra({
        nome: corpo?.nome,
        palavraGatilho: corpo?.palavra_gatilho,
        mensagemDm: corpo?.mensagem_dm,
        mensagemPublica: corpo?.mensagem_publica,
        ctaWhatsapp: corpo?.cta_whatsapp,
        usuarioId: usuario.id,
      });
      return { regra };
    },

    /** PUT /api/instagram/regras/:id */
    async editarRegra(usuario, id, corpo) {
      exigirPermissao(usuario, 'instagram:gerenciar');
      const regraId = exigirIdentificador(id, 'regra_id');

      const regra = await servico.editarRegra(regraId, {
        nome: corpo?.nome,
        palavraGatilho: corpo?.palavra_gatilho,
        mensagemDm: corpo?.mensagem_dm,
        mensagemPublica: corpo?.mensagem_publica,
        ctaWhatsapp: corpo?.cta_whatsapp,
      });
      return { regra };
    },

    /** PUT /api/instagram/regras/:id/ativa — liga/desliga, separado da edição. */
    async definirRegraAtiva(usuario, id, corpo) {
      exigirPermissao(usuario, 'instagram:gerenciar');
      if (typeof corpo?.ativa !== 'boolean') {
        throw new ErroDeContrato('campo "ativa" deve ser true ou false', 'ativa');
      }

      const regra = await servico.definirRegraAtiva(exigirIdentificador(id, 'regra_id'), corpo.ativa);
      return { regra };
    },

    /** DELETE /api/instagram/regras/:id */
    async removerRegra(usuario, id) {
      exigirPermissao(usuario, 'instagram:gerenciar');
      return servico.removerRegra(exigirIdentificador(id, 'regra_id'));
    },

    /** GET /api/instagram — estado, regras e métricas, o que a tela precisa de uma vez (mesmo padrão de `painel` em rotas-serena.js). */
    async painel(usuario) {
      exigirPermissao(usuario, 'instagram:ler');
      const [regras, metricas] = await Promise.all([
        servico.listarRegras({}),
        servico.metricas(),
      ]);

      return {
        regras,
        metricas,
        // Quem só tem `instagram:ler` vê tudo e não muda nada; a tela usa isto
        // para esconder os botões em vez de deixar o usuário descobrir com um 403.
        pode_gerenciar: usuario?.papel === 'admin',
      };
    },
  };
}

module.exports = { criarRotasDeInstagram };
