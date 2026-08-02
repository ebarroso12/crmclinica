'use strict';

const crypto = require('node:crypto');
const { FILAS, ETIQUETAS_TEMPERATURA } = require('../dominio/conversas');

// Integração isolada com a API oficial do Chatwoot (Application API v1).
//
// O Chatwoot é o inbox da equipe humana e continua sendo dono das conversas.
// O crmclinica não guarda cópia do histórico nem cria inbox paralelo: lê e escreve
// aqui, e só projeta o que precisa (contato, lead, temperatura) para o CRM.
//
// O token vive apenas no ambiente, e nunca sai daqui — não vai para o navegador,
// não entra em resposta de rota e não aparece em log.

/** Normaliza a conversa do Chatwoot para o vocabulário do crmclinica. */
function normalizarConversa(bruta = {}) {
  const meta = bruta.meta || {};
  const contato = meta.sender || bruta.contact || {};

  return {
    id: bruta.id,
    estado: bruta.status || null,
    prioridade: bruta.priority || null,
    canal: bruta.channel || meta.channel || null,
    tipoDeCanal: bruta.channel || meta.channel || null,
    inboxId: bruta.inbox_id ?? null,
    etiquetas: bruta.labels || [],
    naoLidas: bruta.unread_count ?? 0,
    ultimaAtividadeEm: bruta.last_activity_at ? new Date(bruta.last_activity_at * 1000).toISOString() : null,
    responsavel: meta.assignee
      ? { id: meta.assignee.id, nome: meta.assignee.name || meta.assignee.available_name || null }
      : null,
    time: meta.team ? { id: meta.team.id, nome: meta.team.name } : null,
    contato: {
      id: contato.id ?? null,
      nome: contato.name || null,
      telefone: contato.phone_number || null,
      email: contato.email || null,
      identificador: contato.identifier || null,
    },
    ultimaMensagem: bruta.messages?.[0]?.content || null,
  };
}

/** Normaliza uma mensagem da thread. */
function normalizarMensagem(bruta = {}) {
  // message_type: 0 = recebida do contato, 1 = enviada pela equipe, 2 = atividade do sistema.
  const tipos = { 0: 'contato', 1: 'equipe', 2: 'sistema' };

  return {
    id: bruta.id,
    texto: bruta.content || '',
    autor: tipos[bruta.message_type] ?? 'desconhecido',
    autorNome: bruta.sender?.name || null,
    privada: Boolean(bruta.private),
    criadaEm: bruta.created_at ? new Date(bruta.created_at * 1000).toISOString() : null,
    anexos: (bruta.attachments || []).length,
  };
}

function criarClienteChatwoot(configuracao = {}, dependencias = {}) {
  const requisicao = dependencias.fetch || globalThis.fetch;
  const { baseUrl, contaId, token, inboxId, timeId, tempoLimiteMs } = configuracao;

  const disponivel = Boolean(baseUrl && contaId && token);
  const raiz = disponivel ? `${baseUrl}/api/v1/accounts/${contaId}` : '';

  async function chamar(caminho, opcoes = {}) {
    if (!disponivel) {
      const erro = new Error('Integração com o Chatwoot não está configurada');
      erro.codigo = 'chatwoot_nao_configurado';
      throw erro;
    }

    const resposta = await requisicao(`${raiz}${caminho}`, {
      method: opcoes.method || 'GET',
      headers: {
        api_access_token: token,
        'content-type': 'application/json',
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      signal: AbortSignal.timeout(tempoLimiteMs || 10000),
    });

    if (!resposta.ok) {
      const erro = new Error(`Chatwoot respondeu HTTP ${resposta.status}`);
      erro.codigo = 'chatwoot_resposta_invalida';
      erro.status = resposta.status;
      throw erro;
    }

    // Algumas ações do Chatwoot respondem 200 com corpo vazio.
    const texto = await resposta.text();
    return texto ? JSON.parse(texto) : {};
  }

  return {
    disponivel,
    contaId: contaId || null,
    inboxId: inboxId || null,
    timeId: timeId || null,

    // ---------- Conversas ----------

    /** Lista as conversas de uma fila: Minhas, Não atribuídas ou Todos. */
    async listarConversas({ fila = 'nao_atribuidas', estado = 'open', pagina = 1 } = {}) {
      const definicao = FILAS[fila];
      if (!definicao) throw new Error(`fila desconhecida: ${fila}`);

      const parametros = new URLSearchParams({
        assignee_type: definicao.assignee_type,
        status: estado,
        page: String(pagina),
      });
      if (inboxId) parametros.set('inbox_id', inboxId);

      const dados = await chamar(`/conversations?${parametros}`);
      const lista = dados.data?.payload || dados.payload || [];

      return {
        fila,
        rotulo: definicao.rotulo,
        total: dados.data?.meta?.all_count ?? lista.length,
        conversas: lista.map(normalizarConversa),
      };
    },

    async obterConversa(conversaId) {
      return normalizarConversa(await chamar(`/conversations/${conversaId}`));
    },

    /** Thread de mensagens da conversa, em ordem cronológica. */
    async listarMensagens(conversaId) {
      const dados = await chamar(`/conversations/${conversaId}/messages`);
      return (dados.payload || []).map(normalizarMensagem);
    },

    /**
     * Envia uma mensagem para a conversa.
     * `privada: true` cria nota interna, que o paciente não vê.
     */
    async responder(conversaId, texto, { privada = false } = {}) {
      const bruta = await chamar(`/conversations/${conversaId}/messages`, {
        method: 'POST',
        corpo: { content: texto, message_type: 'outgoing', private: privada },
      });
      return normalizarMensagem(bruta);
    },

    // ---------- Ações da equipe ----------

    async atribuirAgente(conversaId, agenteId) {
      await chamar(`/conversations/${conversaId}/assignments`, {
        method: 'POST',
        corpo: { assignee_id: agenteId },
      });
      return { conversa_id: conversaId, responsavel_id: agenteId };
    },

    async atribuirTime(conversaId, time = timeId) {
      await chamar(`/conversations/${conversaId}/assignments`, {
        method: 'POST',
        corpo: { team_id: time },
      });
      return { conversa_id: conversaId, time_id: time };
    },

    async definirPrioridade(conversaId, prioridade) {
      await chamar(`/conversations/${conversaId}/toggle_priority`, {
        method: 'POST',
        corpo: { priority: prioridade },
      });
      return { conversa_id: conversaId, prioridade };
    },

    /** Muda o estado da conversa: resolver, reabrir (open) ou deixar pendente. */
    async definirEstado(conversaId, estado) {
      await chamar(`/conversations/${conversaId}/toggle_status`, {
        method: 'POST',
        corpo: { status: estado },
      });
      return { conversa_id: conversaId, estado };
    },

    // ---------- Etiquetas ----------

    async listarEtiquetasDaConversa(conversaId) {
      const dados = await chamar(`/conversations/${conversaId}/labels`);
      return dados.payload || [];
    },

    /**
     * Substitui o conjunto de etiquetas da conversa.
     * O Chatwoot não tem "adicionar uma": manda-se a lista inteira. Por isso
     * quem chama precisa partir das etiquetas atuais para não apagar as da equipe.
     */
    async definirEtiquetas(conversaId, etiquetas) {
      await chamar(`/conversations/${conversaId}/labels`, {
        method: 'POST',
        corpo: { labels: etiquetas },
      });
      return { conversa_id: conversaId, etiquetas };
    },

    /** Etiquetas cadastradas na conta. */
    async listarEtiquetasDaConta() {
      const dados = await chamar('/labels');
      return (dados.payload || []).map((etiqueta) => etiqueta.title);
    },

    async criarEtiqueta(titulo, { cor = '#1f93ff', descricao = '' } = {}) {
      return chamar('/labels', {
        method: 'POST',
        corpo: { title: titulo, description: descricao, color: cor, show_on_sidebar: true },
      });
    },

    /**
     * Garante que as três etiquetas de temperatura existam na conta,
     * sem tocar nas que a equipe já usa.
     */
    async garantirEtiquetasDeTemperatura() {
      const existentes = await this.listarEtiquetasDaConta();
      const criadas = [];

      for (const etiqueta of ETIQUETAS_TEMPERATURA) {
        if (existentes.includes(etiqueta)) continue;
        await this.criarEtiqueta(etiqueta, { descricao: 'Temperatura do lead — crmclinica' });
        criadas.push(etiqueta);
      }

      return { criadas, preservadas: existentes };
    },

    // ---------- Contato ----------

    async obterContato(contatoId) {
      const dados = await chamar(`/contacts/${contatoId}`);
      const contato = dados.payload || dados;
      return {
        id: contato.id,
        nome: contato.name || null,
        telefone: contato.phone_number || null,
        email: contato.email || null,
        identificador: contato.identifier || null,
        atributos: contato.custom_attributes || {},
        criadoEm: contato.created_at ? new Date(contato.created_at * 1000).toISOString() : null,
      };
    },

    /** Conversas anteriores do mesmo contato. */
    async listarConversasDoContato(contatoId) {
      const dados = await chamar(`/contacts/${contatoId}/conversations`);
      return (dados.payload || []).map(normalizarConversa);
    },

    async atualizarAtributos(contatoId, atributos) {
      await chamar(`/contacts/${contatoId}`, {
        method: 'PUT',
        corpo: { custom_attributes: atributos },
      });
      return { contato_id: contatoId, atributos };
    },

    async listarNotas(contatoId) {
      const dados = await chamar(`/contacts/${contatoId}/notes`);
      const notas = dados.payload || dados || [];
      return notas.map((nota) => ({
        id: nota.id,
        texto: nota.content,
        criadaEm: nota.created_at || null,
      }));
    },

    async criarNota(contatoId, texto) {
      return chamar(`/contacts/${contatoId}/notes`, { method: 'POST', corpo: { content: texto } });
    },

    // ---------- Saúde ----------

    async verificarSaude() {
      if (!disponivel) return { estado: 'nao_configurado' };
      try {
        await chamar('/labels');
        return { estado: 'operacional' };
      } catch (erro) {
        return { estado: erro.status ? 'degradado' : 'indisponivel' };
      }
    },
  };
}

/**
 * Confere a autenticidade de um webhook do Chatwoot.
 *
 * O Chatwoot não assina o corpo nativamente, então aceitamos duas formas, nesta ordem:
 *  1. HMAC-SHA256 sobre o corpo bruto (se o proxy à frente do Chatwoot adicionar);
 *  2. token compartilhado enviado no cabeçalho.
 * Ambas são comparadas em tempo constante.
 */
function webhookAutentico({ corpoBruto, assinaturaRecebida, tokenRecebido, segredo }) {
  if (!segredo) return false;

  if (assinaturaRecebida) {
    const esperada = crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex');
    const recebida = String(assinaturaRecebida).replace(/^sha256=/i, '').trim().toLowerCase();
    if (recebida.length === esperada.length
      && crypto.timingSafeEqual(Buffer.from(esperada, 'utf8'), Buffer.from(recebida, 'utf8'))) {
      return true;
    }
  }

  if (tokenRecebido) {
    const recebido = Buffer.from(String(tokenRecebido), 'utf8');
    const esperado = Buffer.from(segredo, 'utf8');
    if (recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  criarClienteChatwoot,
  webhookAutentico,
  normalizarConversa,
  normalizarMensagem,
};
