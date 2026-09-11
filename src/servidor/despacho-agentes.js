'use strict';

// Despacho HTTP das rotas de agentes (tabela "API" de docs/AGENTES.md).
//
// Mesmo molde de `tratarRotasDeInstagram` em src/servidor/http.js — mapa
// 'METODO /rota' para as rotas sem id, `partes` para as com id, 201 em
// criação, 405 com `allow` quando o caminho existe e o método não, 404 no fim
// e `cache-control: no-store` em tudo. Fica num arquivo próprio para o
// roteamento ter teste HTTP sem subir a aplicação inteira; o http.js só chama
// `tratar`.
//
// `ehRotaLenta` existe por causa de uma lição do http.js: rota que espera
// modelo de IA ou site externo não pode rodar dentro da transação com
// identidade — prenderia uma conexão do pool por segundos. Quem integra decide
// onde chamá-la; este arquivo só diz quais são.

const { exigirPermissao } = require('../seguranca/rbac');

const PREFIXO = '/api/agentes';
const SEM_CACHE = Object.freeze({ 'cache-control': 'no-store' });

function criarDespachoDeAgentes({ rotas, lerJson, responderJson }) {
  if (!rotas || typeof lerJson !== 'function' || typeof responderJson !== 'function') {
    throw new Error('o despacho de agentes exige rotas, lerJson e responderJson');
  }

  function ehDoPrefixo(rota) {
    return rota === PREFIXO || rota.startsWith(`${PREFIXO}/`);
  }

  function ehRotaDeTeste(rota, metodo) {
    return metodo === 'POST' && /^\/api\/agentes\/[^/]+\/teste$/.test(rota);
  }

  /** Teste (chama o modelo) e novo treinamento (pode buscar um site por até 10s). */
  function ehRotaLenta(rota, metodo) {
    return ehRotaDeTeste(rota, metodo)
      || (metodo === 'POST' && /^\/api\/agentes\/[^/]+\/treinamentos$/.test(rota));
  }

  function responder(res, status, dados) {
    responderJson(res, status, dados, SEM_CACHE);
    return true;
  }

  function naoPermitido(res, allow) {
    responderJson(res, 405, { erro: 'método não permitido' }, { ...SEM_CACHE, allow });
    return true;
  }

  async function tratar(req, res, rota, metodo, url, usuario) {
    if (!ehDoPrefixo(rota)) return false;

    // Permissão ANTES de ler o corpo. Sem isto, anônimo ou atendente com corpo
    // inválido recebia 400 (ou 413) em vez de 401/403 — a leitura do corpo
    // vinha antes de a rota conferir quem pede. Ler é `agentes:ler`; todo o
    // resto (inclusive o teste, que gasta IA) é `agentes:gerenciar`. As rotas
    // continuam conferindo por conta própria: esta é a primeira porta, não a única.
    exigirPermissao(usuario, metodo === 'GET' ? 'agentes:ler' : 'agentes:gerenciar');

    const partes = rota.split('/').filter(Boolean);
    // partes: ['api', 'agentes', id, sub, alvo, acao]
    const [, , id, sub, alvo, acao] = partes;

    if (partes.length === 2) {
      if (metodo === 'GET') return responder(res, 200, await rotas.listar(usuario));
      if (metodo === 'POST') return responder(res, 201, await rotas.criar(usuario, await lerJson(req)));
      return naoPermitido(res, 'GET, POST');
    }

    if (partes.length === 3) {
      if (metodo === 'GET') return responder(res, 200, await rotas.obter(usuario, id));
      if (metodo === 'PUT') return responder(res, 200, await rotas.atualizar(usuario, id, await lerJson(req)));
      return naoPermitido(res, 'GET, PUT');
    }

    if (partes.length === 4) {
      if (sub === 'treinamentos') {
        if (metodo !== 'POST') return naoPermitido(res, 'POST');
        return responder(res, 201, await rotas.adicionarTreinamento(usuario, id, await lerJson(req)));
      }
      if (sub === 'inatividade') {
        if (metodo !== 'PUT') return naoPermitido(res, 'PUT');
        return responder(res, 200, await rotas.definirInatividade(usuario, id, await lerJson(req)));
      }
      if (sub === 'canais') {
        if (metodo !== 'PUT') return naoPermitido(res, 'PUT');
        return responder(res, 200, await rotas.definirCanais(usuario, id, await lerJson(req)));
      }
      if (sub === 'teste') {
        if (metodo !== 'POST') return naoPermitido(res, 'POST');
        return responder(res, 200, await rotas.testar(usuario, id, await lerJson(req)));
      }
    }

    if (partes.length === 5 && sub === 'treinamentos') {
      if (metodo !== 'DELETE') return naoPermitido(res, 'DELETE');
      return responder(res, 200, await rotas.removerTreinamento(usuario, id, alvo));
    }

    if (partes.length === 6 && sub === 'comportamento' && acao === 'restaurar') {
      if (metodo !== 'POST') return naoPermitido(res, 'POST');
      return responder(res, 200, await rotas.restaurarComportamento(usuario, id, alvo));
    }

    return responder(res, 404, { erro: 'rota não encontrada' });
  }

  return { tratar, ehRotaDeTeste, ehRotaLenta };
}

module.exports = { criarDespachoDeAgentes };
