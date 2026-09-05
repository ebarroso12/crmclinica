'use strict';

// Cliente das avaliações do Google Meu Negócio (Business Profile).
//
// Duas chamadas, uma leitura e uma escrita, na API v4 — que é onde as
// avaliações continuam vivendo, separada das APIs novas de perfil:
//
//   GET  mybusiness.googleapis.com/v4/accounts/{conta}/locations/{local}/reviews
//   PUT  mybusiness.googleapis.com/v4/accounts/{conta}/locations/{local}/reviews/{id}/reply
//        corpo { "comment": "..." }
//
// (developers.google.com/my-business/content/review-data, conferida em 05/09.)
//
// ATENÇÃO — o portão que não é código: o projeto no Google Cloud só consegue
// HABILITAR a "Google My Business API" (v4) depois de um pedido de acesso
// aprovado pelo Google, e a aprovação leva dias. Sem ela, toda chamada aqui
// volta 403 por mais correto que o código esteja. Este cliente falha fechado e
// diz isso, em vez de degradar em silêncio.
//
// Mesmo modelo stateless de evolution-envio.js e instagram-envio.js: um POST,
// uma resposta, sem fila nem retry próprio.

const BASE = 'https://mybusiness.googleapis.com/v4';

function criarClienteAvaliacoesGoogle(configuracao = {}, dependencias = {}) {
  const fetchImpl = dependencias.fetchImpl || globalThis.fetch;
  const contaId = String(configuracao.contaId ?? '').trim();
  const localId = String(configuracao.localId ?? '').trim();
  const disponivel = Boolean(contaId && localId && configuracao.obterToken);
  const timeoutMs = configuracao.timeoutMs ?? 15000;

  const raiz = () => `${BASE}/accounts/${contaId}/locations/${localId}`;

  function exigirConfiguracao() {
    if (!disponivel) {
      throw new Error('avaliações do Google não configuradas (conta, local e credencial)');
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');
  }

  async function chamar(url, opcoes) {
    const token = await configuracao.obterToken();
    if (!token) throw new Error('sem credencial válida para a API do Google Meu Negócio');

    let resposta;
    try {
      resposta = await fetchImpl(url, {
        ...opcoes,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(opcoes?.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (erro) {
      const falha = new Error(`falha de rede na API do Google Meu Negócio: ${erro.message}`);
      falha.indeterminado = true;
      throw falha;
    }

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.error?.message;
      // 403 aqui quase sempre é o portão de acesso à v4, não permissão do
      // usuário — dizer isso poupa horas de caça ao escopo OAuth errado.
      const dica = resposta.status === 403
        ? ' (verifique se o acesso à Google My Business API v4 foi aprovado para este projeto)'
        : '';
      throw new Error(`${mensagem || `Google respondeu HTTP ${resposta.status}`}${dica}`);
    }

    return resposta.json().catch(() => null);
  }

  /** Uma avaliação da API, no formato que o resto do sistema entende. */
  function normalizar(bruta) {
    if (!bruta || typeof bruta !== 'object') return null;
    const id = String(bruta.reviewId ?? '').trim();
    if (!id) return null;

    const ESTRELAS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    return {
      id,
      estrelas: ESTRELAS[bruta.starRating] ?? null,
      comentario: typeof bruta.comment === 'string' ? bruta.comment : null,
      autor: bruta.reviewer?.displayName ?? null,
      criado_em: bruta.createTime ?? null,
      // `reviewReply` presente = já foi respondida. É o que evita responder
      // duas vezes sem depender só do registro local.
      respondida: Boolean(bruta.reviewReply?.comment),
    };
  }

  return {
    disponivel,

    /** As avaliações mais recentes primeiro. */
    async listar({ limite = 20 } = {}) {
      exigirConfiguracao();
      const url = `${raiz()}/reviews?pageSize=${Math.min(Math.max(Number(limite) || 20, 1), 50)}`
        + '&orderBy=updateTime%20desc';
      const dados = await chamar(url, { method: 'GET' });
      const lista = Array.isArray(dados?.reviews) ? dados.reviews : [];
      return lista.map(normalizar).filter(Boolean);
    },

    /**
     * Publica (ou substitui) a resposta pública de uma avaliação.
     *
     * `PUT` de propósito: a API não tem "criar resposta" e "editar resposta"
     * separados — o mesmo verbo cobre os dois, e é isso que torna o reenvio
     * seguro em caso de dúvida sobre o desfecho.
     */
    async responder({ avaliacaoId, texto }) {
      exigirConfiguracao();
      const id = String(avaliacaoId ?? '').trim();
      const comentario = String(texto ?? '').trim();
      if (!id) throw new Error('avaliação sem identificador');
      if (!comentario) throw new Error('resposta vazia não é publicada');

      const dados = await chamar(`${raiz()}/reviews/${encodeURIComponent(id)}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ comment: comentario }),
      });

      return { publicada: true, atualizada_em: dados?.updateTime ?? null };
    },
  };
}

module.exports = { criarClienteAvaliacoesGoogle };
