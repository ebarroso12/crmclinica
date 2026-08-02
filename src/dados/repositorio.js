'use strict';

// Repositório do inbox. Todo SQL do produto mora aqui — nenhuma outra camada
// escreve consulta. A interface é a mesma do repositório em memória usado nos
// testes, de modo que rotas e domínio não sabem qual dos dois está por trás.
//
// Consultas sempre parametrizadas ($1, $2…): nada de concatenar valor em SQL.

const SELECAO_CONVERSA = `
  c.id, c.contato_id, c.canal, c.status, c.prioridade, c.atribuido_a,
  c.assumida_por_humano, c.ia_pausada_ate, c.ultima_msg_em, c.criado_em,
  ct.nome AS contato_nome, ct.telefone AS contato_telefone,
  ct.email AS contato_email, ct.identificador AS contato_identificador,
  u.nome AS responsavel_nome,
  l.temperatura, l.estagio
`;

const JUNCOES_CONVERSA = `
  FROM conversas c
  JOIN contatos ct ON ct.id = c.contato_id
  LEFT JOIN usuarios u ON u.id = c.atribuido_a
  LEFT JOIN leads l ON l.contato_id = c.contato_id
`;

// Prévia e etiquetas acompanham a conversa em **toda** consulta, não só na lista.
// Trazer só numa delas fazia `obterConversa` devolver uma forma diferente da que
// `listarConversas` devolve — divergência que a suíte de contrato pega.
const AGREGADOS_CONVERSA = `
  (SELECT m.conteudo FROM mensagens m
    WHERE m.conversa_id = c.id AND NOT m.privada
    ORDER BY m.criado_em DESC, m.id DESC LIMIT 1) AS previa,
  COALESCE((SELECT array_agg(e.nome ORDER BY e.nome)
    FROM conversa_etiquetas ce JOIN etiquetas e ON e.id = ce.etiqueta_id
    WHERE ce.conversa_id = c.id), '{}') AS etiquetas
`;

function montarConversa(linha) {
  if (!linha) return null;
  return {
    id: Number(linha.id),
    contato_id: Number(linha.contato_id),
    canal: linha.canal,
    status: linha.status,
    prioridade: linha.prioridade,
    atribuido_a: linha.atribuido_a ? Number(linha.atribuido_a) : null,
    responsavel_nome: linha.responsavel_nome || null,
    assumida_por_humano: linha.assumida_por_humano,
    ia_pausada_ate: linha.ia_pausada_ate,
    ultima_msg_em: linha.ultima_msg_em,
    criado_em: linha.criado_em,
    previa: linha.previa || null,
    temperatura: linha.temperatura || null,
    estagio: linha.estagio || null,
    etiquetas: linha.etiquetas || [],
    contato: {
      id: Number(linha.contato_id),
      nome: linha.contato_nome,
      telefone: linha.contato_telefone,
      email: linha.contato_email,
      identificador: linha.contato_identificador,
    },
  };
}

function montarMensagem(linha) {
  return {
    id: Number(linha.id),
    conversa_id: Number(linha.conversa_id),
    direcao: linha.direcao,
    tipo: linha.tipo,
    conteudo: linha.conteudo,
    media_url: linha.media_url,
    autor_tipo: linha.autor_tipo,
    autor_nome: linha.autor_nome,
    privada: linha.privada,
    criado_em: linha.criado_em,
  };
}

function criarRepositorio(pool) {
  const consultar = (texto, valores) => pool.query(texto, valores);

  return {
    tipo: 'postgres',

    async verificarSaude() {
      try {
        await consultar('SELECT 1');
        return { estado: 'operacional' };
      } catch {
        return { estado: 'indisponivel' };
      }
    },

    // ---------------------------------------------------------------- conversas

    /**
     * Lista conversas do inbox.
     * `previa` sai da última mensagem não privada — é o que a equipe lê na lista.
     */
    async listarConversas({ status = null, busca = null, contatoId = null, limite = 50 } = {}) {
      const condicoes = [];
      const valores = [];

      if (status) { valores.push(status); condicoes.push(`c.status = $${valores.length}`); }
      if (contatoId) { valores.push(contatoId); condicoes.push(`c.contato_id = $${valores.length}`); }
      if (busca) {
        valores.push(`%${busca}%`);
        condicoes.push(`(ct.nome ILIKE $${valores.length} OR ct.telefone ILIKE $${valores.length})`);
      }
      valores.push(limite);

      const { rows } = await consultar(`
        SELECT ${SELECAO_CONVERSA}, ${AGREGADOS_CONVERSA}
        ${JUNCOES_CONVERSA}
        ${condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : ''}
        ORDER BY c.ultima_msg_em DESC NULLS LAST, c.id DESC
        LIMIT $${valores.length}
      `, valores);

      return rows.map(montarConversa);
    },

    async obterConversa(id) {
      const { rows } = await consultar(`
        SELECT ${SELECAO_CONVERSA}, ${AGREGADOS_CONVERSA}
        ${JUNCOES_CONVERSA}
        WHERE c.id = $1
      `, [id]);

      return montarConversa(rows[0]);
    },

    async atualizarConversa(id, campos) {
      const permitidos = ['status', 'prioridade', 'atribuido_a', 'assumida_por_humano', 'ia_pausada_ate'];
      const partes = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        if (!permitidos.includes(campo)) continue;
        valores.push(valor);
        partes.push(`${campo} = $${valores.length}`);
      }
      if (partes.length === 0) return this.obterConversa(id);

      valores.push(id);
      await consultar(`UPDATE conversas SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterConversa(id);
    },

    // ---------------------------------------------------------------- mensagens

    async listarMensagens(conversaId, { incluirPrivadas = true } = {}) {
      const { rows } = await consultar(`
        SELECT * FROM mensagens
        WHERE conversa_id = $1 ${incluirPrivadas ? '' : 'AND NOT privada'}
        ORDER BY criado_em, id
      `, [conversaId]);

      return rows.map(montarMensagem);
    },

    /**
     * Grava a mensagem e move o relógio da conversa.
     * As duas coisas em uma transação: uma mensagem sem `ultima_msg_em` atualizado
     * some do topo da lista e a equipe não a vê.
     */
    async registrarMensagem(conversaId, mensagem) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');

        const { rows } = await cliente.query(`
          INSERT INTO mensagens (conversa_id, direcao, tipo, conteudo, media_url, autor_tipo, autor_nome, privada, id_externo)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id_externo) WHERE id_externo IS NOT NULL DO NOTHING
          RETURNING *
        `, [
          conversaId,
          mensagem.direcao,
          mensagem.tipo || 'texto',
          mensagem.conteudo || null,
          mensagem.media_url || null,
          mensagem.autor_tipo || 'contato',
          mensagem.autor_nome || null,
          Boolean(mensagem.privada),
          mensagem.id_externo || null,
        ]);

        // Sem linha devolvida, a mensagem já existia: reentrega do canal.
        if (rows.length === 0) {
          await cliente.query('ROLLBACK');
          const existente = await consultar('SELECT * FROM mensagens WHERE id_externo = $1', [mensagem.id_externo]);
          return { mensagem: montarMensagem(existente.rows[0]), duplicada: true };
        }

        // Nota interna não conta como atividade do atendimento.
        if (!mensagem.privada) {
          await cliente.query('UPDATE conversas SET ultima_msg_em = now() WHERE id = $1', [conversaId]);
        }

        await cliente.query('COMMIT');
        return { mensagem: montarMensagem(rows[0]), duplicada: false };
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    },

    // ---------------------------------------------------------------- contatos

    async obterContato(id) {
      const { rows } = await consultar('SELECT * FROM contatos WHERE id = $1', [id]);
      if (!rows[0]) return null;
      return {
        id: Number(rows[0].id),
        nome: rows[0].nome,
        telefone: rows[0].telefone,
        email: rows[0].email,
        identificador: rows[0].identificador,
        origem: rows[0].origem,
        atributos: rows[0].atributos || {},
        observacoes: rows[0].observacoes,
        criado_em: rows[0].criado_em,
      };
    },

    async atualizarContato(id, campos) {
      const permitidos = ['nome', 'telefone', 'email', 'identificador', 'observacoes', 'atributos'];
      const partes = [];
      const valores = [];

      for (const [campo, valor] of Object.entries(campos)) {
        if (!permitidos.includes(campo)) continue;
        valores.push(campo === 'atributos' ? JSON.stringify(valor) : valor);
        partes.push(`${campo} = $${valores.length}${campo === 'atributos' ? '::jsonb' : ''}`);
      }
      if (partes.length === 0) return this.obterContato(id);

      valores.push(id);
      await consultar(`UPDATE contatos SET ${partes.join(', ')} WHERE id = $${valores.length}`, valores);
      return this.obterContato(id);
    },

    /** Encontra pelo telefone ou cria. É como uma mensagem nova vira contato. */
    async encontrarOuCriarContato({ telefone, nome = null, canal = 'whatsapp', identificador = null }) {
      const { rows } = await consultar(`
        INSERT INTO contatos (telefone, nome, origem, identificador)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telefone) WHERE telefone IS NOT NULL
        DO UPDATE SET nome = COALESCE(contatos.nome, EXCLUDED.nome)
        RETURNING id
      `, [telefone, nome, canal, identificador]);

      return this.obterContato(rows[0].id);
    },

    /** Conversa aberta do contato, ou uma nova. Evita abrir uma conversa por mensagem. */
    async encontrarOuCriarConversaAberta(contatoId, canal = 'whatsapp') {
      const abertas = await consultar(`
        SELECT id FROM conversas
        WHERE contato_id = $1 AND status <> 'resolvida'
        ORDER BY criado_em DESC LIMIT 1
      `, [contatoId]);

      if (abertas.rows[0]) return this.obterConversa(abertas.rows[0].id);

      const { rows } = await consultar(
        'INSERT INTO conversas (contato_id, canal) VALUES ($1, $2) RETURNING id',
        [contatoId, canal],
      );
      return this.obterConversa(rows[0].id);
    },

    // ---------------------------------------------------------------- etiquetas

    async listarEtiquetas() {
      const { rows } = await consultar('SELECT id, nome, descricao, cor, do_sistema FROM etiquetas WHERE ativa ORDER BY nome');
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async listarEtiquetasDaConversa(conversaId) {
      const { rows } = await consultar(`
        SELECT e.nome FROM conversa_etiquetas ce
        JOIN etiquetas e ON e.id = ce.etiqueta_id
        WHERE ce.conversa_id = $1 ORDER BY e.nome
      `, [conversaId]);
      return rows.map((linha) => linha.nome);
    },

    /**
     * Substitui o conjunto de etiquetas da conversa pelo informado.
     * Nomes desconhecidos são ignorados — não se cria etiqueta por digitação errada.
     */
    async definirEtiquetasDaConversa(conversaId, nomes) {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query('DELETE FROM conversa_etiquetas WHERE conversa_id = $1', [conversaId]);

        if (nomes.length > 0) {
          await cliente.query(`
            INSERT INTO conversa_etiquetas (conversa_id, etiqueta_id)
            SELECT $1, id FROM etiquetas WHERE nome = ANY($2::text[])
            ON CONFLICT DO NOTHING
          `, [conversaId, nomes]);
        }

        await cliente.query('COMMIT');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }

      return this.listarEtiquetasDaConversa(conversaId);
    },

    // ---------------------------------------------------------------- notas

    async listarNotas(contatoId) {
      const { rows } = await consultar(`
        SELECT n.id, n.texto, n.criado_em, u.nome AS autor
        FROM notas_internas n LEFT JOIN usuarios u ON u.id = n.usuario_id
        WHERE n.contato_id = $1 ORDER BY n.criado_em DESC
      `, [contatoId]);
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async criarNota(contatoId, texto, usuarioId = null) {
      const { rows } = await consultar(`
        INSERT INTO notas_internas (contato_id, texto, usuario_id)
        VALUES ($1, $2, $3)
        RETURNING id, contato_id, texto, usuario_id, criado_em
      `, [contatoId, texto, usuarioId]);

      return { ...rows[0], id: Number(rows[0].id), contato_id: Number(rows[0].contato_id) };
    },

    // ---------------------------------------------------------------- leads

    async listarLeads() {
      const { rows } = await consultar(`
        SELECT l.id, l.contato_id, l.conversa_id, l.temperatura, l.estagio, l.origem, l.proximo_passo,
               ct.nome, ct.telefone
        FROM leads l JOIN contatos ct ON ct.id = l.contato_id
        ORDER BY l.atualizado_em DESC
      `);
      return rows.map((linha) => ({
        ...linha,
        id: Number(linha.id),
        contato_id: Number(linha.contato_id),
        conversa_id: linha.conversa_id ? Number(linha.conversa_id) : null,
      }));
    },

    /** Cria ou atualiza o lead do contato, mantendo o vínculo com a conversa. */
    async salvarLead(contatoId, { conversaId = null, temperatura = null, estagio = null, origem = null } = {}) {
      const { rows } = await consultar(`
        INSERT INTO leads (contato_id, conversa_id, temperatura, estagio, origem)
        VALUES ($1, $2, COALESCE($3, 'frio'), COALESCE($4, 'novo'), COALESCE($5, 'WHATSAPP'))
        ON CONFLICT (contato_id) DO UPDATE SET
          conversa_id = COALESCE(EXCLUDED.conversa_id, leads.conversa_id),
          temperatura = COALESCE($3, leads.temperatura),
          estagio     = COALESCE($4, leads.estagio),
          atualizado_em = now()
        RETURNING id, contato_id, conversa_id, temperatura, estagio, origem
      `, [contatoId, conversaId, temperatura, estagio, origem]);

      return { ...rows[0], id: Number(rows[0].id), contato_id: Number(rows[0].contato_id) };
    },

    // ---------------------------------------------------------------- idempotência e auditoria

    async consultarEvento(chave) {
      const { rows } = await consultar('SELECT recibo FROM eventos_recebidos WHERE chave = $1', [chave]);
      return rows[0]?.recibo ?? null;
    },

    async registrarEvento(chave, recibo) {
      const { rows } = await consultar(`
        INSERT INTO eventos_recebidos (chave, recibo) VALUES ($1, $2::jsonb)
        ON CONFLICT (chave) DO NOTHING
        RETURNING recibo
      `, [chave, JSON.stringify(recibo)]);

      // Sem linha devolvida, outra entrega ganhou a corrida: vale o recibo dela.
      if (rows.length === 0) return this.consultarEvento(chave);
      return rows[0].recibo;
    },

    async registrarAuditoria({ entidade, entidadeId, acao, detalhe = null, usuarioId = null }) {
      await consultar(
        'INSERT INTO audit_log (entidade, entidade_id, acao, detalhe, usuario_id) VALUES ($1, $2, $3, $4::jsonb, $5)',
        [entidade, entidadeId, acao, detalhe ? JSON.stringify(detalhe) : null, usuarioId],
      );
    },

    // ---------------------------------------------------------------- usuários e sessões

    async obterUsuarioPorEmail(email) {
      if (!email) return null;
      const { rows } = await consultar(
        'SELECT id, nome, email, senha_hash, papel, ativo FROM usuarios WHERE lower(email) = lower($1)',
        [email],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async obterUsuarioPorId(id) {
      const { rows } = await consultar(
        'SELECT id, nome, email, papel, ativo FROM usuarios WHERE id = $1',
        [id],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
    },

    async criarUsuario({ nome, email, senhaHash, papel = 'atendente' }) {
      const { rows } = await consultar(
        'INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ($1, $2, $3, $4) RETURNING id, nome, email, papel, ativo',
        [nome, email, senhaHash, papel],
      );
      return { ...rows[0], id: Number(rows[0].id) };
    },

    async listarUsuarios() {
      const { rows } = await consultar('SELECT id, nome, email, papel, ativo FROM usuarios ORDER BY nome');
      return rows.map((linha) => ({ ...linha, id: Number(linha.id) }));
    },

    async criarSessao({ usuarioId, hashRefresh, expiraEm, agente = null, ip = null }) {
      const { rows } = await consultar(
        'INSERT INTO sessoes (usuario_id, hash_refresh, expira_em, agente, ip) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [usuarioId, hashRefresh, expiraEm, agente, ip],
      );
      return { id: Number(rows[0].id) };
    },

    async obterSessaoPorHash(hashRefresh) {
      const { rows } = await consultar(
        'SELECT id, usuario_id, hash_refresh, expira_em, revogada_em FROM sessoes WHERE hash_refresh = $1',
        [hashRefresh],
      );
      return rows[0] ? { ...rows[0], id: Number(rows[0].id), usuario_id: Number(rows[0].usuario_id) } : null;
    },

    async revogarSessao(id) {
      await consultar('UPDATE sessoes SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL', [id]);
    },

    async revogarSessoesDoUsuario(usuarioId) {
      const { rowCount } = await consultar(
        'UPDATE sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL',
        [usuarioId],
      );
      return rowCount;
    },
  };
}

module.exports = { criarRepositorio };
